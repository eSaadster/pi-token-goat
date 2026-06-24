/**
 * Tests for LsFilter — ls/eza/ll/dir directory listing compression.
 *
 * 1:1 port of tests/test_bash_compress_ls_filter.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes (TestLsFilterPassthrough, TestLsFilterTruncation,
 * TestLsFilterMultiSection, TestLsFilterDispatch,
 * TestLsFilterSectionHeaderEdgeCases, TestLsFilterExtensionGrouping) map to
 * `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports LsFilter + select_filter + FILTERS).
 *  - Each Python test calls `f.compress(output, "", 0, argv)` directly and
 *    reads the returned string (compress() returns the body directly, NOT a
 *    CompressedOutput — unlike apply()). The TS port mirrors this exactly:
 *    `const result = f.compress(output, "", 0, argv);` and assertions on
 *    `result` (a plain string).
 *  - `bc.LsFilter().matches(argv)` returns boolean -> truthy/falsy checks.
 *  - The Python `@pytest.mark.parametrize("argv", [...])` over 5 binaries is
 *    unrolled into 5 separate `it()` calls (one per argv) to keep parity with
 *    how the rest of the suite ports parameterised cases.
 *  - The module-private `_MARKER_PREFIX = "[token-goat:"` is reproduced here
 *    as a local const (the framework does not export it).
 *
 * Byte-exactness: the assertions are substring `in` / `not in` / `.count(...)`
 * checks plus `.splitlines()` index lookups and a marker-index guard via
 * `next(i for ...)`. The fixtures are pure ASCII, so Python `len` (code
 * points) equals JS `.length` equals the UTF-8 byte count — no Buffer
 * arithmetic is needed. `.splitlines()` is reproduced via a local shim that
 * matches CPython str.splitlines() (splits on \r, \r\n, \n, and the rare
 * Unicode terminators); the framework's LsFilter.compress() routes its own
 * raw-output split through the same semantics.
 *
 * U+00D7 (×) is the multiplication sign used in the by-type extension
 * summary — safe inside string literals (NOT U+2028/2029).
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { LsFilter, select_filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local constants / helpers (port of the Python module-level fixtures).
// ---------------------------------------------------------------------------

const _MARKER_PREFIX = "[token-goat:";

/**
 * Build a fake `ls -la` output with n_entries permission lines. Mirrors the
 * Python `_make_long_listing(n_entries, *, total_line=True)` helper.
 */
function _make_long_listing(n_entries: number, total_line = true): string {
  const lines: string[] = [];
  if (total_line) {
    lines.push("total 128");
  }
  for (let i = 0; i < n_entries; i += 1) {
    // Python f"{i:03d}" -> zero-pad to width 3.
    const name = String(i).padStart(3, "0");
    lines.push(`-rw-r--r-- 1 user group 1024 Jan  1 00:00 file${name}.txt`);
  }
  return lines.join("\n");
}

/** Python str.splitlines() — see the framework shim for full semantics. */
function _splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const out: string[] = [];
  let cur = "";
  const n = s.length;
  for (let i = 0; i < n; i += 1) {
    const ch = s[i]!;
    const cc = s.charCodeAt(i);
    if (ch === "\n") {
      out.push(cur);
      cur = "";
    } else if (ch === "\r") {
      out.push(cur);
      cur = "";
      if (i + 1 < n && s[i + 1] === "\n") {
        i += 1;
      }
    } else if (
      cc === 0x0b ||
      cc === 0x0c ||
      cc === 0x1c ||
      cc === 0x1d ||
      cc === 0x1e ||
      cc === 0x85 ||
      cc === 0x2028 ||
      cc === 0x2029
    ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") {
    out.push(cur);
  }
  return out;
}

/** Python `next(i for i, ln in enumerate(lines) if needle in ln)` — throws if absent. */
function _firstMarkerIdx(lines: string[], needle: string): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.includes(needle)) {
      return i;
    }
  }
  throw new Error(`no line contains "${needle}"`);
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
// 1. Short listing passes through unchanged — TestLsFilterPassthrough
// ===========================================================================

