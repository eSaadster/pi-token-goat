/**
 * Faithful TS port of tests/test_skill_iter6_improvements.py.
 *
 * Covers:
 * 1. skill_size accuracy — get_all_cached_skills returns compact_chars / body_chars;
 *    _strip_compact_header removes the metadata header line.
 * 2. db.list_all_project_hashes returns all registered project hashes.
 * 3. Diff-aware re-read — hooks_read._handle_skill_file_read bypasses the hint
 *    when the on-disk skill file SHA differs from the cached content_sha.
 *
 * Porting notes:
 *  - tmp_data_dir fixture -> handled by tests/setup.ts (per-test tmp data dir).
 *  - _strip_compact_header is module-private in skill_cache.ts (NOT exported).
 *    TestStripCompactHeader is DEFERRED with a missing-export note.
 *  - _db_mod.open_global() context manager -> db.openGlobal((conn) => {...}).
 *  - monkeypatch.setattr(_paths, "data_dir", ...) -> setDataDirOverride().
 *  - project_hash(fake_root: Path) -> project_hash(canonicalize(fake_root)).
 *  - MagicMock() cache -> a plain object with skill_history / has_hint_fingerprint
 *    / mark_hint_seen (the only attrs _handle_skill_file_read reads).
 *  - mock.patch.object(_hr, "_detect_skill_name_from_path", ...) ->
 *    vi.spyOn(hooks_read, "_detect_skill_name_from_path") (the impl routes
 *    internal calls through `self`, so the spy is observed).
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as _db_mod from "../src/token_goat/db.js";
import * as paths from "../src/token_goat/paths.js";
import { project_hash, canonicalize } from "../src/token_goat/project.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import { setDataDirOverride } from "../src/token_goat/reset.js";
import { SkillEntry } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Improvement 1: skill-size accuracy — strip compact header, use chars
// ---------------------------------------------------------------------------

describe("TestStripCompactHeader", () => {
  // _strip_compact_header is a module-private function in skill_cache.ts (not
  // exported). DEFERRED with a missing-export note. The behaviour is still
  // exercised transitively by get_all_cached_skills (compact_chars) below.
  it.skip("test_strips_standard_header (skill_cache._strip_compact_header not exported)", () => {});
  it.skip("test_strips_single_token_header (skill_cache._strip_compact_header not exported)", () => {});
  it.skip("test_no_header_returns_unchanged (skill_cache._strip_compact_header not exported)", () => {});
  it.skip("test_empty_string_returns_empty (skill_cache._strip_compact_header not exported)", () => {});
  it.skip("test_only_header_returns_empty (skill_cache._strip_compact_header not exported)", () => {});
  it.skip("test_header_not_at_start_not_stripped (skill_cache._strip_compact_header not exported)", () => {});
});

describe("TestGetAllCachedSkillsCharCounts", () => {
  it("test_returns_body_chars", () => {
    const body = "# Skill\n\n" + "text. ".repeat(100);
    const meta = skill_cache.store_output("sess-chars-1", "skill-a", body);
    expect(meta).not.toBeNull();

    const skills = skill_cache.get_all_cached_skills("sess-chars-1");
    expect(skills.length).toBe(1);
    const row = skills[0]!;
    expect("body_chars" in row).toBe(true);
    const loaded_body = skill_cache.load_output(meta!.output_id);
    expect(loaded_body).not.toBeNull();
    expect(Number(row["body_chars"])).toBe([...loaded_body!].length);
  });

  it("test_compact_chars_excludes_header", () => {
    const body = "# Skill\n\n" + "rule. ".repeat(200);
    const meta = skill_cache.store_output("sess-chars-2", "skill-b", body);
    expect(meta).not.toBeNull();

    const compact_text = "## Headings\nCRITICAL: do something.";
    skill_cache.store_compact("sess-chars-2", "skill-b", compact_text);

    const skills = skill_cache.get_all_cached_skills("sess-chars-2");
    expect(skills.length).toBe(1);
    const row = skills[0]!;
    expect("compact_chars" in row).toBe(true);
    expect(Number(row["compact_chars"])).toBe([...compact_text].length);
  });

  it("test_compact_chars_zero_when_no_compact", () => {
    const body = "# Skill\n\n" + "content. ".repeat(50);
    const meta = skill_cache.store_output("sess-chars-3", "skill-c", body);
    expect(meta).not.toBeNull();

    const skills = skill_cache.get_all_cached_skills("sess-chars-3");
    expect(skills.length).toBe(1);
    const row = skills[0]!;
    expect(Number(row["compact_chars"])).toBe(0);
  });

  it("test_token_estimate_consistency", () => {
    const body = "# Skill\n\n" + "line. ".repeat(300);
    const meta = skill_cache.store_output("sess-chars-4", "skill-d", body);
    expect(meta).not.toBeNull();

    const compact_text = "## H2\n" + "CRITICAL: rule. ".repeat(20);
    skill_cache.store_compact("sess-chars-4", "skill-d", compact_text);

    const skills = skill_cache.get_all_cached_skills("sess-chars-4");
    expect(skills.length).toBe(1);
    const row = skills[0]!;
    const compact_chars = Number(row["compact_chars"]);

    // store_compact's formula: max(1, len(compact_text) // 4)
    const expected_compact_tokens = Math.max(
      1,
      Math.floor([...compact_text].length / 4),
    );
    // skill-size formula: compact_chars // 4
    const derived_tokens = Math.floor(compact_chars / 4);
    expect(derived_tokens).toBe(expected_compact_tokens);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: db.list_all_project_hashes
// ---------------------------------------------------------------------------

describe("TestListAllProjectHashes", () => {
  it("test_empty_when_no_projects", () => {
    const hashes = _db_mod.list_all_project_hashes();
    expect(Array.isArray(hashes)).toBe(true);
  });

  it("test_returns_list_of_strings", () => {
    const hashes = _db_mod.list_all_project_hashes();
    for (const h of hashes) {
      expect(typeof h).toBe("string");
    }
  });

  it("test_registered_project_appears", () => {
    // Use a fake path that canonicalizes to a unique hash.
    const fake_root = path.join(paths.dataDir(), "fake-project-root");
    fs.mkdirSync(fake_root, { recursive: true });
    const ph = project_hash(canonicalize(fake_root));

    // Ensure the global DB is created and the projects table exists, then insert.
    _db_mod.openGlobal((conn) => {
      conn
        .prepare(
          "INSERT OR IGNORE INTO projects " +
            "(hash, root, marker, first_seen, last_seen, file_count, languages) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ph, String(fake_root), "manual", 0, 0, 0, "");
    });

    // Verify the DB file was actually created in the data dir.
    const db_path = paths.globalDbPath();
    expect(fs.existsSync(db_path)).toBe(true);

    const hashes = _db_mod.list_all_project_hashes();
    expect(hashes.includes(ph)).toBe(true);
  });

  it("test_returns_empty_list_not_exception_on_missing_global_db", () => {
    setDataDirOverride(path.join(paths.dataDir(), "nonexistent"));

    // Should not raise; should return empty list.
    const hashes = _db_mod.list_all_project_hashes();
    expect(hashes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: diff-aware re-read — stale cache bypasses hint
// ---------------------------------------------------------------------------

/**
 * Return a minimal mock SessionCache with the given skill_history entry.
 *
 * *ts* sets the cache creation timestamp used in the mtime-gate of the
 * diff-aware staleness check. A large value makes the cache appear newer than
 * any real file, suppressing the check. 0.0 lets the check proceed normally.
 */
