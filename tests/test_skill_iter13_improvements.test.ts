/**
 * Tests for skill context savings accuracy improvements (iteration 13).
 *
 * Faithful 1:1 port of tests/test_skill_iter13_improvements.py.
 *
 * Covers:
 * 1. Sidecar schema version: write_sidecar embeds SIDECAR_SCHEMA_VERSION;
 *    read_sidecar tolerates v1 entries (no schema_v field) and logs a note for
 *    future versions.
 * 2. O(1) skill path index: _build_skill_path_index builds a
 *    source_path -> skill_name dict from skill_history; _handle_skill_file_read
 *    uses it before falling back to the regex.
 * 3. Stale compact advisory.
 * 4. skill-list --json compact_stale.
 *
 * Port notes:
 *  - Python patches `token_goat.skill_cache.sidecar_meta_path` and
 *    `token_goat.paths.atomic_write_text`. In the TS port write_sidecar /
 *    read_sidecar route their sidecar-path lookup through `self.sidecar_meta_path`
 *    (so vi.spyOn(skill_cache, "sidecar_meta_path") is observed), but
 *    `atomicWriteText` is a LEXICAL import binding (not namespaced), so it is NOT
 *    interceptable via vi.spyOn. The write tests therefore point
 *    sidecar_meta_path at a real temp file and read the JSON back from disk
 *    (faithful to the asserted JSON content).
 *  - read_sidecar's "future schema" debug note is emitted via _LOG.debug ->
 *    console.debug; the test spies on console.debug to observe it.
 *  - TestStaleCompactHint (Improvement 3): all 5 cases patch
 *    `token_goat.hooks_read.record_hint_stat_pair`, which hooks_read imports as a
 *    LEXICAL binding from hooks_common — vi.spyOn(hooks_common, ...) is invisible
 *    to that call site (same limitation already documented + deferred in
 *    test_hint_deduplication.test.ts:531). Deferred.
 *  - TestSkillListJsonCompactStale (Improvement 4): the `token-goat skill-list`
 *    CLI command (with the `compact_stale` JSON field) is NOT ported to TS yet.
 *    Deferred.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import { SIDECAR_SCHEMA_VERSION, SkillMeta } from "../src/token_goat/skill_cache.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import { SkillEntry } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Improvement 1: Sidecar schema version in write_sidecar / read_sidecar
// ---------------------------------------------------------------------------

describe("TestSidecarSchemaVersion", () => {
  let tmpDir: string;

  function mkTmp(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-iter13-sidecar-"));
    return tmpDir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it("test_write_sidecar_embeds_schema_v", () => {
    // write_sidecar puts SIDECAR_SCHEMA_VERSION in the JSON sidecar.
    const dir = mkTmp();
    const sidecarFile = path.join(dir, "test.json");

    const meta = new SkillMeta(
      "testsess-testskill-abc123",
      "testskill",
      "abc123",
      100,
      1000.0,
      false,
      "",
    );

    vi.spyOn(skill_cache, "sidecar_meta_path").mockReturnValue(sidecarFile);

    skill_cache.write_sidecar(meta);

    const written_data = JSON.parse(fs.readFileSync(sidecarFile, "utf-8")) as Record<string, unknown>;
    expect("schema_v" in written_data, "schema_v field must be present in written sidecar").toBe(true);
    expect(written_data["schema_v"]).toBe(SIDECAR_SCHEMA_VERSION);
  });

  it("test_write_sidecar_includes_all_meta_fields", () => {
    // write_sidecar preserves all SkillMeta fields alongside schema_v.
    const dir = mkTmp();
    const sidecarFile = path.join(dir, "test.json");

    const meta = new SkillMeta(
      "sess16chars--alphab-sha12345",
      "ralph",
      "deadbeef01234567",
      30000,
      9999.5,
      true,
      "/home/user/.claude/skills/ralph/SKILL.md",
    );

    vi.spyOn(skill_cache, "sidecar_meta_path").mockReturnValue(sidecarFile);

    skill_cache.write_sidecar(meta);

    const written_data = JSON.parse(fs.readFileSync(sidecarFile, "utf-8")) as Record<string, unknown>;
    expect(written_data["skill_name"]).toBe("ralph");
    expect(written_data["content_sha"]).toBe("deadbeef01234567");
    expect(written_data["body_bytes"]).toBe(30000);
    expect(written_data["truncated"]).toBe(true);
    expect(written_data["source_path"]).toBe("/home/user/.claude/skills/ralph/SKILL.md");
    expect("schema_v" in written_data).toBe(true);
  });

  it("test_read_sidecar_tolerates_v1_entry_no_schema_v", () => {
    // read_sidecar parses a v1 sidecar (no schema_v) without error.
    const dir = mkTmp();
    const sidecarFile = path.join(dir, "test.json");

    const v1_data = {
      output_id: "sess16chars--testsk-sha00000",
      skill_name: "testskill",
      content_sha: "sha00000",
      body_bytes: 500,
      ts: 1234.0,
      truncated: false,
      // No "schema_v" — this is a v1 entry
      // No "source_path" — also absent in original v1
    };
    fs.writeFileSync(sidecarFile, JSON.stringify(v1_data), "utf-8");

    vi.spyOn(skill_cache, "sidecar_meta_path").mockReturnValue(sidecarFile);

    const result = skill_cache.read_sidecar("sess16chars--testsk-sha00000");

    expect(result, "read_sidecar must not return None for a v1 entry").not.toBeNull();
    expect(result!.skill_name).toBe("testskill");
    expect(result!.content_sha).toBe("sha00000");
    // source_path defaults to "" for v1 entries
    expect(result!.source_path).toBe("");
  });

  it("test_read_sidecar_tolerates_future_schema_v", () => {
    // read_sidecar loads a future schema version entry without raising.
    const dir = mkTmp();
    const sidecarFile = path.join(dir, "future.json");

    const future_v = SIDECAR_SCHEMA_VERSION + 5;
    const future_data = {
      output_id: "sess16chars--future-sha99999",
      skill_name: "future-skill",
      content_sha: "sha99999",
      body_bytes: 12345,
      ts: 5678.0,
      truncated: false,
      source_path: "/some/future/path.md",
      schema_v: future_v,
      unknown_future_field: "should be ignored",
    };
    fs.writeFileSync(sidecarFile, JSON.stringify(future_data), "utf-8");

    vi.spyOn(skill_cache, "sidecar_meta_path").mockReturnValue(sidecarFile);

    // Capture the _LOG.debug note (routed through console.debug).
    const debugLines: string[] = [];
    vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
      debugLines.push(args.map((a) => String(a)).join(" "));
    });

    const result = skill_cache.read_sidecar("sess16chars--future-sha99999");

    expect(result, "read_sidecar must not return None for a future schema entry").not.toBeNull();
    expect(result!.skill_name).toBe("future-skill");
    expect(result!.source_path).toBe("/some/future/path.md");
    // Debug log should mention the schema version mismatch.
    const matched = debugLines.some(
      (line) => line.includes("schema_v") && line.includes(String(future_v)),
    );
    expect(matched, `Expected a debug log about schema_v=${future_v}, got: ${JSON.stringify(debugLines)}`).toBe(
      true,
    );
  });

  it("test_sidecar_schema_version_constant_exported", () => {
    // SIDECAR_SCHEMA_VERSION is exported from skill_cache.__all__.
    expect(skill_cache.__all__.includes("SIDECAR_SCHEMA_VERSION")).toBe(true);
    expect(typeof skill_cache.SIDECAR_SCHEMA_VERSION).toBe("number");
    expect(skill_cache.SIDECAR_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: O(1) skill path index
// ---------------------------------------------------------------------------

describe("TestSkillPathIndex", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function _make_entry(name: string, source_path = ""): SkillEntry {
    return new SkillEntry({
      skill_name: name,
      output_id: `sess-${name}-000`,
      content_sha: "abc",
      ts: 1000.0,
      body_bytes: 5000,
      source_path,
    });
  }

  it("test_build_index_maps_source_path_to_name", () => {
    // _build_skill_path_index maps normalised source_path -> skill_name.
    const entry_ralph = _make_entry("ralph", "/home/user/.claude/skills/ralph/SKILL.md");
    const entry_improve = _make_entry("improve", "C:\\Users\\user\\.claude\\skills\\improve\\SKILL.md");
    const history = { ralph: entry_ralph, improve: entry_improve };

    const index = hooks_read._build_skill_path_index(history);

    expect(typeof index).toBe("object");
    // Forward-slash normalised, lower-cased.
    expect("/home/user/.claude/skills/ralph/skill.md" in index).toBe(true);
    expect(index["/home/user/.claude/skills/ralph/skill.md"]).toBe("ralph");
    // Windows backslash normalised to forward slash, lower-cased.
    expect("c:/users/user/.claude/skills/improve/skill.md" in index).toBe(true);
    expect(index["c:/users/user/.claude/skills/improve/skill.md"]).toBe("improve");
  });

  it("test_build_index_excludes_empty_source_paths", () => {
    // Entries without source_path are excluded from the index.
    const entry_with = _make_entry("with-path", "/home/.claude/skills/with-path/SKILL.md");
    const entry_without = _make_entry("without-path", "");
    const history = { "with-path": entry_with, "without-path": entry_without };

    const index = hooks_read._build_skill_path_index(history);

    expect(Object.keys(index).length).toBe(1);
    expect(Object.values(index).includes("without-path")).toBe(false);
  });

  it("test_build_index_empty_history", () => {
    // Empty skill_history produces an empty index (no crash).
    const index = hooks_read._build_skill_path_index({});
    expect(index).toEqual({});
  });

  it("test_build_index_fail_soft_on_bad_entry", () => {
    // _build_skill_path_index returns an empty dict when history iteration raises
    // (fail-soft). Python passes an object whose .items() raises; in TS the
    // iteration is Object.entries(), so a Proxy whose ownKeys trap throws drives
    // the same fail-soft catch.
    const badHistory = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("intentional failure");
        },
      },
    );

    const result = hooks_read._build_skill_path_index(badHistory as Record<string, unknown>);
    expect(result).toEqual({});
  });

  it("test_path_index_cached_on_cache_object", () => {
    // _handle_skill_file_read caches the built index as _skill_path_index.
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "sess-ralph-000",
      content_sha: "abc",
      ts: 1000.0,
      body_bytes: 5000,
      source_path: "/home/user/.claude/skills/ralph/SKILL.md",
    });
    const cache: Record<string, unknown> = {
      skill_history: { ralph: entry },
      has_hint_fingerprint: (_: unknown) => false,
      mark_hint_seen: (_: unknown) => undefined,
    };
    // Simulate no pre-existing index (absent attribute -> build path runs).

    hooks_read._handle_skill_file_read(
      "test-session",
      "/home/user/.claude/skills/ralph/SKILL.md",
      cache,
    );

    // After the call, _skill_path_index should be a real dict.
    const stored_index = cache["_skill_path_index"];
    expect(
      stored_index !== null && typeof stored_index === "object" && !Array.isArray(stored_index),
      `Expected a dict index cached on cache, got ${typeof stored_index}`,
    ).toBe(true);
  });

  it("test_magicmock_cache_type_check_prevents_false_index", () => {
    // A non-dict _skill_path_index attribute is rejected (type check): the O(1)
    // path confirms an isinstance/_isDict check before use, so the function still
    // returns a hint for a known skill path.
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "sess-ralph-111",
      content_sha: "deadbeef",
      ts: 1000.0,
      body_bytes: 5000,
      source_path: "/home/user/.claude/skills/ralph/SKILL.md",
    });
    const cache: Record<string, unknown> = {
      skill_history: { ralph: entry },
      has_hint_fingerprint: (_: unknown) => false,
      mark_hint_seen: (_: unknown) => undefined,
      // A non-dict sentinel standing in for MagicMock's auto-created attribute.
      _skill_path_index: () => undefined,
    };

    const resp = hooks_read._handle_skill_file_read(
      "test-session",
      "/home/user/.claude/skills/ralph/SKILL.md",
      cache,
    );
    // Should return a hint (skill is loaded, file is a skill path).
    expect(resp, "Expected a hint response for a known skill path with non-dict index attr").not.toBeNull();
  });

  it("test_detect_skill_name_fast_exit_skips_non_skill_paths", () => {
    // _detect_skill_name_from_path returns null quickly for non-.claude paths.
    expect(hooks_read._detect_skill_name_from_path("/home/user/project/src/main.py")).toBeNull();
    expect(hooks_read._detect_skill_name_from_path("/tmp/build/output.js")).toBeNull();
    expect(hooks_read._detect_skill_name_from_path("C:\\Users\\user\\Documents\\report.md")).toBeNull();
    expect(hooks_read._detect_skill_name_from_path("")).toBeNull();
  });

  it("test_detect_skill_name_fast_exit_allows_claude_paths", () => {
    // _detect_skill_name_from_path still processes .claude/skills paths.
    const result = hooks_read._detect_skill_name_from_path("/home/user/.claude/skills/ralph/SKILL.md");
    expect(result).toBe("ralph");
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: Stale compact advisory hint
// ---------------------------------------------------------------------------

describe("TestStaleCompactHint", () => {
  it.skip("test_stale_compact_advisory_emitted", () => {
    // PORT: deferred — Python patches token_goat.hooks_read.record_hint_stat_pair
    // to capture (kind, text, path). hooks_read imports record_hint_stat_pair as
    // a LEXICAL binding from hooks_common, so vi.spyOn(hooks_common, ...) is not
    // observed at the call site (same limitation deferred in
    // test_hint_deduplication.test.ts). No seam exists to capture the hint text.
  });

  it.skip("test_no_advisory_when_compact_sha_matches", () => {
    // PORT: deferred — record_hint_stat_pair lexical-binding interception
    // unavailable (see test_stale_compact_advisory_emitted).
  });

  it.skip("test_no_advisory_when_no_compact_exists", () => {
    // PORT: deferred — record_hint_stat_pair lexical-binding interception
    // unavailable (see test_stale_compact_advisory_emitted).
  });

  it.skip("test_no_advisory_when_compact_has_no_sha", () => {
    // PORT: deferred — record_hint_stat_pair lexical-binding interception
    // unavailable (see test_stale_compact_advisory_emitted).
  });

  it.skip("test_stale_advisory_deduped_by_fingerprint", () => {
    // PORT: deferred — record_hint_stat_pair lexical-binding interception
    // unavailable (see test_stale_compact_advisory_emitted).
  });
});

// ---------------------------------------------------------------------------
// Improvement 4: skill-list --json compact_stale field
// ---------------------------------------------------------------------------

describe("TestSkillListJsonCompactStale", () => {
  it.skip("test_json_includes_compact_stale_true", () => {
    // PORT: deferred — the `token-goat skill-list` CLI command (and its
    // compact_stale JSON field) is not ported to the TS CLI yet.
  });

  it.skip("test_json_includes_compact_stale_false_when_current", () => {
    // PORT: deferred — `token-goat skill-list` not ported to the TS CLI yet.
  });

  it.skip("test_json_compact_stale_null_when_no_compact", () => {
    // PORT: deferred — `token-goat skill-list` not ported to the TS CLI yet.
  });
});
