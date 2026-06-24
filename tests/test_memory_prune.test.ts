/**
 * Tests for token_goat.memory_prune — 1:1 port of tests/test_memory_prune.py.
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_path fixture → a per-test throwaway dir built from fs.mkdtempSync under
 *    os.tmpdir(), wrapped in fs.realpathSync so the path matches the canonical
 *    /private/var realpath on macOS (memory_prune does not do project-containment
 *    checks, but realpath keeps the fixtures consistent with the rest of the
 *    suite). The dir is cleaned up in afterEach.
 *  - Path arguments → string paths (the TS port takes string paths, not Path).
 *  - dataclass field access (result.changed, entry.target, ...) → class instance
 *    field access; tuple unpacking in comprehensions → array destructuring.
 *  - keyword arg `dry_run=True` → opts object `{ dry_run: true }`.
 *  - keyword arg `threshold=` → opts object `{ threshold: ... }` (defaulted here).
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity. The Python TestX classes map to describe() blocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  audit_claude_md,
  find_content_duplicates,
  parse_index,
  prune_index,
} from "../src/token_goat/memory_prune.js";

// ---------------------------------------------------------------------------
// Per-test tmp_path.
// ---------------------------------------------------------------------------

let tmp_path: string;
const _madeDirs: string[] = [];

beforeEach(() => {
  // realpathSync: pytest's tmp_path is already a realpath; mirror that so the
  // fixtures are consistent with the rest of the suite (macOS /var symlink).
  tmp_path = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-memprune-")));
  _madeDirs.push(tmp_path);
});

afterEach(() => {
  for (const d of _madeDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Create a memory directory with MEMORY.md and optional sibling files.
 *
 * *entries* is a list of [filename, body_or_null]. When body is null the file is
 * NOT created on disk (simulates a dead link).
 */
function _make_memory_dir(
  tmp: string,
  entries: Array<[string, string | null]>,
  opts: { extra_header?: string } = {},
): string {
  const extra_header = opts.extra_header ?? "";
  const mem_dir = path.join(tmp, "memory");
  fs.mkdirSync(mem_dir);

  const lines: string[] = ["# Memory — test\n", "\n"];
  for (const [fname, body] of entries) {
    lines.push(`- [${fname}](${fname}) — hook text for ${fname}\n`);
    if (body !== null) {
      fs.writeFileSync(
        path.join(mem_dir, fname),
        `---\nname: ${fname}\ndescription: desc\nmetadata:\n  type: feedback\n---\n${body}\n`,
        "utf8",
      );
    }
  }

  if (extra_header) {
    lines.unshift(extra_header + "\n");
  }

  fs.writeFileSync(path.join(mem_dir, "MEMORY.md"), lines.join(""), "utf8");
  return mem_dir;
}

// ---------------------------------------------------------------------------
// parse_index
// ---------------------------------------------------------------------------

