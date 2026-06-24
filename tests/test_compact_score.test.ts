/**
 * Tests for skill_cache.score_compact() — compact quality scoring.
 *
 * 1:1 port of tests/test_compact_score.py. Each Python `class Test*` maps to a
 * vitest `describe(...)`; each `def test_*` maps to an `it()` with the SAME name
 * and the SAME assertion polarity; the `@pytest.mark.parametrize` over rule
 * keywords maps to `it.each`.
 *
 * ---------------------------------------------------------------------------
 * PORT STATUS — LIVE. skill_cache.ts is now ported and exports `score_compact`
 * (a pure function of its two string args), so every test imports it directly
 * and asserts the real return shape. score_compact returns Record<string,
 * unknown>; a thin `ScoreResult`-typed wrapper narrows the fields these tests
 * read so the assertions stay type-clean (the Python test indexes a dict).
 *
 * Parity notes for the WHEN-PORTED form are preserved inline (Python -> TS):
 *  - score_compact(compact, body) returns a record; `result["score"]` is an int
 *    in [0, 100], `result["coverage_ratio"]` is a float capped at 1.0,
 *    `result["issues"]` is a string[]; the heading/section/marker/rule flags are
 *    numbers/booleans. `isinstance(x, int)` -> Number.isInteger(x); `isinstance(
 *    x, float)` -> typeof x === "number"; `isinstance(x, list)` -> Array.isArray.
 *  - `" ".join(result["issues"])` -> `result.issues.join(" ")`; substring checks
 *    (`"no headings" in ...`) -> `.includes("no headings")`.
 *  - `result[key] is True/False` -> `expect(result[key]).toBe(true/false)`.
 *  - Per-test tmp data dir + cache clearing comes from tests/setup.ts; this file
 *    needs no fixtures of its own (score_compact is a pure function of its two
 *    string arguments).
 */
import { describe, expect, it } from "vitest";

import { score_compact as _score_compact } from "../src/token_goat/skill_cache.js";

// score_compact returns Record<string, unknown>; narrow it to the fields these
// tests read so the assertions stay type-clean (the Python test indexes a dict).
interface ScoreResult {
  score: number;
  coverage_ratio: number;
  non_empty_sections: number;
  has_goal_marker: boolean;
  headings_count: number;
  has_rule_lines: boolean;
  issues: string[];
}
function score_compact(compact_body: string, full_body: string): ScoreResult {
  return _score_compact(compact_body, full_body) as unknown as ScoreResult;
}

// ---------------------------------------------------------------------------
// Helpers (ported for when the tests are un-skipped; standalone, no fixtures).
// ---------------------------------------------------------------------------

const _MINIMAL_BODY = "x".repeat(3000); // ~1000 tokens

