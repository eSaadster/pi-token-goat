/**
 * End-to-end COMPACT_END integration tests.
 *
 * 1:1 port of tests/test_skill_compact_integration.py.
 *
 * Covers the full pipeline:
 *   skill loaded (PostToolUse Skill hook) -> COMPACT_END detected ->
 *   compact cached -> manifest shows compact rules inline
 *
 * ---------------------------------------------------------------------------
 * Port status (Python -> TS)
 * ---------------------------------------------------------------------------
 * Live (ported deps only — skill_cache):
 *   - TestExtractCompactFromMarker (pure skill_cache.extract_compact_from_marker)
 *   - TestSkillSizeWithCompact::test_skill_size_has_marker_via_api / _no_marker_via_api
 *     (skill_cache.store_output + get_all_cached_skills)
 *   - TestStoreCompactAtomicWrite (skill_cache.store_compact / get_compact)
 *
 * Deferred (unported deps — it.skip + reason):
 *   - conftest.fire_skill_hook -> token_goat.hooks_skill.post_skill (Layer 4+)
 *   - compact.build_manifest / compact._load_config / compact._compact_render_kwargs
 *     / compact.estimate_tokens (compact-internals NOT ported)
 *   - token_goat.cli.app (typer CliRunner: skill-size, skill-body, skill-compact)
 *   - config.Config() / config.CompactAssistConfig() / config.SkillPreservationConfig()
 *     class constructors (TS config is interfaces + config.load(), no constructors)
 *   - config.load() TOML round-trips via paths.config_path() write_text
 */
import { describe, expect, it } from "vitest";

import * as skill_cache from "../src/token_goat/skill_cache.js";

// ---------------------------------------------------------------------------
// Realistic skill fixture bodies
// ---------------------------------------------------------------------------

// A skill body where the compact section sits at ~30% of the total length.
// Everything above <!-- COMPACT_END --> is the author-curated compact.
const _RALPH_COMPACT_SECTION = `# ralph

Autonomous iterative refinement loop with DoD, anti-shortcut guards, and
walk-away capability.

## Key Rules

- CRITICAL: Never skip a DoD gate — test failure = not done.
- MUST: Run the full test suite before marking any iteration complete.
- NEVER: Claim success without evidence (passing test output).
- RULE: Commit after each validated checkpoint; never batch.

## DoD

1. All tests pass (\`uv run pytest -x -q\`).
2. Lint clean (\`uv run ruff check\`).
3. Types pass (\`uv run mypy src\`).
`;

// The "detail" section that follows the marker (should NOT appear in compact).
// Must be large enough that total body exceeds 4000 bytes.
const _RALPH_DETAIL_SECTION =
  `
## Iteration Loop

Each iteration runs independently.  The orchestrator boots a fresh sub-agent,
hands it the task, and waits for a \`{"done": true}\` signal or a commit.

### Phase 1 — Explore

Read the codebase.  Do not write files in this phase.  Understand the full
call chain before touching anything.

### Phase 2 — Plan

Draft a multi-step plan.  Each step must be atomic and verifiable.

### Phase 3 — Execute

Implement one step at a time.  Run validation after every step.

### Phase 4 — Validate

Run the full test suite.  Fix failures before proceeding.  Never skip.

### Phase 5 — Commit

One commit per iteration.  Commit message describes the change concisely.

## Anti-shortcut Guards

These guards fire automatically and cannot be bypassed:

- Returning a stub is not done.
- "Works locally" is not done.
- "Tests skipped" is not done.
- "TODO" comments in submitted code = not done.
` + "Padding text to push detail section past the 4000-byte threshold. ".repeat(100);

// Full body: compact section + marker + detail section.
const _RALPH_SKILL_BODY =
  _RALPH_COMPACT_SECTION + "\n<!-- COMPACT_END -->\n" + _RALPH_DETAIL_SECTION;

