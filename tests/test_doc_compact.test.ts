/**
 * Tests for doc_compact: extractive compact builder, sidecar lifecycle, and
 * hook integration. 1:1 port of tests/test_doc_compact.py.
 *
 * Test-seam mapping (Python → TS):
 *  - patch("token_goat.paths.data_dir", return_value=tmp_data_dir)
 *      → no-op here: setup.ts already overrides paths.dataDir() to a per-test
 *        throwaway dir, so `paths.dataDir()` IS the tmp_data_dir. The Python
 *        tests double-patch (the tmp_data_dir fixture + an explicit patch);
 *        both reduce to "doc_compacts sidecars land under an isolated data dir",
 *        which setup.ts guarantees. Source files (the Python `tmp_path`) are
 *        written under a SEPARATE per-test tmp dir created via makeTmpPath().
 *  - hashlib.sha256(src.read_bytes()).hexdigest()
 *      → crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex").
 *  - Path equality / p.name.endswith
 *      → string equality / path.basename(p).endsWith. compact_path_for returns
 *        a deterministic string so equality holds byte-for-byte.
 *  - tmp_path fixture → makeTmpPath() (fs.mkdtempSync under os.tmpdir()).
 *
 * Deferred test classes (depend on not-yet-ported modules):
 *  - TestBuildDocCompactHint   → token_goat.hints   (deferred to a later layer)
 *  - TestHandleDocCompact      → token_goat.hooks_read (deferred to a later layer)
 *    Each test in those classes is written as it.skip with a one-line PORT note
 *    and counted in tests_skipped.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import * as doc_compact from "../src/token_goat/doc_compact.js";

// ---------------------------------------------------------------------------
// Per-test helpers.
// ---------------------------------------------------------------------------

/** Create a fresh throwaway dir, the TS analogue of pytest's `tmp_path`. */
function makeTmpPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-dc-"));
}

/** sha256 hex of a file's bytes (Python hashlib.sha256(p.read_bytes()).hexdigest()). */
function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// ---------------------------------------------------------------------------
// build_extractive_compact
// ---------------------------------------------------------------------------

describe("TestBuildExtractiveCompact", () => {
  it("test_emits_headings", () => {
    const text = "# Title\n\nSome content here.\n\n## Section\n\nMore content.\n";
    const result = doc_compact.build_extractive_compact(text);
    expect(result).toContain("# Title");
    expect(result).toContain("## Section");
  });

  it("test_extracts_first_n_sentences_per_section", () => {
    const text = "# H1\n\nLine 1.\nLine 2.\nLine 3.\n";
    const result = doc_compact.build_extractive_compact(text, { max_sentences: 2 });
    expect(result).toContain("Line 1.");
    expect(result).toContain("Line 2.");
    expect(result).not.toContain("Line 3.");
  });

  it("test_skips_yaml_frontmatter", () => {
    const text = "---\ntitle: Foo\ndate: 2024-01-01\n---\n\n# Heading\n\nReal content.\n";
    const result = doc_compact.build_extractive_compact(text);
    expect(result).not.toContain("title: Foo");
    expect(result).toContain("# Heading");
    expect(result).toContain("Real content.");
  });

  it("test_includes_code_block_up_to_10_lines", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i}`);
    const codeBlock = "```\n" + lines.join("\n") + "\n```\n";
    const text = "# Code\n\n" + codeBlock;
    const result = doc_compact.build_extractive_compact(text, { max_sentences: 5 });
    expect(result).toContain("line0");
    // opening fence counts as one slot, so 9 content lines (0-8) fit in the limit
    expect(result).toContain("line8");
    expect(result).not.toContain("line9");
    expect(result).not.toContain("line14");
  });

  it("test_no_duplicate_blank_lines", () => {
    const text = "# A\n\n\n\n## B\n\n\n\nContent.\n";
    const result = doc_compact.build_extractive_compact(text);
    expect(result).not.toContain("\n\n\n");
  });

  it("test_empty_document", () => {
    const result = doc_compact.build_extractive_compact("");
    expect(typeof result).toBe("string");
  });

  it("test_document_with_no_headings", () => {
    const text = "Just some plain text.\nNo headings at all.\n";
    const result = doc_compact.build_extractive_compact(text);
    // Plain text before any heading is not collected
    expect(typeof result).toBe("string");
  });

  it("test_result_ends_with_newline", () => {
    const text = "# H\n\nContent.\n";
    const result = doc_compact.build_extractive_compact(text);
    expect(result.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compact_path_for and find_compact_for_path
// ---------------------------------------------------------------------------

describe("TestCompactPaths", () => {
  it("test_compact_path_for_is_deterministic", () => {
    const p1 = doc_compact.compact_path_for("/some/file.md", "projhash123");
    const p2 = doc_compact.compact_path_for("/some/file.md", "projhash123");
    expect(p1).toBe(p2);
  });

  it("test_compact_path_ends_with_compact_md", () => {
    const p = doc_compact.compact_path_for("/some/file.md", "projhash123");
    expect(path.basename(p).endsWith(".compact.md")).toBe(true);
  });

  it("test_different_files_yield_different_paths", () => {
    const p1 = doc_compact.compact_path_for("/some/file.md", "projhash123");
    const p2 = doc_compact.compact_path_for("/other/file.md", "projhash123");
    expect(p1).not.toBe(p2);
  });

  it("test_find_compact_for_path_returns_none_when_absent", () => {
    const result = doc_compact.find_compact_for_path("/nonexistent/file.md", "proj123");
    expect(result).toBeNull();
  });

  it("test_find_compact_for_path_returns_path_when_present", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "doc.md");
    fs.writeFileSync(src, "# Doc\n\nContent.\n", "utf8");
    const cpath = doc_compact.compact_path_for(src, "proj123");
    fs.mkdirSync(path.dirname(cpath), { recursive: true });
    const sha = sha256File(src);
    fs.writeFileSync(
      cpath,
      `<!-- token-goat doc-compact source-hash:${sha} source:doc.md -->\n# Doc\n\nContent.\n`,
      "utf8",
    );
    const result = doc_compact.find_compact_for_path(src, "proj123");
    expect(result).toBe(cpath);
  });
});

