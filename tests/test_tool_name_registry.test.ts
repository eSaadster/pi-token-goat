/**
 * Cross-harness tool name consistency tests. 1:1 port of
 * tests/test_tool_name_registry.py.
 *
 * The Python suite asserts that:
 *   1. Every harness-specific tool-name map's *values* are valid canonical tool
 *      names (prevents silent typos like "Webfetch" instead of "WebFetch").
 *   2. The canonical tool set lives in exactly one place:
 *      hook_registry.CANONICAL_TOOLS.
 *   3. Each harness covers at least its declared minimum set of canonical tools.
 *
 * Port scope:
 *   - The CANONICAL_TOOLS-definition tests and the MIN_COVERAGE-subset tests are
 *     ported directly — they depend only on hook_registry + the _*_MIN_COVERAGE
 *     constants defined IN THIS TEST FILE.
 *   - The tests that import token_goat.hooks_cli (_CODEX_TOOL_NAME_MAP,
 *     _GEMINI_TOOL_NAME_MAP, _TG_KNOWN_TOOLS) or token_goat.bridges
 *     (OPENCODE_PLUGIN_TS / OPENCLAW_PLUGIN_TS) are SKIPPED with a PORT note:
 *     neither hooks_cli nor bridges is ported yet (they land with the hooks_cli
 *     follow-up). They are marked it.skip and counted, never silently dropped.
 *
 * Parity mapping:
 *   - frozenset CANONICAL_TOOLS → ReadonlySet<string>; isinstance(_, frozenset)
 *     → the Set-ness check (a frozen ReadonlySet here).
 *   - hook_registry.__all__ membership → the __all__ array the port re-exports.
 *   - pytest.mark.parametrize over the four MIN_COVERAGE sets → it.each.
 */
import { describe, expect, it } from "vitest";

import * as hook_registry from "../src/token_goat/hook_registry.js";
import { CANONICAL_TOOLS } from "../src/token_goat/hook_registry.js";
import {
  _CODEX_TOOL_NAME_MAP,
  _GEMINI_TOOL_NAME_MAP,
  _TG_KNOWN_TOOLS,
} from "../src/token_goat/hooks_cli.js";

// ---------------------------------------------------------------------------
// CANONICAL_TOOLS is the single source of truth
// ---------------------------------------------------------------------------

describe("TestCanonicalToolsDefinition", () => {
  it("test_canonical_tools_exported_from_hook_registry", () => {
    // CANONICAL_TOOLS must be reachable via hook_registry.__all__.
    expect(hook_registry.__all__).toContain("CANONICAL_TOOLS");
  });

  it("test_canonical_tools_is_frozenset", () => {
    // frozenset in Python → a ReadonlySet here.
    expect(CANONICAL_TOOLS instanceof Set).toBe(true);
  });

  it("test_canonical_tools_not_empty", () => {
    expect(CANONICAL_TOOLS.size).toBeGreaterThan(0);
  });

  it("test_canonical_tools_contains_core_nine", () => {
    // The nine tools present since the project's first public release.
    const expected = new Set([
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash",
      "Glob",
      "WebFetch",
      "Grep",
      "Skill",
    ]);
    expect(new Set(CANONICAL_TOOLS)).toEqual(expected);
  });

  it("test_hooks_cli_tg_known_tools_matches_canonical", () => {
    // hooks_cli._TG_KNOWN_TOOLS must be the same object as CANONICAL_TOOLS.
    // Python: `_TG_KNOWN_TOOLS is CANONICAL_TOOLS` — identity. The TS port
    // re-exports CANONICAL_TOOLS as _TG_KNOWN_TOOLS, so a referential-equality
    // check (toBe) is the faithful analogue.
    expect(_TG_KNOWN_TOOLS).toBe(CANONICAL_TOOLS);
  });
});

// ---------------------------------------------------------------------------
// All map values must be valid canonical names
// ---------------------------------------------------------------------------