// A skill body WITHOUT a <!-- COMPACT_END --> marker — tests auto-extraction fallback.
// Must be > 4000 bytes so the hook triggers compact storage.
const _IMPROVE_SKILL_BODY =
  `# improve

Autonomous self-improvement loop. Runs N iterations of ralph improve → commit
→ context compact.

## DoD

- CRITICAL: Each iteration must produce at least one real code change.
- MUST: All tests pass before the iteration is marked complete.
- NEVER: Increment the counter without a real commit.

## Loop Steps

1. Run ralph improve.
2. Commit the change.
3. Context compact.
4. Repeat N times (default 10).

## Flags

- \`--manual\`: one iteration per call.
- \`--iterations N\`: change loop count.
- \`--area "X"\`: lock focus to a subsystem.

## Extended Reference

This section provides background on how each phase works in depth.
The self-improvement loop is designed to be robust against context loss.

` + "Extended reference text for the improve loop. ".repeat(200);

// ---------------------------------------------------------------------------
// Unit tests: extract_compact_from_marker
// ---------------------------------------------------------------------------

describe("TestExtractCompactFromMarker", () => {
  it("test_returns_pre_marker_text", () => {
    // Everything above the marker line is returned, stripped.
    const result = skill_cache.extract_compact_from_marker(_RALPH_SKILL_BODY);
    expect(result).not.toBeNull();
    // Should contain the compact section content.
    expect(result!).toContain("CRITICAL");
    expect(result!).toContain("Never skip a DoD gate");
  });

  it("test_does_not_contain_detail_section", () => {
    // Text below the marker must not appear in the compact.
    const result = skill_cache.extract_compact_from_marker(_RALPH_SKILL_BODY);
    expect(result).not.toBeNull();
    expect(result!).not.toContain("Iteration Loop");
    expect(result!).not.toContain("Phase 1");
  });

  it("test_compact_is_at_most_30_percent_of_full_body", () => {
    // Compact length should be roughly <=30% of full body (author intent).
    const result = skill_cache.extract_compact_from_marker(_RALPH_SKILL_BODY);
    expect(result).not.toBeNull();
    const compact_len = [...result!].length;
    const full_len = [..._RALPH_SKILL_BODY].length;
    const ratio = compact_len / full_len;
    expect(ratio).toBeLessThanOrEqual(0.35);
  });

  it("test_returns_none_when_no_marker", () => {
    // Returns None for a body without the marker.
    const result = skill_cache.extract_compact_from_marker(_IMPROVE_SKILL_BODY);
    expect(result).toBeNull();
  });

  it("test_returns_none_for_empty_body", () => {
    expect(skill_cache.extract_compact_from_marker("")).toBeNull();
  });

  it("test_marker_at_very_start_returns_none", () => {
    // Marker on the first line produces an empty pre-section — returns None.
    const body = "<!-- COMPACT_END -->\n\nSome content after.";
    const result = skill_cache.extract_compact_from_marker(body);
    expect(result).toBeNull();
  });

  it("test_marker_inline_not_matched", () => {
    // A marker embedded in a line (not alone) must NOT trigger extraction.
    const body = "# Skill\n\nSome text <!-- COMPACT_END --> here.\n\nMore text.\n";
    const result = skill_cache.extract_compact_from_marker(body);
    expect(result).toBeNull();
  });

  it("test_marker_with_surrounding_whitespace_matched", () => {
    // Marker line with leading/trailing whitespace should still be matched.
    const body =
      "# Compact heading\n\nImportant rule.\n\n  <!-- COMPACT_END -->  \n\nDetail.\n";
    const result = skill_cache.extract_compact_from_marker(body);
    expect(result).not.toBeNull();
    expect(result!).toContain("Important rule.");
    expect(result!).not.toContain("Detail.");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: hook fires -> compact cached
// ---------------------------------------------------------------------------

describe("TestPostSkillHookCompactPipeline", () => {
  // ── marker path ────────────────────────────────────────────────────────

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_marker_compact_stored_after_hook", () => {
    // fire_skill_hook(sid, "ralph", body) -> get_compact(sid, "ralph") non-null.
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_marker_compact_contains_key_rules", () => {
    // Stored compact contains CRITICAL/MUST/NEVER.
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_marker_compact_smaller_than_full_body", () => {
    // Stored compact strictly smaller than the full body.
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_marker_compact_within_30pct_of_body", () => {
    // Compact <= ~35% of full body.
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_hook_system_message_emitted_for_marker_skill", () => {
    // Hook response systemMessage mentions ralph / compact (or is absent).
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_session_records_skill_after_hook", () => {
    // session.load(sid).skill_history contains "ralph".
  });

  // ── no-marker fallback ─────────────────────────────────────────────────

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_no_marker_falls_back_to_auto_extract", () => {
    // fire_skill_hook(improve) -> get_compact non-null (auto-extract).
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_no_marker_auto_extract_contains_dod_rules", () => {
    // Auto-extracted compact contains CRITICAL or MUST.
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_no_marker_auto_extract_smaller_than_body", () => {
    // Auto-extracted compact smaller than full body.
  });

  // PORT: deferred — conftest.fire_skill_hook (hooks_skill.post_skill) (Layer 4+)
  it.skip("test_small_body_no_compact_stored", () => {
    // Body under 4000 bytes -> no compact stored.
  });
});