// ---------------------------------------------------------------------------
// write_compact / read_compact_body / read_compact_header
// ---------------------------------------------------------------------------

describe("TestWriteReadCompact", () => {
  it("test_write_then_read_body_roundtrip", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "api.md");
    fs.writeFileSync(src, "# API\n\nReference.\n", "utf8");
    const cpath = doc_compact.compact_path_for(src, "proj42");
    doc_compact.write_compact(cpath, src, "# API\n\nCompact body.\n", { source_rel: "api.md" });
    const body = doc_compact.read_compact_body(cpath);
    expect(body).not.toBeNull();
    expect(body!).toContain("Compact body.");
  });

  it("test_header_contains_source_hash_and_path", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "ref.md");
    fs.writeFileSync(src, "# Ref\n", "utf8");
    const cpath = doc_compact.compact_path_for(src, "projX");
    doc_compact.write_compact(cpath, src, "body\n", { source_rel: "ref.md" });
    const header = doc_compact.read_compact_header(cpath);
    expect(header).not.toBeNull();
    const [storedHash, sourceRel] = header!;
    expect(storedHash).toBe(sha256File(src));
    expect(sourceRel).toBe("ref.md");
  });

  it("test_read_compact_header_returns_none_for_bad_format", () => {
    const tmpPath = makeTmpPath();
    const bad = path.join(tmpPath, "bad.compact.md");
    fs.writeFileSync(bad, "not a valid header\nbody\n", "utf8");
    expect(doc_compact.read_compact_header(bad)).toBeNull();
  });

  it("test_read_compact_body_returns_none_for_missing_file", () => {
    const tmpPath = makeTmpPath();
    expect(doc_compact.read_compact_body(path.join(tmpPath, "nope.compact.md"))).toBeNull();
  });

  it("test_read_compact_body_returns_none_for_header_only", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "empty.md");
    fs.writeFileSync(src, "# H\n", "utf8");
    const cpath = doc_compact.compact_path_for(src, "proj0");
    doc_compact.write_compact(cpath, src, "", { source_rel: "empty.md" });
    const body = doc_compact.read_compact_body(cpath);
    expect(body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// is_compact_fresh
// ---------------------------------------------------------------------------

describe("TestIsCompactFresh", () => {
  function writeFresh(src: string, cpath: string): void {
    const sha = sha256File(src);
    fs.mkdirSync(path.dirname(cpath), { recursive: true });
    fs.writeFileSync(
      cpath,
      `<!-- token-goat doc-compact source-hash:${sha} source:${path.basename(src)} -->\n# H\n`,
      "utf8",
    );
  }

  it("test_fresh_compact_returns_true", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "doc.md");
    fs.writeFileSync(src, "# Doc\n\nContent.\n", "utf8");
    const cpath = path.join(tmpPath, "doc.compact.md");
    writeFresh(src, cpath);
    expect(doc_compact.is_compact_fresh(cpath, src)).toBe(true);
  });

  it("test_stale_after_source_change", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "doc.md");
    fs.writeFileSync(src, "# Doc\n\nOriginal.\n", "utf8");
    const cpath = path.join(tmpPath, "doc.compact.md");
    writeFresh(src, cpath);
    fs.writeFileSync(src, "# Doc\n\nModified.\n", "utf8");
    expect(doc_compact.is_compact_fresh(cpath, src)).toBe(false);
  });

  it("test_stale_marker_returns_false", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "doc.md");
    fs.writeFileSync(src, "# Doc\n", "utf8");
    const cpath = path.join(tmpPath, "doc.compact.md");
    fs.writeFileSync(
      cpath,
      "<!-- token-goat doc-compact source-hash:STALE source:doc.md -->\nbody\n",
      "utf8",
    );
    expect(doc_compact.is_compact_fresh(cpath, src)).toBe(false);
  });

  it("test_missing_compact_returns_false", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "doc.md");
    fs.writeFileSync(src, "# Doc\n", "utf8");
    expect(doc_compact.is_compact_fresh(path.join(tmpPath, "nope.compact.md"), src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mark_compact_stale
// ---------------------------------------------------------------------------

describe("TestMarkCompactStale", () => {
  it("test_marks_stale", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "guide.md");
    fs.writeFileSync(src, "# Guide\n", "utf8");
    const cpath = doc_compact.compact_path_for(src, "projS");
    doc_compact.write_compact(cpath, src, "body\n", { source_rel: "guide.md" });
    expect(doc_compact.is_compact_fresh(cpath, src)).toBe(true);
    const result = doc_compact.mark_compact_stale(cpath);
    expect(result).toBe(true);
    expect(doc_compact.is_compact_fresh(cpath, src)).toBe(false);
    const header = doc_compact.read_compact_header(cpath);
    expect(header).not.toBeNull();
    expect(header![0]).toBe("STALE");
  });

  it("test_already_stale_returns_false", () => {
    const tmpPath = makeTmpPath();
    const cpath = path.join(tmpPath, "already.compact.md");
    fs.writeFileSync(
      cpath,
      "<!-- token-goat doc-compact source-hash:STALE source:x.md -->\nbody\n",
      "utf8",
    );
    expect(doc_compact.mark_compact_stale(cpath)).toBe(false);
  });

  it("test_missing_compact_returns_false", () => {
    const tmpPath = makeTmpPath();
    expect(doc_compact.mark_compact_stale(path.join(tmpPath, "ghost.compact.md"))).toBe(false);
  });

  it("test_body_preserved_after_marking_stale", () => {
    const tmpPath = makeTmpPath();
    const src = path.join(tmpPath, "ref.md");
    fs.writeFileSync(src, "# Ref\n", "utf8");
    const cpath = doc_compact.compact_path_for(src, "projP");
    doc_compact.write_compact(cpath, src, "# Preserved body\n", { source_rel: "ref.md" });
    doc_compact.mark_compact_stale(cpath);
    const body = doc_compact.read_compact_body(cpath);
    expect(body).not.toBeNull();
    expect(body!).toContain("Preserved body");
  });
});

