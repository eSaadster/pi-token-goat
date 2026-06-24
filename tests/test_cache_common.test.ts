/**
 * Unit tests for token_goat/cache_common. 1:1 port of
 * tests/test_cache_common.py.
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_path                       → fs.mkdtempSync under the OS tmp dir
 *    (the cache helpers take an explicit cache_dir_fn() so they do NOT route
 *    through dataDir(); the few tests that DO exercise a cache module's
 *    data_dir() wiring depend on not-yet-ported modules and are it.skip'd).
 *  - os.utime(p, (mtime, mtime))    → fs.utimesSync(p, mtime, mtime).
 *  - caplog.at_level(INFO, logger=) → vi.spyOn(console, "info"). util.ts's
 *    ConsoleLogger forwards _log.info(...) → console.info("[token_goat.<name>] "
 *    + msg, ...args); the eviction message threads log_name into the args, so a
 *    substring check on the joined call args matches caplog's record.message.
 *  - logging.getLogger(name)        → a tiny inline logger stub for safe_cache_op
 *    (the Python test passes its own logger; safe_cache_op only needs .warning).
 *  - @pytest.mark.parametrize       → it.each([...]).
 *
 * Skipped (depend on not-yet-ported Layer-2/3 modules):
 *  - every test that imports token_goat.bash_cache / web_cache / skill_cache to
 *    assert the cache wrappers delegate to these shared helpers. They are
 *    written as it.skip with a one-line PORT note and counted in tests_skipped.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OUTPUT_FILENAME_RE,
  build_keyed_output_id,
  build_output_id,
  evict_cache_dir,
  gz_companion_size,
  list_cache_outputs,
  load_blob_gz,
  load_output_meta_stat,
  load_sidecar_json,
  safe_cache_op,
  safe_session_fragment,
  short_content_hash,
  sidecar_path_for,
  store_blob_gz,
  truncate_tail_preserve,
} from "../src/token_goat/cache_common.js";

// ---------------------------------------------------------------------------
// Per-test tmp dir (Python tmp_path).
// ---------------------------------------------------------------------------
let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cc-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Helpers shared by TestEvictCacheDir (Python module-level helpers).
// ---------------------------------------------------------------------------

/** Return a zero-arg callable that returns *d* (already created). */
function _make_cache_dir_fn(d: string): () => string {
  fs.mkdirSync(d, { recursive: true });
  return () => d;
}

/** Write a .txt cache file and backdate its mtime (seconds). */
function _plant(d: string, name: string, content: Buffer, mtime: number): string {
  const p = path.join(d, name);
  fs.writeFileSync(p, content);
  fs.utimesSync(p, mtime, mtime);
  return p;
}

/** Write a .json sidecar alongside an existing .txt file. */
function _plant_sidecar(d: string, stem: string): string {
  const p = path.join(d, `${stem}.json`);
  fs.writeFileSync(p, "{}", "utf8");
  return p;
}

