/**
 * Tests for skill context savings improvements (iteration 10 boundary).
 *
 * Faithful 1:1 TS port of tests/test_skill_iter10_boundary_improvements.py.
 *
 * Covers three improvements:
 * 1. ``find_markdown_boundary`` (cache_common): cuts compact text at a markdown
 *    heading or paragraph boundary rather than a raw byte position.
 * 2. Large-body warning in ``hooks_skill.post_skill``: when a skill body exceeds
 *    32 KB and has no ``<!-- COMPACT_END -->`` marker, a WARNING is written to
 *    stderr.
 * 3. Compact budget truncation in ``hooks_skill.post_skill`` uses
 *    ``find_markdown_boundary`` instead of ``rfind("\\n")``.
 *
 * Porting notes:
 *  - find_markdown_boundary(text, max_chars, min_keep=K) -> the TS signature is
 *    find_markdown_boundary(text, max_chars, { min_keep: K }).
 *  - Python str slicing counts code points; the texts here are all ASCII, so
 *    `text[:result]` == `text.slice(0, result)`.
 *  - patch("sys.stderr", StringIO()) -> vi.spyOn(process.stderr, "write") which
 *    accumulates the written chunks (hooks_skill writes warnings via
 *    process.stderr.write, matching Python's sys.stderr.write).
 *  - patch("token_goat.config.load") -> vi.spyOn(config, "load") returning a
 *    fake config whose `.skill_preservation` is the chosen cfg.
 *  - tmp_data_dir is auto-applied per test by setup.ts.
 *  - The Python "capture store_compact via side_effect" test uses
 *    patch.object(sc_mod, "store_compact"); here we vi.spyOn(skill_cache,
 *    "store_compact") and forward to the real implementation while recording.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as config from "../src/token_goat/config.js";
import { find_markdown_boundary } from "../src/token_goat/cache_common.js";
import type {
  ConfigSchema,
  SkillPreservationConfig,
} from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spy config.load() to return a fake config with the given skill_preservation. */
function patchConfig(cfg: SkillPreservationConfig): void {
  vi.spyOn(config, "load").mockReturnValue({
    skill_preservation: cfg,
  } as ConfigSchema);
}

/** Spy process.stderr.write, accumulating written text; returns a getter. */
function captureStderr(): () => string {
  let buf = "";
  vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array): boolean => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  );
  return () => buf;
}

