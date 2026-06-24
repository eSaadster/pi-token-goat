/**
 * Tests for the `token-goat skill-section` command and `get_skill_file_path`.
 *
 * 1:1 port of tests/test_skill_section.py.
 *
 * ---------------------------------------------------------------------------
 * Port status (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - TestGetSkillFilePath: pure skill_cache.get_skill_file_path unit tests.
 *    Ported live. Python's `patch.object(hooks_skill, "_resolve_skill_body_path",
 *    ...)` maps to the dedicated test seam
 *    hooks_skill._setResolveSkillBodyPathOverride. store_output/write_sidecar
 *    are exported from skill_cache.
 *  - TestCmdSkillSection: every test drives `token_goat.cli.app` via CliRunner
 *    (the `skill-section` CLI command). The CLI layer (cli.app / typer) is NOT
 *    ported, so these are deferred (it.skip + reason), matching the established
 *    convention for cli.app-dependent tests.
 *
 * Python `Path` results -> the TS get_skill_file_path returns a string path; the
 * tests stored `source_path=str(skill_file)` so equality is string vs string.
 * tmp dirs are realpath'd (macOS /var symlink) for parity with project lookups.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import { _setResolveSkillBodyPathOverride } from "../src/token_goat/hooks_skill.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Store a skill body and write its sidecar so lookup_by_name can find it. */
function _store_skill(
  sid: string,
  name: string,
  body: string,
): skill_cache.SkillMeta {
  const meta = skill_cache.store_output(sid, name, body);
  expect(meta).not.toBeNull();
  skill_cache.write_sidecar(meta!);
  return meta!;
}

// ---------------------------------------------------------------------------
// get_skill_file_path — unit tests
// ---------------------------------------------------------------------------

describe("TestGetSkillFilePath", () => {
  let tmp_path: string;

  beforeEach(() => {
    tmp_path = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-skillsec-")));
  });

  afterEach(() => {
    _setResolveSkillBodyPathOverride(null);
    try {
      fs.rmSync(tmp_path, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("test_returns_none_for_unknown_skill", () => {
    // Returns None when the skill is not cached and not on disk.
    const result = skill_cache.get_skill_file_path("no-such-skill-xyz");
    expect(result).toBeNull();
  });

  it("test_returns_path_from_source_path_in_sidecar", () => {
    // Returns the source_path recorded in the sidecar when the file exists.
    const skill_file = path.join(tmp_path, "my-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(skill_file), { recursive: true });
    fs.writeFileSync(skill_file, "# my-skill\n\n## Section\n\ncontent\n", "utf-8");

    const body = "# my-skill\n\n## Section\n\ncontent\n";
    const meta = skill_cache.store_output("s-1", "my-skill", body, {
      source_path: skill_file,
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);

    const result = skill_cache.get_skill_file_path("my-skill");
    expect(result).toBe(skill_file);
  });

  it("test_skips_sidecar_source_path_when_file_missing", () => {
    // Falls through to filesystem probe when the recorded source_path no longer exists.
    const fake_path = path.join(tmp_path, "gone", "SKILL.md");
    // Do NOT create the file — it should be missing.
    const meta = skill_cache.store_output("s-2", "ghost-skill", "# body\n", {
      source_path: fake_path,
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);

    // No filesystem probe will find it either.
    const result = skill_cache.get_skill_file_path("ghost-skill");
    expect(result).toBeNull();
  });

  it("test_falls_back_to_hooks_skill_probe", () => {
    // Falls back to _resolve_skill_body_path when no cached entry has a usable path.
    const skill_file = path.join(tmp_path, "probe-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(skill_file), { recursive: true });
    fs.writeFileSync(skill_file, "# probe\n", "utf-8");

    _setResolveSkillBodyPathOverride(() => skill_file);
    const result = skill_cache.get_skill_file_path("probe-skill");

    expect(result).toBe(skill_file);
  });

  it("test_returns_none_when_probe_returns_empty", () => {
    // Returns None when _resolve_skill_body_path returns empty string.
    _setResolveSkillBodyPathOverride(() => "");
    const result = skill_cache.get_skill_file_path("missing-skill");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// skill-section CLI command
// ---------------------------------------------------------------------------

describe("TestCmdSkillSection", () => {
  // _BODY / _make_skill_file would back these CLI tests; deferred wholesale.
  void _store_skill; // referenced by the deferred bodies in the Python source

  // PORT: deferred — token_goat.cli.app (typer CliRunner) not ported (Layer 4+)
  it.skip("test_resolves_skill_and_returns_section", () => {
    // CliRunner invoke ["skill-section", "ralph", "Definition of Done"] with
    // get_skill_file_path patched to the tmp SKILL.md -> section body returned.
  });

  // PORT: deferred — token_goat.cli.app (typer CliRunner) not ported (Layer 4+)
  it.skip("test_case_insensitive_heading_match", () => {
    // CliRunner invoke ["skill-section", "ralph", "overview"] -> case-insensitive
    // heading match returns the Overview section.
  });

  // PORT: deferred — token_goat.cli.app (typer CliRunner) not ported (Layer 4+)
  it.skip("test_unknown_skill_exits_nonzero", () => {
    // get_skill_file_path -> None; CliRunner invoke exits 1 with index hint.
  });

  // PORT: deferred — token_goat.cli.app (typer CliRunner) not ported (Layer 4+)
  it.skip("test_missing_heading_emits_not_found", () => {
    // Nonexistent heading -> exit_code in {0,1} and "not found"/"Nonexistent" text.
  });

  // PORT: deferred — token_goat.cli.app (typer CliRunner) not ported (Layer 4+)
  it.skip("test_json_output", () => {
    // --json returns valid JSON with section text (ok is not False).
  });

  // PORT: deferred — token_goat.cli.app (typer CliRunner) not ported (Layer 4+)
  it.skip("test_unknown_skill_json_error", () => {
    // --json + unknown skill returns JSON error payload (ok is False).
  });

  // PORT: deferred — token_goat.cli.app (typer CliRunner) not ported (Layer 4+)
  it.skip("test_plugin_namespaced_skill", () => {
    // plugin:improve name handled (colon allowed); Step 4 content returned.
  });
});