/** Build a valid OUTPUT_FILENAME_RE-matching filename stem. */
function _valid_name(tag: string): string {
  // Python: f"anon-0000000000{tag:0>3}-deadbeefcafe0000"
  const padded = tag.padStart(3, "0");
  return `anon-0000000000${padded}-deadbeefcafe0000`;
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function globTxt(d: string): string[] {
  return fs
    .readdirSync(d)
    .filter((n) => n.endsWith(".txt"))
    .map((n) => path.join(d, n));
}

// ===========================================================================
// TestOutputFilenameRE
// ===========================================================================
describe("TestOutputFilenameRE", () => {
  it.each([
    "anon-0000000000000-deadbeefcafe0000.txt",
    "abc-def_012-3456789012345-abcdef0123456789.txt",
    "a.txt",
    "A".repeat(80) + ".txt", // exactly 80 chars before .txt
    "abc-123_XYZ.txt",
  ])("test_valid_names_match: %s", (name) => {
    expect(OUTPUT_FILENAME_RE.test(name)).toBe(true);
  });

  it.each([
    "", // empty
    ".txt", // no stem
    "A".repeat(81) + ".txt", // 81 chars before .txt — over the limit
    "../etc/passwd.txt", // traversal attempt
    "foo/bar.txt", // path separator
    "has space.txt", // space
    "no_extension", // missing .txt
    "has.dot.in.middle.txt", // internal dot
    "nul\x00byte.txt", // null byte
  ])("test_invalid_names_do_not_match: %j", (name) => {
    expect(OUTPUT_FILENAME_RE.test(name)).toBe(false);
  });

  // PORT: deferred to Layer 2 (imports bash_cache / web_cache to check the
  // re-export identity).
  it.skip("test_both_cache_modules_import_the_same_object", () => {});
});

// ===========================================================================
// TestSafeSessionFragment
// ===========================================================================
describe("TestSafeSessionFragment", () => {
  it("test_clean_ascii_passthrough", () => {
    expect(safe_session_fragment("abc-123_XYZ")).toBe("abc-123_XYZ");
  });

  it("test_truncated_to_16_chars", () => {
    expect(safe_session_fragment("a".repeat(64))).toBe("a".repeat(16));
  });

  it("test_exactly_16_chars_unchanged", () => {
    const s = "abcdef01234-_xyz";
    expect(s.length).toBe(16);
    expect(safe_session_fragment(s)).toBe(s);
  });

  it("test_invalid_chars_replaced_with_underscore", () => {
    expect(safe_session_fragment("hello world!")).toBe("hello_world_");
  });

  it("test_empty_string_falls_back_to_anon", () => {
    expect(safe_session_fragment("")).toBe("anon");
  });

  it("test_all_invalid_chars_short_string_falls_back_to_anon", () => {
    expect(safe_session_fragment("!@#$")).toBe("____");
  });

  it("test_long_all_invalid_chars_truncated", () => {
    expect(safe_session_fragment("!".repeat(100))).toBe("_".repeat(16));
  });

  it("test_unicode_chars_replaced", () => {
    expect(safe_session_fragment("héllo-world")).toBe("h_llo-world");
  });

  it("test_output_only_contains_safe_chars", () => {
    const allowed = new Set(
      ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-").split(""),
    );
    for (const session_id of [
      "normal-session-id-123",
      "spaces and\ttabs",
      "slashes/in\\path",
      "unicode: 中文",
      "",
      "!".repeat(200),
    ]) {
      const result = safe_session_fragment(session_id);
      const bad = [...result].filter((c) => !allowed.has(c));
      expect(bad).toEqual([]);
    }
  });

  it("test_result_never_exceeds_16_chars", () => {
    for (const s of ["", "a", "a".repeat(16), "a".repeat(17), "a".repeat(1000), "!".repeat(1000)]) {
      expect(safe_session_fragment(s).length).toBeLessThanOrEqual(16);
    }
  });

  // PORT: deferred to Layer 2 (imports bash_cache.output_id_for).
  it.skip("test_matches_bash_cache_output_id_for_prefix", () => {});
  // PORT: deferred to Layer 2 (imports web_cache.output_id_for).
  it.skip("test_matches_web_cache_output_id_for_prefix", () => {});
});

// ===========================================================================
// TestLoadSidecarJson
// ===========================================================================
describe("TestLoadSidecarJson", () => {
  it("test_returns_dict_for_valid_file", () => {
    const p = path.join(tmpPath, "sidecar.json");
    fs.writeFileSync(p, JSON.stringify({ output_id: "abc", ts: 1.0 }), "utf8");
    const result = load_sidecar_json(p);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
    expect(result!["output_id"]).toBe("abc");
  });

  it("test_missing_file_returns_none", () => {
    const p = path.join(tmpPath, "nonexistent.json");
    expect(load_sidecar_json(p)).toBeNull();
  });

  it("test_malformed_json_returns_none", () => {
    const p = path.join(tmpPath, "bad.json");
    fs.writeFileSync(p, "not valid json {{{", "utf8");
    expect(load_sidecar_json(p)).toBeNull();
  });

  it("test_non_dict_top_level_array_returns_none", () => {
    const p = path.join(tmpPath, "array.json");
    fs.writeFileSync(p, JSON.stringify([1, 2, 3]), "utf8");
    expect(load_sidecar_json(p)).toBeNull();
  });

  it("test_non_dict_top_level_string_returns_none", () => {
    const p = path.join(tmpPath, "string.json");
    fs.writeFileSync(p, JSON.stringify("just a string"), "utf8");
    expect(load_sidecar_json(p)).toBeNull();
  });

  it("test_non_dict_top_level_null_returns_none", () => {
    const p = path.join(tmpPath, "null.json");
    fs.writeFileSync(p, "null", "utf8");
    expect(load_sidecar_json(p)).toBeNull();
  });

  it("test_non_dict_top_level_number_returns_none", () => {
    const p = path.join(tmpPath, "number.json");
    fs.writeFileSync(p, "42", "utf8");
    expect(load_sidecar_json(p)).toBeNull();
  });

  it("test_empty_dict_is_valid", () => {
    const p = path.join(tmpPath, "empty.json");
    fs.writeFileSync(p, "{}", "utf8");
    expect(load_sidecar_json(p)).toEqual({});
  });

  it("test_returns_same_dict_on_repeated_call", () => {
    const p = path.join(tmpPath, "repeat.json");
    const payload = { output_id: "xyz", ts: 9.9, truncated: false };
    fs.writeFileSync(p, JSON.stringify(payload), "utf8");
    const r1 = load_sidecar_json(p);
    const r2 = load_sidecar_json(p);
    expect(r1).toEqual(r2);
    expect(r1).toEqual(payload);
  });

  it("test_io_error_returns_none", () => {
    // monkeypatch Path.read_text → raise OSError for this file. The TS analogue
    // spies on fs.readFileSync to throw an ErrnoException for exactly this path.
    const p = path.join(tmpPath, "locked.json");
    fs.writeFileSync(p, "{}", "utf8");
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (file === p) {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (fs.readFileSync as unknown as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      expect(load_sidecar_json(p)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ===========================================================================
// TestEvictCacheDir
// ===========================================================================
describe("TestEvictCacheDir", () => {
  // ---- No-op cases ----

  it("test_noop_when_under_budget", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const name = _valid_name("001");
    _plant(d, `${name}.txt`, Buffer.from("X".repeat(100)), nowSeconds());
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1000 });
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(d, `${name}.txt`))).toBe(true);
  });

  it("test_noop_when_exactly_at_budget", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const name = _valid_name("001");
    _plant(d, `${name}.txt`, Buffer.from("X".repeat(100)), nowSeconds());
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 100 });
    expect(removed).toBe(0);
  });

  it("test_noop_on_empty_directory", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    expect(evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1 })).toBe(0);
  });

  it("test_noop_on_missing_directory", () => {
    const _fail = (): string => {
      const err = new Error("no such directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    expect(evict_cache_dir({ cache_dir_fn: _fail, log_name: "test_cache", max_total_bytes: 1 })).toBe(0);
  });

  // ---- Eviction threshold ----

  it("test_evicts_when_one_byte_over_budget", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const n1 = _valid_name("001");
    const n2 = _valid_name("002");
    _plant(d, `${n1}.txt`, Buffer.from("X".repeat(60)), t - 10); // older
    _plant(d, `${n2}.txt`, Buffer.from("X".repeat(60)), t); // newer
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 119 });
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it("test_stops_as_soon_as_budget_met", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const names = Array.from({ length: 5 }, (_, i) => _valid_name(String(i).padStart(3, "0")));
    names.forEach((name, i) => {
      _plant(d, `${name}.txt`, Buffer.from("X".repeat(100)), t - (5 - i));
    });
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 350 });
    expect(removed).toBe(2);
    expect(globTxt(d).length).toBe(3);
  });

  // ---- Oldest-first ordering ----

  it("test_oldest_deleted_first", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const base_t = nowSeconds();
    const names = Array.from({ length: 4 }, (_, i) => _valid_name(String(i).padStart(3, "0")));
    names.forEach((name, i) => {
      _plant(d, `${name}.txt`, Buffer.from("X".repeat(100)), base_t - (3 - i)); // names[0] oldest
    });
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 200 });
    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(d, `${names[0]}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(d, `${names[1]}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(d, `${names[2]}.txt`))).toBe(true);
    expect(fs.existsSync(path.join(d, `${names[3]}.txt`))).toBe(true);
  });

  // ---- Return value ----

  it("test_returns_correct_removed_count", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const names = Array.from({ length: 6 }, (_, i) => _valid_name(String(i).padStart(3, "0")));
    names.forEach((name, i) => {
      _plant(d, `${name}.txt`, Buffer.from("Y".repeat(100)), t - (6 - i));
    });
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 250 });
    expect(removed).toBe(4);
  });

  // ---- Symlink skipping ----

  it("test_symlinks_are_skipped", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const real_name = _valid_name("001");
    const real_file = _plant(d, `${real_name}.txt`, Buffer.from("Z".repeat(200)), t - 5);

    const link_name = _valid_name("002");
    const link = path.join(d, `${link_name}.txt`);
    try {
      fs.symlinkSync(real_file, link);
    } catch {
      // symlinks not supported on this platform → skip the body
      return;
    }

    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1 });
    const realExists = fs.existsSync(real_file);
    if (realExists) {
      expect(removed).toBe(0);
    } else {
      expect(removed).toBe(1);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  // ---- Paired sidecar removal ----

  it("test_sidecar_removed_with_body", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const names = Array.from({ length: 3 }, (_, i) => _valid_name(String(i).padStart(3, "0")));
    names.forEach((name, i) => {
      _plant(d, `${name}.txt`, Buffer.from("X".repeat(100)), t - (3 - i));
      _plant_sidecar(d, name);
    });

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 100 });

    for (const name of names.slice(0, 2)) {
      expect(fs.existsSync(path.join(d, `${name}.txt`))).toBe(false);
      expect(fs.existsSync(path.join(d, `${name}.json`))).toBe(false);
    }
    expect(fs.existsSync(path.join(d, `${names[2]}.txt`))).toBe(true);
    expect(fs.existsSync(path.join(d, `${names[2]}.json`))).toBe(true);
  });

  it("test_surviving_sidecars_are_untouched", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const old_name = _valid_name("001");
    const new_name = _valid_name("002");
    _plant(d, `${old_name}.txt`, Buffer.from("X".repeat(100)), t - 10);
    _plant_sidecar(d, old_name);
    _plant(d, `${new_name}.txt`, Buffer.from("X".repeat(100)), t);
    _plant_sidecar(d, new_name);

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 100 });

    expect(fs.existsSync(path.join(d, `${old_name}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(d, `${old_name}.json`))).toBe(false);
    expect(fs.existsSync(path.join(d, `${new_name}.txt`))).toBe(true);
    expect(fs.existsSync(path.join(d, `${new_name}.json`))).toBe(true);
  });

  // ---- Orphan sidecar sweep ----

  it("test_orphan_sidecar_swept_when_body_absent", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const real_name = _valid_name("001");
    _plant(d, `${real_name}.txt`, Buffer.from("X".repeat(10)), t);

    const orphan_stem = _valid_name("002");
    const orphan = path.join(d, `${orphan_stem}.json`);
    fs.writeFileSync(orphan, "{}", "utf8");
    expect(fs.existsSync(orphan)).toBe(true);

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1 });
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("test_orphan_sweep_runs_during_eviction_pass", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const real_name = _valid_name("001");
    _plant(d, `${real_name}.txt`, Buffer.from("X".repeat(200)), t);
    const orphan_stem = _valid_name("002");
    const orphan = path.join(d, `${orphan_stem}.json`);
    fs.writeFileSync(orphan, "{}", "utf8");

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1 });
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("test_orphan_sweep_runs_even_when_caps_satisfied", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const real_name = _valid_name("001");
    _plant(d, `${real_name}.txt`, Buffer.from("X".repeat(10)), t);
    const orphan_stem = _valid_name("002");
    const orphan = path.join(d, `${orphan_stem}.json`);
    fs.writeFileSync(orphan, "{}", "utf8");

    const removed = evict_cache_dir({
      cache_dir_fn: fn,
      log_name: "test_cache",
      max_total_bytes: 10_000,
      max_file_count: 4096,
    });
    expect(removed).toBe(0);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("test_unrelated_json_not_deleted_by_sweep", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const real_name = _valid_name("001");
    _plant(d, `${real_name}.txt`, Buffer.from("X".repeat(10)), t);

    const unrelated = path.join(d, "user.config.json");
    fs.writeFileSync(unrelated, '{"setting": "value"}', "utf8");

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 10_000, max_file_count: 4096 });
    expect(fs.existsSync(unrelated)).toBe(true);

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1 });
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("test_invalid_named_json_with_path_separator_not_deleted", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const real_name = _valid_name("001");
    _plant(d, `${real_name}.txt`, Buffer.from("X".repeat(10)), t);

    const rogue = path.join(d, "rogue file.json");
    fs.writeFileSync(rogue, "{}", "utf8");

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 10_000, max_file_count: 4096 });
    expect(fs.existsSync(rogue)).toBe(true);
  });

  // ---- Compressed (.gz) companion bodies ----

  it("test_gz_body_counts_toward_byte_budget", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const name = _valid_name("001");
    _plant(d, `${name}.txt`, Buffer.from(""), t);
    const gz = path.join(d, `${name}.gz`);
    fs.writeFileSync(gz, Buffer.from("Z".repeat(200)));
    fs.utimesSync(gz, t, t);

    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 150 });
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(d, `${name}.txt`))).toBe(false);
    expect(fs.existsSync(gz)).toBe(false);
  });

  it("test_gz_body_removed_with_owning_stub", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const old = _valid_name("001");
    const newName = _valid_name("002");
    _plant(d, `${old}.txt`, Buffer.from(""), t - 100);
    const old_gz = path.join(d, `${old}.gz`);
    fs.writeFileSync(old_gz, Buffer.from("Z".repeat(120)));
    fs.utimesSync(old_gz, t - 100, t - 100);
    _plant(d, `${newName}.txt`, Buffer.from("X".repeat(50)), t);

    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 100 });
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(d, `${old}.txt`))).toBe(false);
    expect(fs.existsSync(old_gz)).toBe(false);
    expect(fs.existsSync(path.join(d, `${newName}.txt`))).toBe(true);
  });

  it("test_orphan_gz_swept_when_stub_absent", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const keep = _valid_name("001");
    _plant(d, `${keep}.txt`, Buffer.from("X".repeat(10)), t);
    const orphan = path.join(d, `${_valid_name("002")}.gz`);
    fs.writeFileSync(orphan, Buffer.from("Z".repeat(64)));

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 10_000, max_file_count: 4096 });
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(d, `${keep}.txt`))).toBe(true);
  });

  it("test_unrelated_gz_not_deleted_by_sweep", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const real_name = _valid_name("001");
    _plant(d, `${real_name}.txt`, Buffer.from("X".repeat(10)), t);
    const unrelated = path.join(d, "user.backup.gz");
    fs.writeFileSync(unrelated, Buffer.from([0x1f, 0x8b, 0x08]));

    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 10_000, max_file_count: 4096 });
    expect(fs.existsSync(unrelated)).toBe(true);
    evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1 });
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("test_store_blob_gz_entry_evicted_end_to_end", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const output_id = _valid_name("001");
    const gz_path = store_blob_gz(output_id, "x".repeat(5000), fn, "test_cache");
    expect(gz_path).not.toBeNull();
    expect(fs.existsSync(gz_path!)).toBe(true);
    expect(fs.existsSync(path.join(d, `${output_id}.txt`))).toBe(true);

    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 1 });
    expect(removed).toBe(1);
    expect(fs.existsSync(gz_path!)).toBe(false);
    expect(fs.existsSync(path.join(d, `${output_id}.txt`))).toBe(false);
  });

  // ---- Non-.txt files are ignored ----

  it("test_non_txt_files_ignored_in_scan", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const big_log = path.join(d, "some.log");
    fs.writeFileSync(big_log, Buffer.from("Z".repeat(10_000)));

    const real_name = _valid_name("001");
    _plant(d, `${real_name}.txt`, Buffer.from("X".repeat(50)), t);

    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 100 });
    expect(removed).toBe(0);
    expect(fs.existsSync(big_log)).toBe(true);
  });

  // ---- log_name is threaded through to log records ----

  it("test_log_name_used_in_eviction_message", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    const name = _valid_name("001");
    _plant(d, `${name}.txt`, Buffer.from("X".repeat(100)), t);

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    // The INFO eviction record threads log_name into the args. Join every call's
    // args into one string and assert the substring is present. Capture the calls
    // BEFORE mockRestore() — restoring resets the spy's recorded mock.calls.
    let joined = "";
    try {
      evict_cache_dir({ cache_dir_fn: fn, log_name: "my_test_cache", max_total_bytes: 1 });
      joined = infoSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    } finally {
      infoSpy.mockRestore();
    }
    expect(joined).toContain("my_test_cache");
  });

  // ---- bash_cache / web_cache wrappers ----

  // PORT: deferred to Layer 2 (bash_cache.DEFAULT_MAX_TOTAL_BYTES).
  it.skip("test_bash_cache_default_cap_is_16mb", () => {});
  // PORT: deferred to Layer 2 (web_cache.DEFAULT_MAX_TOTAL_BYTES).
  it.skip("test_web_cache_default_cap_is_32mb", () => {});
  // PORT: deferred to Layer 2 (bash_cache.evict_old_entries).
  it.skip("test_bash_cache_evict_delegates_to_shared_helper", () => {});
  // PORT: deferred to Layer 2 (web_cache.evict_old_entries).
  it.skip("test_web_cache_evict_delegates_to_shared_helper", () => {});
});

// ===========================================================================
// TestEvictCacheDirFileCount
// ===========================================================================
describe("TestEvictCacheDirFileCount", () => {
  it("test_noop_when_under_both_caps", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    for (let i = 0; i < 3; i++) {
      const name = _valid_name(String(i).padStart(3, "0"));
      _plant(d, `${name}.txt`, Buffer.from("X".repeat(10)), t + i);
    }
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 10_000, max_file_count: 10 });
    expect(removed).toBe(0);
    expect(globTxt(d).length).toBe(3);
  });

  it("test_evicts_when_file_count_exceeded_but_bytes_ok", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    for (let i = 0; i < 5; i++) {
      const name = _valid_name(String(i).padStart(3, "0"));
      _plant(d, `${name}.txt`, Buffer.from("X".repeat(5)), t + i);
    }
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 10_000, max_file_count: 3 });
    expect(removed).toBe(2);
    expect(globTxt(d).length).toBe(3);
  });

  it("test_evicts_when_both_caps_exceeded", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    for (let i = 0; i < 6; i++) {
      const name = _valid_name(String(i).padStart(3, "0"));
      _plant(d, `${name}.txt`, Buffer.from("X".repeat(100)), t + i);
    }
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 250, max_file_count: 3 });
    expect(removed).toBe(4);
    expect(globTxt(d).length).toBe(2);
  });

  it("test_count_noop_when_exactly_at_cap", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const t = nowSeconds();
    for (let i = 0; i < 4; i++) {
      const name = _valid_name(String(i).padStart(3, "0"));
      _plant(d, `${name}.txt`, Buffer.from("X".repeat(5)), t + i);
    }
    const removed = evict_cache_dir({ cache_dir_fn: fn, log_name: "test_cache", max_total_bytes: 10_000, max_file_count: 4 });
    expect(removed).toBe(0);
  });

  // PORT: deferred to Layer 2 (bash_cache.evict_old_entries file-count cap).
  it.skip("test_bash_cache_file_count_cap_applied", () => {});
});

// ===========================================================================
// TestTruncateTailPreserve
// ===========================================================================
describe("TestTruncateTailPreserve", () => {
  const _MARKER = "[truncated; kept {n} of {total} bytes]\n";

  it("test_under_limit_returns_content_unchanged", () => {
    const content = "hello world";
    const [stored, truncated] = truncate_tail_preserve(content, 100, { marker_template: _MARKER });
    expect(stored).toBe(content);
    expect(truncated).toBe(false);
  });

  it("test_exactly_at_limit_returns_unchanged", () => {
    const content = "x".repeat(50);
    const [stored, truncated] = truncate_tail_preserve(content, 50, { marker_template: _MARKER });
    expect(stored).toBe(content);
    expect(truncated).toBe(false);
  });

  it("test_over_limit_keeps_tail_and_prepends_marker", () => {
    const content = "first chunk\n" + "y".repeat(200);
    const [stored, truncated] = truncate_tail_preserve(content, 50, { marker_template: _MARKER });
    expect(truncated).toBe(true);
    expect(stored).toContain("[truncated; kept 50 of ");
    expect(stored.endsWith("y".repeat(50))).toBe(true);
    expect(stored).not.toContain("first chunk");
  });

  it("test_byte_length_counts_utf8", () => {
    // Each "é" is 2 bytes in utf-8; 40 codepoints * 2 = 80 bytes.
    const content = "é".repeat(40);
    const [stored, truncated] = truncate_tail_preserve(content, 50, { marker_template: _MARKER });
    expect(truncated).toBe(true);
    expect(stored).toContain("of 80 bytes");
  });

  it("test_marker_template_formats_with_n_and_total", () => {
    const content = "z".repeat(100);
    const [stored] = truncate_tail_preserve(content, 20, { marker_template: "MARK n={n} total={total}\n" });
    expect(stored.startsWith("MARK n=20 total=100\n")).toBe(true);
  });

  it("test_utf8_kept_bytes_at_or_under_cap", () => {
    const content = "中".repeat(200); // 600 bytes
    const [stored, truncated] = truncate_tail_preserve(content, 60, { marker_template: "[t {n}/{total}]\n" });
    expect(truncated).toBe(true);
    const marker_end = stored.indexOf("]\n") + 2;
    const kept_only = stored.slice(marker_end);
    const kept_bytes = Buffer.from(kept_only, "utf8").length;
    expect(kept_bytes).toBeLessThanOrEqual(60);
  });

  it("test_utf8_4byte_emoji_kept_bytes_at_or_under_cap", () => {
    const content = "\u{1f4a9}".repeat(50); // 200 bytes
    const [stored, truncated] = truncate_tail_preserve(content, 20, { marker_template: "[t {n}/{total}]\n" });
    expect(truncated).toBe(true);
    const marker_end = stored.indexOf("]\n") + 2;
    const kept_only = stored.slice(marker_end);
    const kept_bytes = Buffer.from(kept_only, "utf8").length;
    expect(kept_bytes).toBeLessThanOrEqual(20);
  });

  it("test_utf8_partial_codepoint_handled_with_replacement", () => {
    const content = "中".repeat(30); // 90 bytes; cap 50 forces a mid-codepoint cut
    const [stored, truncated] = truncate_tail_preserve(content, 50, { marker_template: "[t {n}/{total}]\n" });
    expect(truncated).toBe(true);
    const marker_end = stored.indexOf("]\n") + 2;
    const kept_only = stored.slice(marker_end);
    const encoded = Buffer.from(kept_only, "utf8");
    const re_decoded = encoded.toString("utf8");
    expect(kept_only).toBe(re_decoded);
  });
});

// ===========================================================================
// TestShortContentHash
// ===========================================================================
describe("TestShortContentHash", () => {
  it("test_returns_16_hex_chars", () => {
    const result = short_content_hash("hello world");
    expect(result.length).toBe(16);
    expect([...result].every((c) => "0123456789abcdef".includes(c))).toBe(true);
  });

  it("test_deterministic", () => {
    expect(short_content_hash("echo hi")).toBe(short_content_hash("echo hi"));
  });

  it("test_distinct_inputs_produce_distinct_hashes", () => {
    expect(short_content_hash("cmd_a")).not.toBe(short_content_hash("cmd_b"));
  });

  it("test_empty_string", () => {
    expect(short_content_hash("").length).toBe(16);
  });

  it("test_unicode_does_not_raise", () => {
    const result = short_content_hash("héllo 中文 \x00\xff");
    expect(result.length).toBe(16);
  });

  // PORT: deferred to Layer 2 (bash_cache.command_hash).
  it.skip("test_matches_bash_cache_command_hash", () => {});
  // PORT: deferred to Layer 2 (web_cache.url_hash).
  it.skip("test_matches_web_cache_url_hash", () => {});
  // PORT: deferred to Layer 3 (skill_cache.content_hash).
  it.skip("test_matches_skill_cache_content_hash", () => {});
});

// ===========================================================================
// TestBuildOutputId
// ===========================================================================
describe("TestBuildOutputId", () => {
  it("test_format_structure", () => {
    const result = build_output_id("mysessionid", "deadbeef01234567", 1_000.0);
    const parts = result.split("-");
    expect(parts.length).toBe(3);
    const [session_part, ms_part, token_part] = parts as [string, string, string];
    expect(session_part).toBe("mysessionid");
    expect(ms_part).toBe(String(1_000_000).padStart(13, "0"));
    expect(token_part).toBe("deadbeef01234567");
  });

  it("test_session_fragment_is_prefix", () => {
    const result = build_output_id("abc-def-ghi-extra-long", "token123", 0.0);
    const frag = safe_session_fragment("abc-def-ghi-extra-long");
    expect(result.startsWith(frag + "-")).toBe(true);
  });

  it("test_uses_current_time_when_ts_is_none", () => {
    const before = Math.trunc(Date.now());
    const result = build_output_id("sess", "tok");
    const after = Math.trunc(Date.now());
    const parts = result.split("-");
    const ms_val = Number(parts[1]);
    expect(ms_val).toBeGreaterThanOrEqual(before);
    expect(ms_val).toBeLessThanOrEqual(after);
  });

  it("test_two_calls_with_same_ts_produce_same_id", () => {
    const a = build_output_id("sess", "tok", 12345.678);
    const b = build_output_id("sess", "tok", 12345.678);
    expect(a).toBe(b);
  });

  it("test_different_ts_produces_different_id", () => {
    const a = build_output_id("sess", "tok", 1.0);
    const b = build_output_id("sess", "tok", 2.0);
    expect(a).not.toBe(b);
  });

  it("test_result_matches_output_filename_re", () => {
    const result = build_output_id("my-session", short_content_hash("cmd"), 42.0);
    expect(OUTPUT_FILENAME_RE.test(result + ".txt")).toBe(true);
  });

  // PORT: deferred to Layer 2 (bash_cache.output_id_for).
  it.skip("test_matches_bash_cache_output_id_for_structure", () => {});
  // PORT: deferred to Layer 2 (web_cache.output_id_for).
  it.skip("test_matches_web_cache_output_id_for_structure", () => {});
});

// ===========================================================================
// TestBuildKeyedOutputId
// ===========================================================================
describe("TestBuildKeyedOutputId", () => {
  it("test_basic_format", () => {
    const result = build_keyed_output_id("glob_", "sess", "deadbeef01234567");
    expect(result).toBe("glob_sess-deadbeef01234567");
  });

  it("test_same_inputs_produce_same_id", () => {
    const a = build_keyed_output_id("glob_", "mysession", "deadbeef01234567");
    const b = build_keyed_output_id("glob_", "mysession", "deadbeef01234567");
    expect(a).toBe(b);
  });

  it("test_different_tokens_produce_different_ids", () => {
    const a = build_keyed_output_id("glob_", "sess", "aaaaaaaaaaaaaaaa");
    const b = build_keyed_output_id("glob_", "sess", "bbbbbbbbbbbbbbbb");
    expect(a).not.toBe(b);
  });

  it("test_session_fragment_is_safe", () => {
    const result = build_keyed_output_id("glob_", "hello world!", "tok");
    expect(result).toBe("glob_hello_world_-tok");
  });

  it("test_result_matches_output_filename_re", () => {
    const result = build_keyed_output_id("glob_", "session-id-123", "abcdef0123456789");
    expect(OUTPUT_FILENAME_RE.test(result + ".txt")).toBe(true);
  });

  // PORT: deferred to Layer 2 (bash_cache.store_glob_result).
  it.skip("test_used_by_bash_store_glob_result", () => {});
  // PORT: deferred to Layer 2 (bash_cache.store_glob_result collision).
  it.skip("test_two_stores_of_same_glob_collide", () => {});
});

// ===========================================================================
// TestOutputStatDict
// ===========================================================================
describe("TestOutputStatDict", () => {
  // PORT: OutputStatDict is a type-only export in TS (erased at runtime); the
  // Python tests assert object identity of a runtime TypedDict and module
  // annotations. Deferred — no runtime symbol to assert on, and the cache
  // modules that re-export it are not yet ported.
  it.skip("test_importable_from_cache_common", () => {});
  it.skip("test_bash_cache_uses_cache_common_type", () => {});
  it.skip("test_web_cache_uses_cache_common_type", () => {});
  it.skip("test_skill_cache_uses_cache_common_type", () => {});
  it.skip("test_no_local_outputstatdict_in_cache_modules", () => {});
});

// ===========================================================================
// TestGetCacheDir
// ===========================================================================
describe("TestGetCacheDir", () => {
  // PORT: deferred to Layer 2 — get_cache_dir routes through paths.dataDir();
  // the per-test data-dir seam works, but the companion assertions about the
  // three cache modules' _*_dir() functions need those modules. The pure
  // get_cache_dir behaviour is exercised end-to-end by store_blob_gz tests.
  it.skip("test_creates_subdir_under_data_dir", () => {});
  it.skip("test_idempotent_when_dir_exists", () => {});
  it.skip("test_each_cache_module_uses_get_cache_dir", () => {});
  it.skip("test_no_raw_mkdir_in_web_cache", () => {});
});

// ===========================================================================
// TestSidecarPathFor
// ===========================================================================
describe("TestSidecarPathFor", () => {
  it("test_replaces_txt_with_json", () => {
    const body = path.join(tmpPath, "abc-0000000000000-deadbeef.txt");
    expect(sidecar_path_for(body)).toBe(path.join(tmpPath, "abc-0000000000000-deadbeef.json"));
  });

  it("test_works_on_path_without_existing_file", () => {
    const body = path.join(tmpPath, "anon-9999999999999-cafebabe0000cafe.txt");
    const result = sidecar_path_for(body);
    expect(result.endsWith(".json")).toBe(true);
    // stem (basename without final suffix) must match the body's stem.
    expect(path.basename(result, ".json")).toBe(path.basename(body, ".txt"));
  });

  // PORT: deferred to Layer 2 (bash_cache / web_cache sidecar_meta_path).
  it.skip("test_each_cache_sidecar_meta_path_uses_sidecar_path_for", () => {});
});

// ===========================================================================
// TestSafeCacheOp
// ===========================================================================
describe("TestSafeCacheOp", () => {
  function makeLog() {
    return { warning: (_msg: string, ..._args: unknown[]): void => {} };
  }

  it("test_no_exception_passes_through", () => {
    const result: number[] = [];
    safe_cache_op("test_op", { log: makeLog() }, () => {
      result.push(42);
    });
    expect(result).toEqual([42]);
  });

  it("test_oserror_suppressed", () => {
    const ran: string[] = [];
    safe_cache_op("test_op", { log: makeLog() }, () => {
      const err = new Error("disk full") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    });
    ran.push("after_with");
    expect(ran).toEqual(["after_with"]);
  });

  it("test_oserror_subclass_suppressed", () => {
    safe_cache_op("test_op", { log: makeLog() }, () => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  });

  it("test_non_oserror_propagates", () => {
    expect(() =>
      safe_cache_op("test_op", { log: makeLog() }, () => {
        throw new Error("bad value");
      }),
    ).toThrow("bad value");
  });

  it("test_oserror_logs_warning", () => {
    const calls: string[] = [];
    const log = {
      warning: (msg: string, ...args: unknown[]): void => {
        calls.push([msg, ...args.map(String)].join(" "));
      },
    };
    safe_cache_op("my_op", { log }, () => {
      const err = new Error("disk full") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    });
    expect(calls.some((c) => c.includes("my_op"))).toBe(true);
  });

  it("test_return_value_pattern", () => {
    const _store = (fail: boolean): number | null => {
      const r = safe_cache_op("store", { log: makeLog() }, () => {
        if (fail) {
          const err = new Error("disk full") as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          throw err;
        }
        return 42;
      });
      return r !== undefined ? r : null;
    };
    expect(_store(false)).toBe(42);
    expect(_store(true)).toBeNull();
  });
});

// ===========================================================================
// TestStoreBlobGz
// ===========================================================================
describe("TestStoreBlobGz", () => {
  it("test_roundtrip", () => {
    const dir_fn = (): string => tmpPath;
    const body = "Hello, world!\nLine two.\n";
    const result = store_blob_gz("test-id-0001", body, dir_fn, "test_cache");
    expect(result).not.toBeNull();
    expect(result!.endsWith(".gz")).toBe(true);
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.existsSync(path.join(tmpPath, "test-id-0001.txt"))).toBe(true);
    expect(load_blob_gz("test-id-0001", dir_fn, "test_cache")).toBe(body);
  });

  it("test_missing_returns_none", () => {
    const dir_fn = (): string => tmpPath;
    expect(load_blob_gz("nonexistent-id", dir_fn, "test_cache")).toBeNull();
  });

  it("test_unicode_roundtrip", () => {
    const dir_fn = (): string => tmpPath;
    const body = "Skill: émoji \u{1f410} content\nLine 2\n";
    store_blob_gz("uni-id-0001", body, dir_fn, "test_cache");
    expect(load_blob_gz("uni-id-0001", dir_fn, "test_cache")).toBe(body);
  });

  it("test_corrupt_gz_returns_none", () => {
    const dir_fn = (): string => tmpPath;
    const gz_path = path.join(tmpPath, "bad-id-0001.gz");
    fs.writeFileSync(gz_path, Buffer.from("not valid gzip data"));
    expect(load_blob_gz("bad-id-0001", dir_fn, "test_cache")).toBeNull();
  });
});

// ===========================================================================
// TestGzCompanionSizeAccounting
// ===========================================================================
describe("TestGzCompanionSizeAccounting", () => {
  it("test_gz_companion_size_returns_sibling_bytes", () => {
    const name = _valid_name("001");
    const txt = _plant(tmpPath, `${name}.txt`, Buffer.from(""), nowSeconds());
    fs.writeFileSync(path.join(tmpPath, `${name}.gz`), Buffer.from("Z".repeat(321)));
    expect(gz_companion_size(txt)).toBe(321);
  });

  it("test_gz_companion_size_zero_when_no_sibling", () => {
    const name = _valid_name("001");
    const txt = _plant(tmpPath, `${name}.txt`, Buffer.from("X".repeat(40)), nowSeconds());
    expect(gz_companion_size(txt)).toBe(0);
  });

  it("test_load_output_meta_stat_includes_gz_size", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const name = _valid_name("001");
    _plant(d, `${name}.txt`, Buffer.from(""), nowSeconds());
    fs.writeFileSync(path.join(d, `${name}.gz`), Buffer.from("Z".repeat(500)));

    const meta = load_output_meta_stat(name, fn, "test_cache");
    expect(meta).not.toBeNull();
    expect(meta!.size_bytes).toBe(500);
  });

  it("test_list_cache_outputs_includes_gz_size", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const name = _valid_name("001");
    _plant(d, `${name}.txt`, Buffer.from(""), nowSeconds());
    fs.writeFileSync(path.join(d, `${name}.gz`), Buffer.from("Z".repeat(750)));

    const rows = list_cache_outputs(fn);
    expect(rows.length).toBe(1);
    expect(rows[0]!.output_id).toBe(name);
    expect(rows[0]!.size_bytes).toBe(750);
  });

  it("test_uncompressed_entry_size_unchanged", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const name = _valid_name("001");
    _plant(d, `${name}.txt`, Buffer.from("X".repeat(123)), nowSeconds());

    const meta = load_output_meta_stat(name, fn, "test_cache");
    expect(meta).not.toBeNull();
    expect(meta!.size_bytes).toBe(123);
    const rows = list_cache_outputs(fn);
    expect(rows[0]!.size_bytes).toBe(123);
  });

  it("test_real_store_blob_gz_entry_reports_compressed_size", () => {
    const d = path.join(tmpPath, "cache");
    const fn = _make_cache_dir_fn(d);
    const name = _valid_name("001");
    const gz_path = store_blob_gz(name, "x".repeat(5000), fn, "test_cache");
    expect(gz_path).not.toBeNull();
    expect(fs.existsSync(gz_path!)).toBe(true);
    const on_disk = fs.statSync(gz_path!).size;

    const meta = load_output_meta_stat(name, fn, "test_cache");
    expect(meta).not.toBeNull();
    expect(meta!.size_bytes).toBe(on_disk);
    expect(meta!.size_bytes).toBeGreaterThan(0);
    const rows = list_cache_outputs(fn);
    expect(rows[0]!.size_bytes).toBe(on_disk);
  });
});