/** Build a compact text string with the given characteristics. */
function _make_compact({
  headings = 3,
  fill_lines = 5,
  rule = true,
}: { headings?: number; fill_lines?: number; rule?: boolean } = {}): string {
  const lines: string[] = [];
  for (let i = 0; i < headings; i++) {
    lines.push(`## Section ${i + 1}`);
    for (let j = 0; j < fill_lines; j++) {
      lines.push(`Content line ${j}`);
    }
  }
  if (rule) {
    lines.push("CRITICAL: never skip this step");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sub-area A — score_compact returns required keys with correct types
// ---------------------------------------------------------------------------

describe("TestScoreCompactReturnShape", () => {
  it("test_required_keys_present", () => {
    const result = score_compact("## Heading\nSome content.", _MINIMAL_BODY);
    for (const key of [
      "score",
      "coverage_ratio",
      "non_empty_sections",
      "has_goal_marker",
      "headings_count",
      "has_rule_lines",
      "issues",
    ]) {
      expect(result, `key ${key} missing from score_compact result`).toHaveProperty(key);
    }
  });

  it("test_score_is_int_in_range", () => {
    const result = score_compact("## Heading\nSome content.", _MINIMAL_BODY);
    expect(Number.isInteger(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("test_coverage_ratio_is_float_capped_at_one", () => {
    const result = score_compact("x".repeat(999), "x".repeat(100)); // compact > body
    expect(typeof result.coverage_ratio).toBe("number");
    expect(result.coverage_ratio).toBeLessThanOrEqual(1.0);
  });

  it("test_issues_is_list_of_strings", () => {
    const result = score_compact("## Heading\nSome content.", _MINIMAL_BODY);
    expect(Array.isArray(result.issues)).toBe(true);
    for (const item of result.issues) {
      expect(typeof item).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Sub-area B — Coverage ratio scoring
// ---------------------------------------------------------------------------

describe("TestCoverageRatioScoring", () => {
  it("test_stub_compact_gets_low_score", () => {
    const tiny_compact = "## Note\nSee skill.";
    const big_body = "x".repeat(30000);
    const stub_result = score_compact(tiny_compact, big_body);
    expect(stub_result.score).toBeLessThan(50);
    expect(stub_result.coverage_ratio).toBeLessThan(0.05);
  });

  it("test_verbose_compact_gets_lower_score", () => {
    const body = "x".repeat(300);
    const verbose_compact = "x".repeat(260); // ~87% of body
    const ideal_compact = "x".repeat(90); // 30% of body — ideal range
    const verbose_result = score_compact(verbose_compact, body);
    const ideal_result = score_compact(ideal_compact, body);
    expect(ideal_result.score).toBeGreaterThanOrEqual(verbose_result.score);
  });

  it("test_ideal_range_gets_positive_bonus", () => {
    const body = "x".repeat(3000);
    const ideal_compact = _make_compact({ headings: 3, fill_lines: 5, rule: true });
    const ideal_compact_padded = ideal_compact + "\n" + "y ".repeat(200);
    const result = score_compact(ideal_compact_padded, body);
    expect(result.score).toBeGreaterThanOrEqual(55);
  });
});

// ---------------------------------------------------------------------------
// Sub-area C — Heading and non-empty-section counting
// ---------------------------------------------------------------------------

describe("TestHeadingAndSectionCounting", () => {
  it("test_counts_headings_correctly", () => {
    const compact = "## Section 1\nContent.\n\n## Section 2\nContent.\n\n# Top\nContent.";
    const result = score_compact(compact, _MINIMAL_BODY);
    expect(result.headings_count).toBe(3);
  });

  it("test_headings_inside_fenced_blocks_excluded", () => {
    const compact = "## Real Heading\nContent.\n```\n## Not A Heading\n```\n";
    const result = score_compact(compact, _MINIMAL_BODY);
    expect(result.headings_count).toBe(1);
  });

  it("test_non_empty_sections_counts_sections_with_content", () => {
    const compact = "## Has Content\nSome text here.\n\n## Empty Section\n";
    const result = score_compact(compact, _MINIMAL_BODY);
    expect(result.non_empty_sections).toBe(1);
    expect(result.headings_count).toBe(2);
  });

  it("test_all_sections_with_content", () => {
    const compact = "## A\nContent A.\n\n## B\nContent B.\n";
    const result = score_compact(compact, _MINIMAL_BODY);
    expect(result.non_empty_sections).toBe(2);
  });

  it("test_compact_with_no_headings_gets_penalty", () => {
    const no_headings = "Just some plain text without any structure.";
    const result = score_compact(no_headings, _MINIMAL_BODY);
    expect(result.headings_count).toBe(0);
    expect(result.issues.join(" ")).toContain("no headings");
  });
});

// ---------------------------------------------------------------------------
// Sub-area D — Goal-marker detection
// ---------------------------------------------------------------------------

describe("TestGoalMarkerDetection", () => {
  it("test_compact_end_marker_in_body_detected", () => {
    const body_with_marker = "## Intro\nSome text.\n<!-- COMPACT_END -->\n## More\nStuff.";
    const compact = "## Intro\nSome text.";
    const result = score_compact(compact, body_with_marker);
    expect(result.has_goal_marker).toBe(true);
  });

  it("test_frontmatter_description_detected", () => {
    const body_with_frontmatter = "---\ndescription: My skill does X.\n---\n## Section\nContent.";
    const compact = "## Section\nContent.";
    const result = score_compact(compact, body_with_frontmatter);
    expect(result.has_goal_marker).toBe(true);
  });

  it("test_plain_body_no_marker", () => {
    const plain_body = "## Section\nContent without markers.";
    const compact = "## Section\nContent.";
    const result = score_compact(compact, plain_body);
    expect(result.has_goal_marker).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sub-area E — Rule-line detection
// ---------------------------------------------------------------------------

describe("TestRuleLineDetection", () => {
  it.each(["CRITICAL", "MUST", "NEVER", "RULE"])("test_rule_keyword_detected[%s]", (_keyword) => {
    const compact = `## Section\n${_keyword}: do this important thing.`;
    const result = score_compact(compact, _MINIMAL_BODY);
    expect(result.has_rule_lines).toBe(true);
  });

  it("test_no_rule_lines_when_absent", () => {
    const compact = "## Section\nOrdinary content line.";
    const result = score_compact(compact, _MINIMAL_BODY);
    expect(result.has_rule_lines).toBe(false);
  });

  it("test_rule_line_gives_score_bonus", () => {
    const body = _MINIMAL_BODY;
    const with_rule = "## Section\nContent.\nCRITICAL: key directive.";
    const without_rule = "## Section\nContent.\nOrdinary text.";
    const with_score = score_compact(with_rule, body);
    const without_score = score_compact(without_rule, body);
    expect(with_score.score).toBeGreaterThanOrEqual(without_score.score);
  });
});

// ---------------------------------------------------------------------------
// Sub-area F — Well-formed compact scores better than stub
// ---------------------------------------------------------------------------

describe("TestScoreOrdering", () => {
  it("test_wellformed_beats_stub", () => {
    const body = _MINIMAL_BODY;
    const well_formed =
      _make_compact({ headings: 3, fill_lines: 10, rule: true }) + "\n" + "w ".repeat(150);
    const stub = "## Note\nSee skill.";
    const well_score = score_compact(well_formed, body);
    const stub_score = score_compact(stub, body);
    expect(well_score.score).toBeGreaterThan(stub_score.score);
  });

  it("test_curated_beats_uncurated", () => {
    const body_with_marker = _MINIMAL_BODY + "\n<!-- COMPACT_END -->";
    const body_without_marker = _MINIMAL_BODY;
    const compact = _make_compact({ headings: 3, fill_lines: 10, rule: true });
    const curated_score = score_compact(compact, body_with_marker);
    const uncurated_score = score_compact(compact, body_without_marker);
    expect(curated_score.score).toBeGreaterThanOrEqual(uncurated_score.score);
  });
});

// ---------------------------------------------------------------------------
// Sub-area G — Edge cases
// ---------------------------------------------------------------------------

describe("TestEdgeCases", () => {
  it("test_empty_compact_returns_zero_score", () => {
    const result = score_compact("", _MINIMAL_BODY);
    expect(result.score).toBeLessThanOrEqual(40);
  });

  it("test_empty_body_does_not_crash", () => {
    const result = score_compact("## Section\nContent.", "");
    expect(result.coverage_ratio).toBeLessThanOrEqual(1.0);
    expect(result).toHaveProperty("score");
  });

  it("test_compact_equals_body_gets_low_score", () => {
    const body = "x".repeat(600);
    const result = score_compact(body, body);
    expect(result.coverage_ratio).toBe(1.0);
    expect(result.issues.join(" ")).toContain("barely smaller");
  });
});