// ---------------------------------------------------------------------------
// Manifest embeds compact inline
// ---------------------------------------------------------------------------

describe("TestManifestCompactIntegration", () => {
  // Every test uses fire_skill_hook + compact.build_manifest + compact._load_config
  // + config.Config(); none are ported.

  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_lazy_injection_shows_recall_pointer", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_lazy_injection_shows_token_count", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + skill_cache + config.Config (Layer 4+)
  it.skip("test_lazy_injection_no_compact_cached_still_shows_recall", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_lazy_injection_multiple_skills_all_get_pointers", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_eager_injection_embeds_key_rules_for_marker_skill", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_eager_injection_multiple_skills_each_get_compact", () => {});
  // PORT: deferred — compact.build_manifest + fire_skill_hook (Layer 4+)
  it.skip("test_manifest_compact_excludes_detail_section", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_manifest_contains_compact_for_auto_extract_skill", () => {});
  // PORT: deferred — compact.build_manifest + skill_cache + session (Layer 4+)
  it.skip("test_manifest_skill_section_present_even_without_compact", () => {});
});

// ---------------------------------------------------------------------------
// skill-size command reflects compact token count
// ---------------------------------------------------------------------------

describe("TestSkillSizeWithCompact", () => {
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-size --json) (Layer 4+)
  it.skip("test_skill_size_marker_skill_compact_tokens", () => {
    // store_output + store_compact -> skill-size --json shows compact_tokens > 0
    // and < body_tokens. Needs the CLI.
  });

  // PORT: deferred — token_goat.cli.app (CliRunner: skill-size --json) + generate_compact_summary (Layer 4+)
  it.skip("test_skill_size_auto_extract_skill_compact_tokens", () => {
    // store_output + generate_compact_summary + store_compact -> skill-size --json
    // shows compact_tokens > 0. Needs the CLI.
  });

  it("test_skill_size_has_marker_via_api", () => {
    // get_all_cached_skills marks skills that have a COMPACT_END marker.
    const sid = "integ-size-has-marker";
    const meta = skill_cache.store_output(sid, "ralph", _RALPH_SKILL_BODY);
    expect(meta).not.toBeNull();

    const skills = skill_cache.get_all_cached_skills(sid);
    const ralph_entry = skills.find((s) => s["name"] === "ralph");
    expect(ralph_entry).toBeDefined();
    // has_marker should be True for a skill with <!-- COMPACT_END -->
    expect(ralph_entry!["has_marker"]).toBe(true);
  });

  it("test_skill_size_no_marker_via_api", () => {
    // get_all_cached_skills marks skills without a COMPACT_END marker as has_marker=False.
    const sid = "integ-size-no-marker";
    const meta = skill_cache.store_output(sid, "improve", _IMPROVE_SKILL_BODY);
    expect(meta).not.toBeNull();

    const skills = skill_cache.get_all_cached_skills(sid);
    const improve_entry = skills.find((s) => s["name"] === "improve");
    expect(improve_entry).toBeDefined();
    expect(improve_entry!["has_marker"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// skill-body --compact returns marker compact
// ---------------------------------------------------------------------------

describe("TestSkillBodyCompactCommand", () => {
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body) + fire_skill_hook (Layer 4+)
  it.skip("test_skill_body_compact_returns_marker_text", () => {});
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body) + fire_skill_hook (Layer 4+)
  it.skip("test_skill_body_compact_smaller_than_full", () => {});
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body) + fire_skill_hook (Layer 4+)
  it.skip("test_skill_body_compact_without_marker_uses_auto_extract", () => {});
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body --json) + fire_skill_hook (Layer 4+)
  it.skip("test_skill_body_compact_json_output", () => {});
});

describe("TestSkillBodyCompactHeaderConsistency", () => {
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body) + fire_skill_hook (Layer 4+)
  it.skip("test_first_call_has_header", () => {});
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body) + fire_skill_hook (Layer 4+)
  it.skip("test_second_call_has_same_header", () => {});
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body) + fire_skill_hook (Layer 4+)
  it.skip("test_both_calls_produce_identical_output", () => {});
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-compact) + fire_skill_hook (Layer 4+)
  it.skip("test_skill_compact_command_has_header", () => {});
  // PORT: deferred — token_goat.cli.app (CliRunner: skill-body) + compact.estimate_tokens + fire_skill_hook (Layer 4+)
  it.skip("test_header_token_count_matches_body", () => {});
});