describe("TestToolMapValuesAreCanonical", () => {
  it("test_codex_map_values_are_canonical", () => {
    const codex_map = _CODEX_TOOL_NAME_MAP;
    expect(Object.keys(codex_map).length).toBeGreaterThan(0); // import may have failed
    const bad = [...new Set(Object.values(codex_map).filter((v) => !CANONICAL_TOOLS.has(v)))].sort();
    expect(bad).toEqual([]);
  });

  it("test_gemini_map_values_are_canonical", () => {
    const gemini_map = _GEMINI_TOOL_NAME_MAP;
    expect(Object.keys(gemini_map).length).toBeGreaterThan(0); // import may have failed
    const bad = [...new Set(Object.values(gemini_map).filter((v) => !CANONICAL_TOOLS.has(v)))].sort();
    expect(bad).toEqual([]);
  });

  it.skip("test_opencode_bridge_map_values_are_canonical", () => {
    // PORT: deferred — depends on token_goat.bridges.OPENCODE_PLUGIN_TS.
  });

  it.skip("test_openclaw_bridge_map_values_are_canonical", () => {
    // PORT: deferred — depends on token_goat.bridges.OPENCLAW_PLUGIN_TS.
  });
});

// ---------------------------------------------------------------------------
// Minimum coverage per harness
// ---------------------------------------------------------------------------
//
// These sets document the minimum tools each harness is expected to route.
// They are deliberately conservative — not "must cover all 9" but "must cover
// the subset this harness actually supports".

/** Tools that Codex supports. Codex has no Read (uses Bash+cat), no Skill.
 *  MultiEdit maps through apply_patch -> Edit rather than as a distinct entry. */
const _CODEX_MIN_COVERAGE: ReadonlySet<string> = new Set([
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "Write",
]);

/** Tools that Gemini CLI supports. Gemini has no Skill or MultiEdit. */
const _GEMINI_MIN_COVERAGE: ReadonlySet<string> = new Set([
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "Write",
]);

/** opencode has no Write (write is not a distinct opencode tool; edits go through
 *  edit/apply_patch). No MultiEdit or Skill. */
const _OPENCODE_MIN_COVERAGE: ReadonlySet<string> = new Set([
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
]);

/** openclaw has no MultiEdit or Skill. */
const _OPENCLAW_MIN_COVERAGE: ReadonlySet<string> = new Set([
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "Write",
]);

describe("TestHarnessCoverageMinimums", () => {
  it("test_codex_covers_minimum_tools", () => {
    const covered = new Set(Object.values(_CODEX_TOOL_NAME_MAP));
    const missing = [..._CODEX_MIN_COVERAGE].filter((t) => !covered.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("test_gemini_covers_minimum_tools", () => {
    const covered = new Set(Object.values(_GEMINI_TOOL_NAME_MAP));
    const missing = [..._GEMINI_MIN_COVERAGE].filter((t) => !covered.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it.skip("test_opencode_bridge_covers_minimum_tools", () => {
    // PORT: deferred — depends on token_goat.bridges.OPENCODE_PLUGIN_TS.
  });

  it.skip("test_openclaw_bridge_covers_minimum_tools", () => {
    // PORT: deferred — depends on token_goat.bridges.OPENCLAW_PLUGIN_TS.
  });
});

// ---------------------------------------------------------------------------
// Cross-harness: all declared minimums use only canonical names
// ---------------------------------------------------------------------------

describe("TestMinimumCoverageSetsAreCanonical", () => {
  // The _*_MIN_COVERAGE constants themselves must reference only valid tool
  // names. Prevents the minimum sets from going stale if a tool is renamed in
  // CANONICAL_TOOLS without updating these constants.
  it.each([
    ["Codex", _CODEX_MIN_COVERAGE],
    ["Gemini", _GEMINI_MIN_COVERAGE],
    ["opencode", _OPENCODE_MIN_COVERAGE],
    ["openclaw", _OPENCLAW_MIN_COVERAGE],
  ] as const)(
    "test_min_coverage_set_is_subset_of_canonical[%s]",
    (name: string, coverage_set: ReadonlySet<string>) => {
      const bad = [...coverage_set].filter((t) => !CANONICAL_TOOLS.has(t)).sort();
      expect(bad).toEqual([]);
    },
  );
});