// ---------------------------------------------------------------------------
// build_doc_compact_hint (hint layer) — DEFERRED: depends on token_goat.hints
// ---------------------------------------------------------------------------

describe("TestBuildDocCompactHint", () => {
  // PORT: deferred — token_goat.hints not yet ported.
  it.skip("test_returns_none_for_small_file", () => {});
  // PORT: deferred — token_goat.hints not yet ported.
  it.skip("test_returns_none_for_non_markdown", () => {});
  // PORT: deferred — token_goat.hints not yet ported.
  it.skip("test_returns_serve_sentinel_when_fresh_compact_exists", () => {});
  // PORT: deferred — token_goat.hints not yet ported.
  it.skip("test_returns_advisory_hint_for_stale_compact", () => {});
  // PORT: deferred — token_goat.hints + token_goat.config interplay not yet ported.
  it.skip("test_returns_none_when_config_disabled", () => {});
});

// ---------------------------------------------------------------------------
// _handle_doc_compact hook integration — DEFERRED: depends on hooks_read
// ---------------------------------------------------------------------------

describe("TestHandleDocCompact", () => {
  // PORT: deferred — token_goat.hooks_read not yet ported.
  it.skip("test_returns_none_for_small_file", () => {});
  // PORT: deferred — token_goat.hooks_read not yet ported.
  it.skip("test_deny_redirect_for_fresh_compact", () => {});
  // PORT: deferred — token_goat.hooks_read not yet ported.
  it.skip("test_non_deny_for_stale_compact", () => {});
});