describe("TestParseIndex", () => {
  it("test_parses_entries", () => {
    const text = "# Header\n\n- [Title](foo.md) — hook\n- [Other](bar.md) — hook2\n";
    const [, entries] = parse_index(text);
    expect(entries.length).toBe(2);
    expect(entries[0]!.target).toBe("foo.md");
    expect(entries[0]!.title).toBe("Title");
    expect(entries[1]!.target).toBe("bar.md");
  });

  it("test_passthrough_preserves_non_entries", () => {
    const text = "# Header\n\nsome note\n- [X](x.md) — hook\n";
    const [passthrough, entries] = parse_index(text);
    const pt_lines = passthrough.map(([, line]) => line);
    expect(pt_lines).toContain("# Header\n");
    expect(pt_lines).toContain("some note\n");
    expect(entries.length).toBe(1);
  });

  it("test_empty_file", () => {
    const [, entries] = parse_index("");
    expect(entries).toEqual([]);
  });

  it("test_no_entries", () => {
    const text = "# Just a header\n\nSome prose.\n";
    const [passthrough, entries] = parse_index(text);
    expect(entries).toEqual([]);
    expect(passthrough.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// prune_index — dead links
// ---------------------------------------------------------------------------

describe("TestPruneIndexDeadLinks", () => {
  it("test_removes_dead_link", () => {
    const mem_dir = _make_memory_dir(tmp_path, [
      ["alive.md", "body"],
      ["dead.md", null],
    ]);
    const result = prune_index(mem_dir);
    expect(result.changed).toBe(true);
    expect(result.removed_dead.length).toBe(1);
    expect(result.removed_dead[0]!.target).toBe("dead.md");
    expect(result.kept).toBe(1);

    const remaining = fs.readFileSync(path.join(mem_dir, "MEMORY.md"), "utf8");
    expect(remaining).toContain("alive.md");
    expect(remaining).not.toContain("dead.md");
  });

  it("test_no_op_when_all_alive", () => {
    const mem_dir = _make_memory_dir(tmp_path, [
      ["a.md", "body"],
      ["b.md", "body"],
    ]);
    const result = prune_index(mem_dir);
    expect(result.changed).toBe(false);
    expect(result.removed_dead).toEqual([]);
  });

  it("test_missing_memory_md_returns_no_op", () => {
    const empty_dir = path.join(tmp_path, "memory");
    fs.mkdirSync(empty_dir);
    const result = prune_index(empty_dir);
    expect(result.changed).toBe(false);
  });

  it("test_dry_run_does_not_write", () => {
    const mem_dir = _make_memory_dir(tmp_path, [
      ["alive.md", "body"],
      ["gone.md", null],
    ]);
    const original = fs.readFileSync(path.join(mem_dir, "MEMORY.md"), "utf8");
    const result = prune_index(mem_dir, { dry_run: true });
    expect(result.changed).toBe(true);
    expect(result.removed_dead.length).toBe(1);
    expect(fs.readFileSync(path.join(mem_dir, "MEMORY.md"), "utf8")).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// prune_index — exact-duplicate targets
// ---------------------------------------------------------------------------

describe("TestPruneIndexDuplicates", () => {
  it("test_removes_exact_dup_target", () => {
    const mem_dir = path.join(tmp_path, "memory");
    fs.mkdirSync(mem_dir);
    fs.writeFileSync(path.join(mem_dir, "real.md"), "body", "utf8");
    // Two index lines pointing to the same file.
    const text = "# Header\n\n- [First](real.md) — hook\n- [Second](real.md) — hook2\n";
    fs.writeFileSync(path.join(mem_dir, "MEMORY.md"), text, "utf8");

    const result = prune_index(mem_dir);
    expect(result.changed).toBe(true);
    expect(result.removed_dup.length).toBe(1);
    expect(result.kept).toBe(1);

    const remaining = fs.readFileSync(path.join(mem_dir, "MEMORY.md"), "utf8");
    expect((remaining.match(/real\.md/g) ?? []).length).toBe(1);
  });

  it("test_keeps_first_of_duplicates", () => {
    const mem_dir = path.join(tmp_path, "memory");
    fs.mkdirSync(mem_dir);
    fs.writeFileSync(path.join(mem_dir, "f.md"), "body", "utf8");
    const text = "# H\n\n- [First](f.md) — keep\n- [Second](f.md) — drop\n";
    fs.writeFileSync(path.join(mem_dir, "MEMORY.md"), text, "utf8");

    prune_index(mem_dir);
    const remaining = fs.readFileSync(path.join(mem_dir, "MEMORY.md"), "utf8");
    expect(remaining).toContain("keep");
    expect(remaining).not.toContain("drop");
  });
});

// ---------------------------------------------------------------------------
// prune_index — header + freeform line preservation
// ---------------------------------------------------------------------------

describe("TestPruneIndexPreservesStructure", () => {
  it("test_preserves_header_and_blank_lines", () => {
    const mem_dir = _make_memory_dir(tmp_path, [
      ["a.md", "body"],
      ["dead.md", null],
    ]);
    const result = prune_index(mem_dir);
    expect(result.changed).toBe(true);
    const remaining = fs.readFileSync(path.join(mem_dir, "MEMORY.md"), "utf8");
    expect(remaining.startsWith("# Memory")).toBe(true);
  });

  it("test_preserves_freeform_note", () => {
    const mem_dir = path.join(tmp_path, "memory");
    fs.mkdirSync(mem_dir);
    fs.writeFileSync(path.join(mem_dir, "a.md"), "body", "utf8");
    const text = "# H\n\nsome note line\n- [A](a.md) — hook\n- [Dead](dead.md) — hook\n";
    fs.writeFileSync(path.join(mem_dir, "MEMORY.md"), text, "utf8");

    const result = prune_index(mem_dir);
    expect(result.changed).toBe(true);
    const remaining = fs.readFileSync(path.join(mem_dir, "MEMORY.md"), "utf8");
    expect(remaining).toContain("some note line");
  });
});

// ---------------------------------------------------------------------------
// prune_index — tokens_saved
// ---------------------------------------------------------------------------

describe("TestPruneIndexTokensSaved", () => {
  it("test_tokens_saved_positive_when_changed", () => {
    const mem_dir = _make_memory_dir(tmp_path, [
      ["a.md", "body"],
      ["gone.md", null],
    ]);
    const result = prune_index(mem_dir);
    expect(result.changed).toBe(true);
    expect(result.tokens_saved).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// audit_claude_md
// ---------------------------------------------------------------------------

describe("TestAuditClaudeMd", () => {
  it("test_detects_exact_dup_lines", () => {
    const p = path.join(tmp_path, "CLAUDE.md");
    fs.writeFileSync(p, "# Title\n\nDuplicated line.\nOther line.\nDuplicated line.\n", "utf8");
    const reports = audit_claude_md([p]);
    expect(reports.length).toBe(1);
    expect(reports[0]!.exact_dup_lines.some(([, , t]) => t.includes("Duplicated line."))).toBe(true);
  });

  it("test_detects_dup_sections", () => {
    const p = path.join(tmp_path, "CLAUDE.md");
    fs.writeFileSync(p, "## Rules\n\nsome text\n\n## Rules\n\nmore text\n", "utf8");
    const reports = audit_claude_md([p]);
    expect(reports[0]!.dup_sections.some(([h]) => h === "## Rules")).toBe(true);
  });

  it("test_detects_cross_file_overlap", () => {
    const p1 = path.join(tmp_path, "global.md");
    const p2 = path.join(tmp_path, "project.md");
    const shared = "Always run tests before committing.";
    fs.writeFileSync(p1, `# G\n\n${shared}\n`, "utf8");
    fs.writeFileSync(p2, `# P\n\n${shared}\nOther stuff.\n`, "utf8");
    const reports = audit_claude_md([p1, p2]);
    const overlaps = reports.map((r) => r.cross_file_overlaps);
    expect(overlaps.some((o) => o.length > 0)).toBe(true);
  });

  it("test_missing_file_skipped", () => {
    const missing = path.join(tmp_path, "nonexistent.md");
    const reports = audit_claude_md([missing]);
    expect(reports).toEqual([]);
  });

  it("test_no_issues_returns_clean_report", () => {
    const p = path.join(tmp_path, "CLAUDE.md");
    fs.writeFileSync(p, "# Title\n\nUnique line A.\nUnique line B.\n", "utf8");
    const reports = audit_claude_md([p]);
    expect(reports.length).toBe(1);
    expect(reports[0]!.exact_dup_lines).toEqual([]);
    expect(reports[0]!.dup_sections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// find_content_duplicates (Jaccard fallback, no fastembed required)
// ---------------------------------------------------------------------------

describe("TestFindContentDuplicates", () => {
  it("test_no_clusters_for_distinct_content", () => {
    const mem_dir = path.join(tmp_path, "memory");
    fs.mkdirSync(mem_dir);
    const bodies = ["alpha beta gamma delta", "one two three four five six seven eight"];
    for (let i = 0; i < bodies.length; i++) {
      const p = path.join(mem_dir, `mem_${i}.md`);
      fs.writeFileSync(
        p,
        `---\nname: m${i}\ndescription: desc${i}\nmetadata:\n  type: feedback\n---\n${bodies[i]}\n`,
        "utf8",
      );
    }
    const clusters = find_content_duplicates(mem_dir);
    // Distinct content → no clusters (Jaccard well below 0.60).
    expect(clusters).toEqual([]);
  });

  it("test_detects_near_identical", () => {
    const mem_dir = path.join(tmp_path, "memory");
    fs.mkdirSync(mem_dir);
    const body = "use haiku for simple tasks and sonnet for complex implementations always";
    for (let i = 0; i < 2; i++) {
      const p = path.join(mem_dir, `mem_${i}.md`);
      fs.writeFileSync(
        p,
        `---\nname: m${i}\ndescription: model selection\nmetadata:\n  type: feedback\n---\n${body}\n`,
        "utf8",
      );
    }
    const clusters = find_content_duplicates(mem_dir);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it("test_single_file_returns_empty", () => {
    const mem_dir = path.join(tmp_path, "memory");
    fs.mkdirSync(mem_dir);
    fs.writeFileSync(path.join(mem_dir, "only.md"), "body", "utf8");
    const clusters = find_content_duplicates(mem_dir);
    expect(clusters).toEqual([]);
  });
});