function utf8Len(s: string): number {
  return Buffer.from(s, "utf8").length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Improvement 1: find_markdown_boundary helper
// ---------------------------------------------------------------------------

describe("TestFindMarkdownBoundary", () => {
  function _fmb(text: string, max_chars: number, kw: { min_keep?: number } = {}): number {
    return find_markdown_boundary(text, max_chars, kw);
  }

  // --- basic heading priority ---

  it("test_cuts_before_last_heading", () => {
    // Use min_keep=5 to allow the heading at pos 21 to qualify.
    const text = "## Intro\n\nSome text.\n\n## Section 2\nMore content here.";
    const result = _fmb(text, 40, { min_keep: 5 });
    const kept = text.slice(0, result);
    expect(kept.endsWith("\n")).toBe(true);
    expect(kept.includes("## Section 2")).toBe(false);
  });

  it("test_heading_cut_includes_newline", () => {
    const text = "First paragraph.\n\n## Next Heading\nBody.";
    const result = _fmb(text, "First paragraph.\n\n## Next Heading".length, {
      min_keep: 5,
    });
    const kept = text.slice(0, result);
    expect(kept.includes("#")).toBe(false);
  });

  // --- paragraph break priority (when no heading in window) ---

  it("test_falls_back_to_paragraph_break", () => {
    const text = "Line one.\n\nLine two.\n\nLine three extra padding.";
    const result = _fmb(text, 25, { min_keep: 5 });
    const kept = text.slice(0, result);
    expect(kept.endsWith("\n")).toBe(true);
  });

  it("test_paragraph_break_preferred_over_plain_newline", () => {
    const text = "Para one.\n\nPara two line1\nline2 here.";
    const result = _fmb(text, 30, { min_keep: 5 });
    const kept = text.slice(0, result);
    expect(text.slice(0, result).includes("\n\n") || kept.endsWith("\n")).toBe(true);
  });

  // --- plain newline fallback ---

  it("test_falls_back_to_plain_newline", () => {
    const text = "Line one here\nLine two here\nLine three.";
    const result = _fmb(text, 28, { min_keep: 5 });
    const kept = text.slice(0, result);
    expect(kept.endsWith("\n")).toBe(true);
  });

  // --- hard cut fallback ---

  it("test_hard_cut_when_no_boundary_in_min_keep_range", () => {
    const text = "Nospacehere".repeat(50); // no newlines at all
    const result = _fmb(text, 40);
    expect(result).toBe(40);
  });

  // --- min_keep guard ---

  it("test_min_keep_prevents_tiny_slice", () => {
    const text =
      "ab\n# Heading\nLots of content after the heading that fills the window more.";
    const result = _fmb(text, 70);
    expect(result).toBe(70);
  });

  it("test_min_keep_override", () => {
    const text = "ab\n# Heading\nLots of content.";
    const result = _fmb(text, 20, { min_keep: 2 });
    const kept = text.slice(0, result);
    expect(kept.includes("# Heading")).toBe(false);
    expect(result).toBeGreaterThan(2);
  });

  // --- idempotence / boundary conditions ---

  it("test_text_shorter_than_max_chars", () => {
    const text = "Short text.";
    const result = _fmb(text, 500);
    expect(result).toBeLessThanOrEqual(500);
  });

  it("test_empty_text", () => {
    expect(_fmb("", 0)).toBe(0);
    expect(_fmb("", 10)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: large-body warning in hooks_skill.post_skill
// ---------------------------------------------------------------------------

describe("TestLargeBodyWarning", () => {
  const _LARGE_BODY_THRESHOLD = 32_768; // 32 KB

  function _make_payload(skill_name: string, body: string): Record<string, unknown> {
    return {
      tool_name: "Skill",
      tool_input: { skill: skill_name },
      tool_response: { output: body },
      session_id: "test-session-warn",
      cwd: "/tmp",
    };
  }

  function _large_body_no_marker(size = 33_000): string {
    const base = "# Large Skill\n\n## Section One\n\n";
    const filler =
      "This is a line of skill content that fills space. ".repeat(20) + "\n";
    let body = base;
    while (utf8Len(body) < size) {
      body += filler;
    }
    return body;
  }

  function _large_body_with_marker(size = 33_000): string {
    const base =
      "# Large Skill\n\n## Quick Ref\n\nKey rules here.\n\n<!-- COMPACT_END -->\n\n";
    const filler = "Extended reference content. ".repeat(20) + "\n";
    let body = base;
    while (utf8Len(body) < size) {
      body += filler;
    }
    return body;
  }

  it("test_warning_emitted_for_large_body_without_marker", () => {
    const body = _large_body_no_marker(_LARGE_BODY_THRESHOLD + 1000);
    expect(body.includes("COMPACT_END")).toBe(false);
    expect(utf8Len(body)).toBeGreaterThan(_LARGE_BODY_THRESHOLD);

    const payload = _make_payload("large-skill", body);
    const getStderr = captureStderr();

    const cfg_sp: SkillPreservationConfig = { enabled: true };
    patchConfig(cfg_sp);
    hooks_skill.post_skill(payload);

    const warning_text = getStderr();
    expect(warning_text.includes("token-goat warning")).toBe(true);
    expect(warning_text.includes("large-skill")).toBe(true);
    expect(warning_text.includes("COMPACT_END")).toBe(true);
  });

  it("test_no_warning_for_large_body_with_marker", () => {
    const body = _large_body_with_marker(_LARGE_BODY_THRESHOLD + 1000);
    expect(body.includes("COMPACT_END")).toBe(true);

    const payload = _make_payload("has-marker-skill", body);
    const getStderr = captureStderr();

    const cfg_sp: SkillPreservationConfig = { enabled: true };
    patchConfig(cfg_sp);
    hooks_skill.post_skill(payload);

    const warning_text = getStderr();
    // The large-body warning uniquely contains "KB but has no".
    expect(warning_text.includes("KB but has no")).toBe(false);
  });

  it("test_no_warning_for_small_body", () => {
    const body = "# Small Skill\n\nJust a few lines.\nNot very large.\n";
    expect(utf8Len(body)).toBeLessThan(_LARGE_BODY_THRESHOLD);

    const payload = _make_payload("small-skill", body);
    const getStderr = captureStderr();

    const cfg_sp: SkillPreservationConfig = { enabled: true };
    patchConfig(cfg_sp);
    hooks_skill.post_skill(payload);

    const warning_text = getStderr();
    expect(warning_text.includes("KB but has no")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: compact budget truncation uses markdown boundary
// ---------------------------------------------------------------------------

describe("TestCompactBudgetMarkdownBoundary", () => {
  function _make_multi_section_body(): string {
    const sections: string[] = [];
    for (let i = 0; i < 10; i++) {
      const heading = `## Section ${i}`;
      const rules: string[] = [];
      for (let j = 0; j < 15; j++) {
        rules.push(
          `CRITICAL: Rule ${j} in section ${i} — always follow this guideline carefully.`,
        );
      }
      sections.push(`${heading}\n\n${rules.join("\n")}`);
    }
    const body =
      "# Multi-Section Skill\n\n" +
      sections.join("\n\n") +
      "\n\nFiller. ".repeat(200);
    expect(utf8Len(body)).toBeGreaterThan(4000);
    return body;
  }

  it("test_compact_ends_before_heading_when_truncated", (ctx) => {
    const body = _make_multi_section_body();
    const compact = skill_cache.generate_compact_summary(body);
    expect(compact).toBeTruthy();

    // Simulate a very tight budget (100 tokens = 400 chars) to force truncation.
    const budget_tokens = 100;
    const budget_chars = budget_tokens * 4;

    if (compact.length <= budget_chars) {
      ctx.skip();
      return;
    }

    let cut = find_markdown_boundary(compact, budget_chars);
    if (cut <= 0) {
      cut = budget_chars;
    }
    const truncated = compact.slice(0, cut).replace(/\s+$/u, "") + "…";

    expect(
      truncated
        .replace(/…+$/u, "")
        .replace(/\s+$/u, "")
        .endsWith("#"),
    ).toBe(false);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("test_compact_budget_cut_via_hook", (ctx) => {
    const body = _make_multi_section_body();

    // Verify the auto-compact would be > 400 chars (budget=100 tokens × 4 chars).
    const raw_compact = skill_cache.generate_compact_summary(body);
    if (!raw_compact || raw_compact.length <= 400) {
      ctx.skip();
      return;
    }

    const cfg_sp: SkillPreservationConfig = {
      enabled: true,
      truncation_budget_tokens: 100,
    };

    const stored_compacts: string[] = [];
    const realStoreCompact = skill_cache.store_compact;
    vi.spyOn(skill_cache, "store_compact").mockImplementation(
      (
        session_id: string,
        skill_name: string,
        text: string,
        source_sha: string | null = null,
      ): void => {
        stored_compacts.push(text);
        realStoreCompact(session_id, skill_name, text, source_sha);
      },
    );

    const payload = {
      tool_name: "Skill",
      tool_input: { skill: "multi-section" },
      tool_response: { output: body },
      session_id: "test-session-boundary",
      cwd: "/tmp",
    };

    patchConfig(cfg_sp);
    hooks_skill.post_skill(payload);

    expect(stored_compacts.length).toBeGreaterThan(0);
    const stored = stored_compacts[0]!;

    // Budget = 100 tokens × 4 chars = 400 chars. Stored compact must be
    // at most 400 chars + the '…' suffix (1 char).
    expect(stored.length).toBeLessThanOrEqual(401);
    expect(stored.endsWith("…")).toBe(true);
  });
});
