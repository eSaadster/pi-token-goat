/**
 * Tests for TreeFilter — tree command output compression.
 *
 * 1:1 port of tests/test_bash_compress_tree_filter.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes (TestTreeFilterPassthrough,
 * TestTreeFilterDetect, TestTreeFilterCompression) map to `describe()`
 * blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports TreeFilter + select_filter + FILTERS).
 *  - Each Python test calls `f.compress(output, "", 0, ["tree"])` directly and
 *    reads the returned string (compress() returns the body directly, NOT a
 *    CompressedOutput — unlike apply()). The TS port mirrors this exactly.
 *  - `f.detect(lines)` is an INSTANCE method returning boolean -> strict
 *    `toBe(true)` / `toBe(false)` (the Python asserts use `is True` / `is False`).
 *
 * Helpers: `_make_tree(top_dirs, subdirs_each, files_each, *, summary=True)`
 * and `_shallow_tree(n_files)` are ported verbatim. They build synthetic tree
 * output with three levels of depth. The box-drawing characters used
 * (├── U+251C, └── U+2514, │ U+2502, ─ U+2500) are NOT U+2028/2029 line
 * terminators — they are safe inside JS string literals and do not desync the
 * TS compiler's line counter.
 *
 * Byte-exactness: assertions are substring `in` / `not in` / `.count(...)`
 * checks. Fixtures use box-drawing characters (multi-byte UTF-8) but the
 * assertions only ever compare substrings or counts of ASCII-derived markers
 * (`[N items]`, `file0.py`, `directories,`), so Python `len` (code points)
 * equals JS `.length` for every value under test.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { TreeFilter, select_filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// helpers (port of the Python module-level `_make_tree` / `_shallow_tree`).
// ---------------------------------------------------------------------------

// Box-drawing glyphs used to construct synthetic tree output. These are
// U+251C/U+2514/U+2502/U+2500 (NOT U+2028/2029) and are safe inside JS string
// literals — they do NOT terminate lines and do NOT desync the TS line counter.
const _TEE = "├── "; // mid-sibling connector
const _ELBOW = "└── "; // last-sibling connector
const _VBAR = "│   "; // vertical continuation
const _BLANK = "    "; // last-sibling continuation indent

/**
 * Build synthetic tree output with three levels of depth.
 *
 * Structure:
 *   .
 *   ├── topdir0/            <- depth 1 (kept)
 *   │   ├── subdir0/        <- depth 2 (kept)
 *   │   │   ├── file0.py    <- depth 3 (collapsed)
 *   │   │   └── file1.py    <- depth 3 (collapsed)
 *   │   └── subdir1/        <- depth 2 (kept)
 *   │       └── file0.py    <- depth 3 (collapsed)
 *   └── topdir1/            <- depth 1 (kept)
 *       ...
 */
function _make_tree(
  top_dirs: number,
  subdirs_each: number,
  files_each: number,
  summary = true,
): string {
  const lines: string[] = ["."];
  for (let t = 0; t < top_dirs; t += 1) {
    const is_last_top = t === top_dirs - 1;
    const top_conn = is_last_top ? _ELBOW : _TEE;
    const top_cont = is_last_top ? _BLANK : _VBAR;
    lines.push(`${top_conn}topdir${t}/`);
    for (let s = 0; s < subdirs_each; s += 1) {
      const is_last_sub = s === subdirs_each - 1;
      const sub_conn = is_last_sub ? _ELBOW : _TEE;
      const sub_cont = is_last_sub ? _BLANK : _VBAR;
      lines.push(`${top_cont}${sub_conn}subdir${s}/`);
      for (let f = 0; f < files_each; f += 1) {
        const is_last_file = f === files_each - 1;
        const file_conn = is_last_file ? _ELBOW : _TEE;
        lines.push(`${top_cont}${sub_cont}${file_conn}file${f}.py`);
      }
    }
  }
  const total_dirs = top_dirs * (1 + subdirs_each);
  const total_files = top_dirs * subdirs_each * files_each;
  if (summary) {
    lines.push(`\n${total_dirs} directories, ${total_files} files`);
  }
  return lines.join("\n");
}

/** Build a shallow tree (depth 1 only) with n_files entries. */
function _shallow_tree(n_files: number): string {
  const lines: string[] = ["."];
  for (let i = 0; i < n_files; i += 1) {
    const conn = i === n_files - 1 ? _ELBOW : _TEE;
    lines.push(`${conn}file${i}.py`);
  }
  lines.push(`\n0 directories, ${n_files} files`);
  return lines.join("\n");
}

/** Python str.count(sub) — non-overlapping count. */
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// ===========================================================================
// 1. Short tree passthrough — TestTreeFilterPassthrough
// ===========================================================================