describe("TestStoreCompactAtomicWrite", () => {
  it("test_stored_file_readable_after_concurrent_writes", () => {
    // Multiple store_compact calls for the same skill (distinct sessions) don't
    // corrupt the files. JS atomicWriteText is synchronous; the Python test fans
    // out 8 threads writing 8 distinct sessions — ported as sequential writes,
    // preserving the invariant each session's file is readable and non-empty.
    const errors: unknown[] = [];

    const write_compact = (thread_id: number): void => {
      try {
        skill_cache.store_compact(
          `session-${thread_id}`,
          "ralph",
          `compact body from thread ${thread_id} `.repeat(50),
        );
      } catch (exc) {
        errors.push(exc);
      }
    };

    for (let i = 0; i < 8; i++) {
      write_compact(i);
    }

    expect(errors).toEqual([]);

    // Every written file must be readable and non-empty.
    for (let i = 0; i < 8; i++) {
      const text = skill_cache.get_compact(`session-${i}`, "ralph");
      expect(text).not.toBeNull();
      expect(
        text!.includes(`compact body from thread ${i}`) ||
          text!.includes("--- compact form"),
      ).toBe(true);
    }
  });

  it("test_store_compact_header_present_in_stored_file", () => {
    // The stored file (not the CLI display) always contains the header.
    skill_cache.store_compact(
      "sess-atomic",
      "testskill",
      "bare compact body text ".repeat(10),
    );
    const stored = skill_cache.get_compact("sess-atomic", "testskill");
    expect(stored).not.toBeNull();
    expect(stored!.startsWith("--- compact form (")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lazy skill injection — config and env var tests
// ---------------------------------------------------------------------------

describe("TestLazySkillInjectionConfig", () => {
  // PORT: deferred — config.CompactAssistConfig() constructor (TS config is interfaces) (Layer 4+)
  it.skip("test_config_default_lazy_skill_injection_is_true", () => {});
  // PORT: deferred — config.load() TOML round-trip + _config_mtime_cache (Layer 4+)
  it.skip("test_config_toml_lazy_false_sets_eager_mode", () => {});
  // PORT: deferred — config.load() env var + _config_mtime_cache (Layer 4+)
  it.skip("test_env_var_disables_lazy_injection", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_env_var_opt_out_causes_eager_injection_in_manifest", () => {});
});

// ---------------------------------------------------------------------------
// inline_snippets config key — [skill_preservation] section
// ---------------------------------------------------------------------------

describe("TestInlineSnippetsConfig", () => {
  // PORT: deferred — config.SkillPreservationConfig() constructor (TS config is interfaces) (Layer 4+)
  it.skip("test_config_default_inline_snippets_is_true", () => {});
  // PORT: deferred — config.load() TOML round-trip + _config_mtime_cache (Layer 4+)
  it.skip("test_config_toml_inline_snippets_false", () => {});
  // PORT: deferred — compact.build_manifest + fire_skill_hook (Layer 4+)
  it.skip("test_inline_snippets_true_inlines_compact_end_section", () => {});
  // PORT: deferred — compact.build_manifest + fire_skill_hook (Layer 4+)
  it.skip("test_inline_snippets_true_inlines_heuristic_extract_for_no_marker_skill", () => {});
  // PORT: deferred — compact.build_manifest/_load_config + fire_skill_hook + config.Config (Layer 4+)
  it.skip("test_inline_snippets_false_reverts_to_recall_command_only", () => {});
  // PORT: deferred — compact._compact_render_kwargs + config.Config() (Layer 4+)
  it.skip("test_inline_snippets_false_in_skill_preservation_overrides_default", () => {});
});