describe("TestLsFilterPassthrough", () => {
  it("test_short_listing_unchanged", () => {
    // Output with <=25 lines is returned verbatim.
    const output = _make_long_listing(20, true);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    expect(result).toBe(output);
  });

  it("test_exactly_25_lines_passthrough", () => {
    // Exactly 25 lines is the boundary — must pass through.
    const lines = Array.from({ length: 25 }, (_v, i) => `file${i}`);
    const output = lines.join("\n");
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls"]);
    expect(result).toBe(output);
  });

  it("test_empty_output_passthrough", () => {
    // Empty stdout/stderr returns empty string without error.
    const f = new LsFilter();
    const result = f.compress("", "", 0, ["ls"]);
    expect(result).toBe("");
  });
});

// ===========================================================================
// 2. Long listing is truncated — TestLsFilterTruncation
// ===========================================================================

describe("TestLsFilterTruncation", () => {
  it("test_long_listing_produces_marker", () => {
    // Output >25 lines includes the count marker.
    const output = _make_long_listing(30, false);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    expect(result).toContain(_MARKER_PREFIX);
  });

  it("test_total_line_preserved", () => {
    // The `total N` disk-usage line is always kept.
    const output = _make_long_listing(30, true);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    expect(result.startsWith("total 128")).toBe(true);
  });

  it("test_first_10_entries_kept", () => {
    // Exactly 10 entry lines appear before the marker.
    const output = _make_long_listing(30, false);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    const lines = _splitlines(result);
    const marker_idx = _firstMarkerIdx(lines, _MARKER_PREFIX);
    expect(marker_idx).toBe(10);
  });

  it("test_marker_count_is_correct", () => {
    // Marker reports the correct number of hidden entries.
    const n_entries = 35;
    const output = _make_long_listing(n_entries, false);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    const hidden = n_entries - 10;
    expect(result).toContain(`${hidden} more entries`);
  });

  it("test_total_line_not_counted_as_entry", () => {
    // `total N` does not consume one of the 10 kept entry slots.
    const output = _make_long_listing(15, true);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    // 1 total line + 15 entries = 16 lines > 25? No — 16 <= 25, passes through.
    expect(result).toBe(output);
  });

  it("test_total_line_plus_many_entries", () => {
    // With total line + 30 entries (31 lines total), exactly 10 entries kept.
    const output = _make_long_listing(30, true);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    const lines = _splitlines(result);
    expect(lines[0]).toBe("total 128");
    const marker_idx = _firstMarkerIdx(lines, _MARKER_PREFIX);
    // 1 total + 10 entries + marker
    expect(marker_idx).toBe(11);
  });
});

// ===========================================================================
// 3. Multi-section output — TestLsFilterMultiSection
// ===========================================================================

describe("TestLsFilterMultiSection", () => {
  // Python nested helper `_make_multi_section(self, n_entries_each)`.
  function _make_multi_section(n_entries_each: number): string {
    const section = (name: string): string => {
      const entries = Array.from(
        { length: n_entries_each },
        (_v, i) => `-rw-r--r-- 1 u g 0 Jan 1 file${i}`,
      );
      return `${name}:\ntotal 8\n` + entries.join("\n");
    };
    return section("./dir1") + "\n\n" + section("./dir2");
  }

  it("test_section_headers_preserved", () => {
    // Directory section headers (`./dir1:`) are kept in output.
    const output = _make_multi_section(20);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la", "dir1", "dir2"]);
    expect(result).toContain("./dir1:");
    expect(result).toContain("./dir2:");
  });

  it("test_per_section_truncation", () => {
    // Each section is truncated independently — both markers present.
    const output = _make_multi_section(20);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la", "dir1", "dir2"]);
    expect(_count(result, _MARKER_PREFIX)).toBe(2);
  });
});

// ===========================================================================
// 4. Binary / dispatch checks — TestLsFilterDispatch
// ===========================================================================