describe("TestTreeFilterPassthrough", () => {
  it("test_short_tree_unchanged", () => {
    // Tree output with <=30 lines is returned verbatim.
    const output = _shallow_tree(20);
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    expect(result).toBe(output);
  });

  it("test_exactly_30_lines_passthrough", () => {
    // Exactly 30 lines is the boundary — must pass through unchanged.
    // Build a clean 30-line tree with no trailing blank to avoid normalisation drift.
    const lines = ["."].concat(
      Array.from({ length: 29 }, (_v, i) => `${i < 28 ? _TEE : _ELBOW}file${i}.py`),
    );
    const output30 = lines.join("\n");
    // Sanity: mirrors the Python `assert len(output30.splitlines()) == 30`.
    const split_count = output30 === "" ? 0 : output30.split(/\r\n|\r|\n/).length;
    expect(split_count).toBe(30);
    const f = new TreeFilter();
    const result = f.compress(output30, "", 0, ["tree"]);
    expect(result).toBe(output30);
  });

  it("test_empty_tree_passthrough", () => {
    // A tree with only root and summary passes through.
    const output = ".\n\n0 directories, 0 files";
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    expect(result).toBe(output);
  });
});

// ===========================================================================
// 2. detect() method — TestTreeFilterDetect
// ===========================================================================

describe("TestTreeFilterDetect", () => {
  it("test_detect_true_for_tree_output", () => {
    // detect() returns True when lines contain tree connector characters.
    const lines = [".", "├── src/", "│   └── main.py", "└── README.md"];
    const f = new TreeFilter();
    expect(f.detect(lines)).toBe(true);
  });

  it("test_detect_false_for_ls_output", () => {
    // detect() returns False for plain ls -la output.
    const lines = [
      "total 128",
      "-rw-r--r-- 1 user group 1024 Jan  1 file.py",
      "-rw-r--r-- 1 user group 2048 Jan  1 README.md",
    ];
    const f = new TreeFilter();
    expect(f.detect(lines)).toBe(false);
  });

  it("test_detect_false_for_empty", () => {
    // detect() returns False for empty input.
    const f = new TreeFilter();
    expect(f.detect([])).toBe(false);
  });
});

// ===========================================================================
// 3. Deep tree compression — TestTreeFilterCompression
// ===========================================================================

describe("TestTreeFilterCompression", () => {
  it("test_deep_tree_collapses_depth3_items", () => {
    // Items at depth >=3 are replaced with '[N items]' markers.
    const output = _make_tree(3, 2, 5);
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    expect(result.includes("[") && result.includes("items]")).toBe(true);
    // Original depth-3 filenames must not appear in compressed output.
    expect(result).not.toContain("file0.py");
  });

  it("test_depth2_items_kept", () => {
    // Items at depth 1 and 2 are preserved verbatim.
    const output = _make_tree(3, 2, 5);
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    expect(result).toContain("topdir0/");
    expect(result).toContain("subdir0/");
  });

  it("test_summary_line_always_kept", () => {
    // The 'N directories, M files' summary line is always present in output.
    const output = _make_tree(3, 2, 5);
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    expect(result).toContain("directories,");
    expect(result).toContain("files");
  });

  it("test_collapse_count_accurate", () => {
    // The [N items] count matches the number of depth-3 entries under each parent.
    // 1 topdir × 6 subdirs × 4 files = 34 lines (> 30 threshold).
    const output = _make_tree(1, 6, 4);
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    // Every subdir has 4 depth-3 files → every marker shows [4 items].
    expect(result).toContain("[4 items]");
  });

  it("test_multiple_parents_independent_counts", () => {
    // Each depth-2 parent gets its own accurate [N items] count.
    // 4 topdirs × 2 subdirs × 3 files = 43 lines (> 30 threshold).
    const output = _make_tree(4, 2, 3);
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    // 8 total subdirs each with 3 depth-3 files → 8 markers of [3 items].
    expect(_count(result, "[3 items]")).toBe(8);
  });

  it("test_tree_without_summary_still_compresses", () => {
    // Compression works even when there is no 'N directories, M files' line.
    const output = _make_tree(3, 2, 5, false);
    const f = new TreeFilter();
    const result = f.compress(output, "", 0, ["tree"]);
    expect(result).toContain("items]");
    expect(result).not.toContain("file0.py");
  });

  it("test_binary_dispatch_routes_tree", () => {
    // select_filter(['tree']) returns the TreeFilter instance.
    const flt = select_filter(["tree"]);
    expect(flt).not.toBeNull();
    expect(flt!.name).toBe("tree");
  });
});