function _make_cache(
  skill_name: string,
  content_sha: string,
  source_path = "",
  ts = 0.0,
): Record<string, unknown> {
  const entry = new SkillEntry({
    skill_name,
    output_id: "oid-test",
    content_sha,
    ts,
    body_bytes: 5000,
    truncated: false,
    run_count: 1,
    source_path,
  });
  return {
    skill_history: { [skill_name]: entry },
    hints_seen: {},
    has_hint_fingerprint: (_fp: unknown) => false,
    mark_hint_seen: (_fp: unknown) => undefined,
  };
}

describe("TestDiffAwareSkillReRead", () => {
  // tmp_path equivalent: a per-test scratch dir under the isolated data dir.
  let tmp_path: string;

  function makeTmp(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(paths.dataDir(), "tp-")));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_hint_emitted_when_sha_matches", () => {
    tmp_path = makeTmp();
    const skill_file = path.join(tmp_path, "SKILL.md");
    const skill_body = Buffer.from("# Ralph\n\nCRITICAL: rule.\n");
    fs.writeFileSync(skill_file, skill_body);
    const sha = createHash("sha256").update(skill_body).digest("hex");

    // Future timestamp: cache appears newer than the file → staleness check skipped.
    const future_ts = Date.now() / 1000 + 1_000_000.0;
    const cache = _make_cache("ralph", sha, skill_file, future_ts);
    const session_id = "sess-sha-match";
    const file_path = path.join(tmp_path, ".claude", "skills", "ralph", "SKILL.md");

    vi.spyOn(hooks_read, "_detect_skill_name_from_path").mockImplementation(
      (fp: string) => (fp.toLowerCase().includes("ralph") ? "ralph" : null),
    );

    const result = hooks_read._handle_skill_file_read(session_id, file_path, cache);
    expect(result).not.toBeNull();
  });

  it("test_no_hint_when_sha_differs", () => {
    tmp_path = makeTmp();
    const skill_file = path.join(tmp_path, "SKILL.md");
    const current_body = Buffer.from("# Ralph v2\n\nUpdated content.\n");
    fs.writeFileSync(skill_file, current_body);

    const stale_sha =
      "aabbccddeeff001122334455667788990011223344556677889900aabbccddeeff";
    const actual_sha = createHash("sha256").update(current_body).digest("hex");
    expect(stale_sha).not.toBe(actual_sha);

    // Past timestamp (epoch): file_mtime > cache_ts → SHA comparison fires.
    const cache = _make_cache("ralph", stale_sha, skill_file, 0.0);
    const session_id = "sess-sha-stale";
    const file_path = path.join(tmp_path, ".claude", "skills", "ralph", "SKILL.md");

    vi.spyOn(hooks_read, "_detect_skill_name_from_path").mockReturnValue("ralph");

    const result = hooks_read._handle_skill_file_read(session_id, file_path, cache);
    expect(result).toBeNull();
  });

  it("test_hint_emitted_when_no_source_path", () => {
    tmp_path = makeTmp();
    const cache = _make_cache("improve", "someshahex", "");
    const session_id = "sess-no-source";
    const file_path = path.join(tmp_path, ".claude", "skills", "improve", "SKILL.md");

    vi.spyOn(hooks_read, "_detect_skill_name_from_path").mockReturnValue("improve");

    const result = hooks_read._handle_skill_file_read(session_id, file_path, cache);
    expect(result).not.toBeNull();
  });

  it("test_hint_emitted_when_no_cached_sha", () => {
    tmp_path = makeTmp();
    const skill_file = path.join(tmp_path, "SKILL.md");
    fs.writeFileSync(skill_file, "# Improve\n\nContent.\n", "utf-8");

    // Empty SHA: cannot compare → fail-soft toward emitting hint.
    const cache = _make_cache("improve", "", skill_file);
    const session_id = "sess-no-sha";
    const file_path = path.join(tmp_path, ".claude", "skills", "improve", "SKILL.md");

    vi.spyOn(hooks_read, "_detect_skill_name_from_path").mockReturnValue("improve");

    const result = hooks_read._handle_skill_file_read(session_id, file_path, cache);
    expect(result).not.toBeNull();
  });

  it("test_hint_emitted_when_source_file_unreadable", () => {
    tmp_path = makeTmp();
    const nonexistent = path.join(tmp_path, "nonexistent_skill", "SKILL.md");

    const stale_sha = "0".repeat(64);
    const cache = _make_cache("myskill", stale_sha, nonexistent);
    const session_id = "sess-unreadable";
    const file_path = path.join(tmp_path, ".claude", "skills", "myskill", "SKILL.md");

    vi.spyOn(hooks_read, "_detect_skill_name_from_path").mockReturnValue("myskill");

    const result = hooks_read._handle_skill_file_read(session_id, file_path, cache);
    expect(result).not.toBeNull();
  });
});