describe("TestLsFilterDispatch", () => {
  // Python @pytest.mark.parametrize over 5 argv lists — unrolled into 5 it()s.

  it("test_matches_ls_binaries [ls -la]", () => {
    expect(new LsFilter().matches(["ls", "-la"])).toBeTruthy();
  });

  it("test_matches_ls_binaries [ls -alh]", () => {
    expect(new LsFilter().matches(["ls", "-alh"])).toBeTruthy();
  });

  it("test_matches_ls_binaries [eza --git --long]", () => {
    expect(new LsFilter().matches(["eza", "--git", "--long"])).toBeTruthy();
  });

  it("test_matches_ls_binaries [ll]", () => {
    expect(new LsFilter().matches(["ll"])).toBeTruthy();
  });

  it("test_matches_ls_binaries [dir]", () => {
    expect(new LsFilter().matches(["dir"])).toBeTruthy();
  });

  it("test_select_filter_routes_ls", () => {
    const f = select_filter(["ls", "-la"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("ls");
  });

  it("test_select_filter_routes_eza", () => {
    const f = select_filter(["eza", "--long"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("ls");
  });
});

// ===========================================================================
// TestLsFilterSectionHeaderEdgeCases
// ===========================================================================

describe("TestLsFilterSectionHeaderEdgeCases", () => {
  it("test_filename_with_colon_not_misidentified_as_section_header", () => {
    // A file named 'file:annotation' must not be mistaken for a section header.
    // 3-line listing: total line + 2 entries, one filename containing a colon.
    const output =
      "total 8\n" +
      "-rw-r--r-- 1 user group 100 Jan  1 file:annotation\n" +
      "-rw-r--r-- 1 user group 200 Jan  1 notes.txt";
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    // 3 lines is well under the 25-line passthrough threshold — output unchanged.
    expect(result).toBe(output);
  });
});

// ===========================================================================
// 5. Extension grouping in truncation marker — TestLsFilterExtensionGrouping
// ===========================================================================

describe("TestLsFilterExtensionGrouping", () => {
  // Python staticmethod `_make_mixed_listing(counts: dict[str, int])`.
  function _make_mixed_listing(counts: Record<string, number>): string {
    const lines: string[] = [];
    for (const [ext, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i += 1) {
        const fname = ext !== "" ? `file${i}${ext}` : `Makefile${i}`;
        lines.push(`-rw-r--r-- 1 u g 0 Jan 1 ${fname}`);
      }
    }
    return lines.join("\n");
  }

  it("test_by_type_label_in_marker", () => {
    // Truncated listing >=47 files includes 'by type:' in the marker.
    const output = _make_mixed_listing({ ".py": 18, ".js": 12, ".ts": 8, ".json": 5, ".csv": 4 });
    expect(_count(output, "\n") + 1).toBe(47);
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls"]);
    expect(result).toContain("by type:");
    // U+00D7 multiplication sign — safe inside a string literal.
    expect(result).toContain(".py×18");
    expect(result).toContain(".js×12");
  });

  it("test_top_4_extensions_plus_other", () => {
    // Only top 4 extensions appear by name; the rest are bucketed as other×N.
    const output = _make_mixed_listing({
      ".py": 10,
      ".js": 8,
      ".ts": 6,
      ".json": 4,
      ".txt": 3,
      ".md": 2,
    });
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls"]);
    expect(result).toContain("by type:");
    // Top-4 by count: .py .js .ts .json; remaining .txt(3)+.md(2)=5 → other×5
    expect(result).toContain("other×5");
    // .txt and .md must NOT appear as named extensions in the summary section
    const summary_part = result.includes("by type:") ? result.split("by type:").slice(-1)[0] : "";
    expect(summary_part).not.toContain(".txt");
    expect(summary_part).not.toContain(".md");
  });

  it("test_directories_excluded_from_ext_count", () => {
    // Directory entries (leading 'd' permissions) do not appear in ext summary.
    const lines: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push(`drwxr-xr-x 2 u g 0 Jan 1 subdir${i}/`);
    }
    for (let i = 0; i < 15; i += 1) {
      lines.push(`-rw-r--r-- 1 u g 0 Jan 1 module${i}.py`);
    }
    const output = lines.join("\n");
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls", "-la"]);
    expect(result).toContain("by type:");
    // Only .py files counted — directories contribute nothing.
    expect(result).toContain(".py×15");
  });

  it("test_no_extension_counted_as_other", () => {
    // Files with no extension (Makefile, LICENSE, etc.) count as other×N.
    const lines = Array.from(
      { length: 30 },
      (_v, i) => `-rw-r--r-- 1 u g 0 Jan 1 Makefile${i}`,
    );
    const output = lines.join("\n");
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls"]);
    expect(result).toContain("other×30");
  });

  it("test_still_shows_10_entries_before_marker", () => {
    // Extension grouping does not reduce the 10-entry truncation window.
    const lines = Array.from(
      { length: 30 },
      (_v, i) => `-rw-r--r-- 1 u g 0 Jan 1 file${i}.py`,
    );
    const output = lines.join("\n");
    const f = new LsFilter();
    const result = f.compress(output, "", 0, ["ls"]);
    const result_lines = _splitlines(result);
    const marker_idx = _firstMarkerIdx(result_lines, "[token-goat:");
    expect(marker_idx).toBe(10);
  });
});
