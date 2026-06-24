/**
 * Tests for dedicated git sub-filters: GitLogFilter, GitDiffFilter,
 * GitStatusVerboseFilter, and GitBlameFilter.
 *
 * 1:1 port of tests/test_bash_compress_git.py. Every Python `def test_*` maps to
 * a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes (TestGitLogFilterDispatch, ...) map to `describe()` blocks of the same
 * name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the git filter classes + select_filter +
 *        the git_diff helper _is_repetitive_json_hunk + the dispatch helpers
 *        _detect_single_segment / try_wrap_compound_segments).
 *  - module-level `_apply(filt, stdout, argv, stderr="")` helper -> local
 *    `_apply(filt, stdout, argv, stderr?)` below; it returns
 *    `filt.apply(stdout, stderr, 0, argv).text` exactly like the Python helper.
 *  - per-class `_make_*` static factory methods -> local module helpers with the
 *    same name (snake_case preserved).
 *  - `json.dumps({...})` in the JSONL fixtures -> a `_pyJsonDumps` helper that
 *    reproduces CPython's default `json.dumps`: keys in dict-insertion order,
 *    `", "` item separator and `": "` key separator, `true`/`false`/`null`
 *    literals. The diff filter only inspects structural shape, but the sample
 *    lines and the `{"ts":` / `"entity"` substring assertions require the exact
 *    spacing CPython emits, so the helper matches it byte-for-byte.
 *
 * Byte-exactness: these filters operate on whole lines and on substring markers
 * ("+30 more commits", "omitted by token-goat", the check-mark glyphs, ...). The
 * assertions are substring / length checks on the returned string, matching the
 * Python `in` / `not in` / `len(...)` checks; where a length ratio is asserted
 * (`len(result) < len(diff) * 0.1`) the TS `.length` on the same UTF-8 source
 * string is the faithful twin (the inputs here are pure ASCII so code-unit
 * length equals byte length for that ratio).
 *
 * Deferral: TailTruncFilter is NOT yet ported (no TS module; the barrel does not
 * export it and is not a catch-all in the seed FILTERS registry — select_filter
 * returns null for unknown tools instead of routing to tail-trunc). The three
 * tests that assert the tail-trunc catch-all behaviour are therefore `it.skip`-ed
 * with a "// PORT: deferred" marker and counted in tests_skipped. They land
 * verbatim when TailTruncFilter is ported and registered as the final catch-all.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  GitLogFilter,
  GitDiffFilter,
  GitStatusVerboseFilter,
  GitBlameFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _apply(
  filt: Filter,
  stdout: string,
  argv: string[],
  stderr = "",
): string {
  return filt.apply(stdout, stderr, 0, argv).text;
}

/**
 * Reproduce CPython's default `json.dumps(obj)` for the flat objects the JSONL
 * fixtures build: keys in insertion order, ", " between items, ": " after each
 * key, and the Python literals for booleans / null. Strings are emitted with
 * JSON.stringify (the test values contain no characters where CPython and JSON
 * escaping diverge).
 */
function _pyJsonDumps(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    let rendered: string;
    if (value === null) {
      rendered = "null";
    } else if (value === true) {
      rendered = "true";
    } else if (value === false) {
      rendered = "false";
    } else if (typeof value === "number") {
      rendered = String(value);
    } else {
      rendered = JSON.stringify(value);
    }
    parts.push(`${JSON.stringify(key)}: ${rendered}`);
  }
  return `{${parts.join(", ")}}`;
}

// ---------------------------------------------------------------------------
// GitLogFilter
// ---------------------------------------------------------------------------

describe("TestGitLogFilterDispatch", () => {
  it("test_registered_before_git_filter", () => {
    const f = bc.select_filter(["git", "log"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-log");
  });

  it("test_does_not_match_other_git_subcommands", () => {
    expect(bc.select_filter(["git", "status"])).not.toBeNull();
    expect(bc.select_filter(["git", "status"])!.name).not.toBe("git-log");
  });

  it("test_does_not_match_non_git", () => {
    const f = new GitLogFilter();
    expect(f.matches(["hg", "log"])).toBe(false);
  });
});

describe("TestGitLogFilterOneline", () => {
  function _make_oneline(n: number): string {
    return Array.from(
      { length: n },
      (_, i) => `abc${String(i).padStart(4, "0")}ef Short commit message ${i}`,
    ).join("\n");
  }

  it("test_short_oneline_passthrough", () => {
    const text = _make_oneline(10);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "--oneline"]);
    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`Short commit message ${i}`);
    }
  });

  it("test_long_oneline_truncated_to_50", () => {
    // --oneline cap is 50 lines (vs 10 for full-format); 80 commits → +30 elided.
    const text = _make_oneline(80);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "--oneline"]);
    expect(result).toContain("+30 more commits");
    expect(result).toContain("abc0000ef"); // first commit kept
    expect(result).not.toContain("abc0079ef"); // last commit elided (beyond cap)
  });

  it("test_oneline_autodetected_without_flag", () => {
    // Heuristic: if every line starts with a short hash it is oneline format.
    // Uses 60 commits to exceed the 50-line --oneline cap.
    const text = _make_oneline(60);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log"]);
    expect(result).toContain("more commits");
  });

  it("test_oneline_49_lines_passthrough", () => {
    // 49 oneline commits (below the 50-cap) pass through without truncation.
    const text = _make_oneline(49);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "--oneline"]);
    // All 49 commits should appear with no truncation marker
    expect(result).not.toContain("more commits");
    for (let i = 0; i < 49; i++) {
      expect(result).toContain(`Short commit message ${i}`);
    }
  });

  it("test_oneline_exactly_50_passthrough", () => {
    // Exactly 50 oneline commits should pass through without truncation.
    const text = _make_oneline(50);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "--oneline"]);
    expect(result).not.toContain("more commits");
  });

  it("test_oneline_51_lines_truncated", () => {
    // 51 oneline commits (just above the 50-cap) triggers truncation.
    const text = _make_oneline(51);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "--oneline"]);
    expect(result).toContain("+1 more commits");
  });
});

describe("TestGitLogFilterFullFormat", () => {
  function _make_commits(n: number): string {
    const blocks: string[] = [];
    for (let i = 0; i < n; i++) {
      blocks.push(
        `commit abc${String(i).padStart(4, "0")}ef1234567890\n` +
          "Author: Dev User <dev@example.com>\n" +
          `Date:   Mon Jan ${String(i + 1).padStart(2, "0")} 10:00:00 2025 +0000\n` +
          "\n" +
          `    Fix bug number ${i}\n`,
      );
    }
    return blocks.join("\n");
  }

  it("test_short_log_passthrough", () => {
    const text = _make_commits(5);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log"]);
    expect(result).toContain("Fix bug number 0");
    expect(result).toContain("Fix bug number 4");
  });

  it("test_long_log_collapsed_to_one_liners", () => {
    const text = _make_commits(20);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log"]);
    // Each commit should now be a condensed entry (no multi-line blocks)
    const lines = result.split("\n").filter((ln) => ln.trim());
    // Collapsed: should have fewer lines than original
    const original_lines = text.split("\n").filter((ln) => ln.trim());
    expect(lines.length).toBeLessThan(original_lines.length);
    // First commit hash should still appear
    expect(result).toContain("abc0000ef");
  });

  it("test_merge_commits_preserved", () => {
    const text = (
      "commit abcdef1234567890\n" +
      "Merge: aaa bbb\n" +
      "Author: User <u@e.com>\n" +
      "Date:   Mon Jan 01 10:00:00 2025 +0000\n" +
      "\n" +
      "    Merge branch feature\n"
    ).repeat(15);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log"]);
    expect(result).toContain("Merge:");
  });
});

describe("TestGitLogFilterPatch", () => {
  function _make_patch_log(n_patch_lines: number): string {
    const diff_lines = Array.from(
      { length: n_patch_lines },
      (_, i) => `+line ${i}`,
    ).join("\n");
    return (
      "commit abcdef1234567890\n" +
      "Author: User <u@e.com>\n" +
      "Date:   Mon Jan 01 10:00:00 2025 +0000\n" +
      "\n" +
      "    Big change\n" +
      "\n" +
      "diff --git a/foo.py b/foo.py\n" +
      "--- a/foo.py\n" +
      "+++ b/foo.py\n" +
      "@@ -1,5 +1,5 @@\n" +
      diff_lines
    );
  }

  it("test_small_patch_passthrough", () => {
    const text = _make_patch_log(10);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "-p"]);
    expect(result).not.toContain("patch: ");
  });

  it("test_large_patch_collapsed", () => {
    const text = _make_patch_log(60);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "-p"]);
    expect(result.includes("patch:") && result.includes("omitted by token-goat")).toBe(true);
  });
});

describe("TestGitLogFilterStat", () => {
  function _make_stat_log(n_files: number): string {
    const stat_lines = Array.from(
      { length: n_files },
      (_, i) => ` src/file${i}.py | 5 +++++`,
    ).join("\n");
    return (
      "commit abcdef1234567890\n" +
      "Author: User <u@e.com>\n" +
      "Date:   Mon Jan 01 10:00:00 2025 +0000\n" +
      "\n" +
      "    Refactor many files\n" +
      "\n" +
      stat_lines +
      `\n ${n_files} files changed, ${n_files * 5} insertions(+)`
    );
  }

  it("test_small_stat_passthrough", () => {
    const text = _make_stat_log(5);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "--stat"]);
    expect(result).toContain("file0.py");
  });

  it("test_large_stat_collapsed", () => {
    const text = _make_stat_log(30);
    const f = new GitLogFilter();
    const result = _apply(f, text, ["git", "log", "--stat"]);
    expect(result).toContain("more stat lines omitted");
  });
});

// ---------------------------------------------------------------------------
// GitDiffFilter
// ---------------------------------------------------------------------------

describe("TestGitDiffFilterDispatch", () => {
  it("test_registered_for_diff", () => {
    const f = bc.select_filter(["git", "diff"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-diff");
  });

  it("test_registered_for_show", () => {
    const f = bc.select_filter(["git", "show"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-diff");
  });

  it("test_does_not_match_git_log", () => {
    const f = bc.select_filter(["git", "log"]);
    expect(f).not.toBeNull();
    expect(f!.name).not.toBe("git-diff");
  });
});

describe("TestGitDiffFilterBinary", () => {
  it("test_binary_file_collapsed_to_summary", () => {
    const text =
      "diff --git a/image.png b/image.png\n" +
      "index abc123..def456 100644\n" +
      "Binary files a/image.png and b/image.png differ\n";
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff"]);
    expect(result).toContain("Binary files a/image.png and b/image.png differ");
    // Index line may be dropped; what matters is the summary survives.
    expect(result).toContain("diff --git a/image.png");
  });

  it("test_non_binary_unchanged", () => {
    const text =
      "diff --git a/foo.py b/foo.py\n" +
      "--- a/foo.py\n" +
      "+++ b/foo.py\n" +
      "@@ -1,3 +1,3 @@\n" +
      "-old\n" +
      "+new\n";
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff"]);
    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });
});

describe("TestGitDiffFilterLargeHunk", () => {
  function _make_large_hunk_diff(n_changed: number): string {
    const hunk_lines = Array.from(
      { length: n_changed },
      (_, i) => `+line ${i}`,
    ).join("\n");
    return (
      "diff --git a/big.py b/big.py\n" +
      "--- a/big.py\n" +
      "+++ b/big.py\n" +
      "@@ -1,100 +1,100 @@\n" +
      " context\n" +
      hunk_lines
    );
  }

  it("test_small_hunk_passthrough", () => {
    const text = _make_large_hunk_diff(10);
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff"]);
    expect(result).not.toContain("lines omitted by token-goat");
  });

  it("test_large_hunk_truncated", () => {
    const text = _make_large_hunk_diff(80);
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff"]);
    expect(result).toContain("omitted by token-goat");
  });

  it("test_header_lines_preserved", () => {
    const text = _make_large_hunk_diff(80);
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff"]);
    expect(result).toContain("diff --git a/big.py");
    expect(result).toContain("--- a/big.py");
    expect(result).toContain("+++ b/big.py");
  });
});

describe("TestGitDiffFilterStat", () => {
  function _make_stat_diff(n_files: number): string {
    const stat_lines = Array.from(
      { length: n_files },
      (_, i) => ` src/module/file${i}.py | ${i + 1} ${"+".repeat(i + 1)}`,
    ).join("\n");
    let adds = 0;
    for (let i = 0; i < n_files; i++) {
      adds += i + 1;
    }
    return stat_lines + `\n ${n_files} files changed, ${adds} insertions(+)`;
  }

  it("test_small_stat_passthrough", () => {
    const text = _make_stat_diff(5);
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff", "--stat"]);
    expect(result).toContain("file0.py");
  });

  it("test_large_stat_dir_rollup", () => {
    // 25 files all under src/ → single rollup line, no individual filenames.
    const text = _make_stat_diff(25);
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff", "--stat"]);
    expect(result).toContain("src/ (25 files,");
    expect(result).not.toContain("file0.py");
    expect(result).not.toContain("file24.py");
  });

  it("test_large_stat_summary_always_present", () => {
    const text = _make_stat_diff(25);
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff", "--stat"]);
    expect(result).toContain("files changed");
  });

  it("test_large_stat_pathspec_truncates_not_rollup", () => {
    // With an explicit pathspec (--) individual file listing is kept (truncated).
    const text = _make_stat_diff(25);
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff", "--stat", "--", "src/"]);
    expect(result).toContain("more files changed");
    expect(result).toContain("file0.py");
    expect(result).not.toContain("src/ (");
  });

  it("test_large_stat_multi_dir_rollup", () => {
    // Files spread across several top-level dirs produce one rollup line each.
    const lines = [
      " alpha/a.py | 3 +++",
      " alpha/b.py | 2 ++",
      " beta/c.py | 5 +++++",
      " beta/d.py | 1 +",
      " gamma/e.py | 4 ++++",
    ];
    const repeated: string[] = [];
    for (let r = 0; r < 5; r++) {
      repeated.push(...lines); // 25 lines, 3 directories
    }
    const summary = " 25 files changed, 75 insertions(+)";
    const text = repeated.join("\n") + "\n" + summary;
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff", "--stat"]);
    expect(result).toContain("alpha/ (");
    expect(result).toContain("beta/ (");
    expect(result).toContain("gamma/ (");
    expect(result).not.toContain("a.py");
  });

  it("test_large_stat_root_files_grouped", () => {
    // Files with no slash in their path go under "(root)".
    const root_files = Array.from(
      { length: 25 },
      (_, i) => ` file${i}.txt | 1 +`,
    );
    const summary = " 25 files changed, 25 insertions(+)";
    const text = root_files.join("\n") + "\n" + summary;
    const f = new GitDiffFilter();
    const result = _apply(f, text, ["git", "diff", "--stat"]);
    expect(result).toContain("(root) (25 files,");
    expect(result).not.toContain("file0.txt");
  });
});

// ---------------------------------------------------------------------------
// GitStatusVerboseFilter
// ---------------------------------------------------------------------------

describe("TestGitStatusVerboseFilterDispatch", () => {
  it("test_registered_for_status", () => {
    const f = bc.select_filter(["git", "status"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-status");
  });
});

describe("TestGitStatusVerboseFilterShort", () => {
  it("test_short_format_passthrough", () => {
    // Short/porcelain format is already compact — passes through unchanged.
    const text = "M  src/foo.py\n" + "?? src/bar.py\n" + "D  src/old.py\n";
    const f = new GitStatusVerboseFilter();
    const result = _apply(f, text, ["git", "status"]);
    expect(result).toContain("src/foo.py");
    expect(result).toContain("src/bar.py");
    expect(result).toContain("src/old.py");
  });
});

describe("TestGitStatusVerboseFilterFull", () => {
  it("test_strips_advice_lines", () => {
    const text =
      "On branch main\n" +
      "Changes not staged for commit:\n" +
      '  (use "git add <file>..." to update what will be committed)\n' +
      '  (use "git restore <file>..." to discard changes in working directory)\n' +
      "\tmodified:   src/foo.py\n" +
      "\n" +
      'no changes added to commit (use "git add" and/or "git commit -a")\n';
    const f = new GitStatusVerboseFilter();
    const result = _apply(f, text, ["git", "status"]);
    // Per-file listing is collapsed to a grouped count; advice is stripped.
    expect(result).toContain("1 modified");
    expect(result).not.toContain("src/foo.py");
    expect(result).not.toContain('use "git add');
    expect(result).not.toContain('use "git restore');
    expect(result).not.toContain("no changes added to commit");
  });

  it("test_nothing_to_commit_preserved", () => {
    const text = "On branch main\n" + "nothing to commit, working tree clean\n";
    const f = new GitStatusVerboseFilter();
    const result = _apply(f, text, ["git", "status"]);
    // The clean-tree signal is the whole point of the command — keep it.
    expect(result).toContain("nothing to commit, working tree clean");
    expect(result).toContain("On branch main");
  });

  it("test_untracked_list_grouped_to_count", () => {
    const files = Array.from(
      { length: 3 },
      (_, i) => `\t    new_file_${i}.py`,
    ).join("\n");
    const text =
      "On branch main\n" +
      "Untracked files:\n" +
      '  (use "git add <file>..." to include in what will be committed)\n' +
      files +
      "\n";
    const f = new GitStatusVerboseFilter();
    const result = _apply(f, text, ["git", "status"]);
    expect(result).toContain("3 untracked");
    expect(result).not.toContain("new_file_0.py");
  });

  it("test_long_untracked_list_grouped_to_count", () => {
    const files = Array.from(
      { length: 15 },
      (_, i) => `\tnew_file_${i}.py`,
    ).join("\n");
    const text =
      "On branch main\n" +
      "Untracked files:\n" +
      '  (use "git add <file>..." to include in what will be committed)\n' +
      files +
      "\n";
    const f = new GitStatusVerboseFilter();
    const result = _apply(f, text, ["git", "status"]);
    expect(result).toContain("15 untracked");
    expect(result).not.toContain("new_file_0.py");
    expect(result).not.toContain("new_file_14.py");
  });
});

// ---------------------------------------------------------------------------
// GitBlameFilter
// ---------------------------------------------------------------------------

describe("TestGitBlameFilterDispatch", () => {
  it("test_registered_for_blame", () => {
    const f = bc.select_filter(["git", "blame"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-blame");
  });

  it("test_does_not_match_other_git_subcommands", () => {
    const f = bc.select_filter(["git", "log"]);
    expect(f).not.toBeNull();
    expect(f!.name).not.toBe("git-blame");
  });
});

describe("TestGitBlameFilterAnnotated", () => {
  // Build annotated blame output with n_lines consecutive lines for one commit.
  function _make_annotated(commit: string, author: string, n_lines: number): string {
    const rows: string[] = [];
    for (let i = 0; i < n_lines; i++) {
      rows.push(
        `${commit} (Author Name ${author} 2025-01-01 10:00:00 +0000 ${i + 1})` +
          `    def function_${i}(): pass`,
      );
    }
    return rows.join("\n");
  }

  it("test_single_commit_run_collapsed", () => {
    const text = _make_annotated("^abc1234", "Alice", 20);
    const f = new GitBlameFilter();
    const result = _apply(f, text, ["git", "blame"]);
    // Only first line kept verbatim; rest collapsed.
    expect(result).toContain("more lines by");
    const lines = result.split("\n").filter((ln) => ln.trim());
    expect(lines.length).toBeLessThan(20);
  });

  it("test_multiple_authors_all_represented", () => {
    const alice_block = _make_annotated("^abc1234", "Alice", 10);
    const bob_block = _make_annotated("^def5678", "Bob", 10);
    const text = alice_block + "\n" + bob_block;
    const f = new GitBlameFilter();
    const result = _apply(f, text, ["git", "blame"]);
    expect(result).toContain("abc1234");
    expect(result).toContain("def5678");
  });

  it("test_short_blame_passthrough", () => {
    // Single line per author block — nothing to collapse.
    const text =
      "^abc1234 (Alice 2025-01-01 10:00:00 +0000  1)    line1\n" +
      "^def5678 (Bob   2025-01-02 10:00:00 +0000  2)    line2\n" +
      "^ghi9012 (Carol 2025-01-03 10:00:00 +0000  3)    line3\n";
    const f = new GitBlameFilter();
    const result = _apply(f, text, ["git", "blame"]);
    // All three hashes should appear.
    expect(result).toContain("abc1234");
    expect(result).toContain("def5678");
    expect(result).toContain("ghi9012");
  });
});

describe("TestGitBlameFilterPorcelain", () => {
  // Build porcelain blame output for n_lines consecutive lines.
  function _make_porcelain(commit: string, author: string, n_lines: number): string {
    const rows: string[] = [];
    for (let i = 0; i < n_lines; i++) {
      const repeated = commit.repeat(Math.trunc(40 / commit.length) + 1).slice(0, 40);
      rows.push(
        `${repeated} ${i + 1} ${i + 1}`,
        `author ${author}`,
        "author-mail <dev@example.com>",
        "author-time 1700000000",
        "author-tz +0000",
        "committer A. Name",
        "committer-mail <c@example.com>",
        "committer-time 1700000000",
        "committer-tz +0000",
        `summary Fix something ${i}`,
        "filename src/module.py",
        `\tcode line ${i}`,
      );
    }
    return rows.join("\n");
  }

  it("test_porcelain_run_collapsed", () => {
    const text = _make_porcelain("abcdef12", "Dev Name", 5);
    const f = new GitBlameFilter();
    const result = _apply(f, text, ["git", "blame", "--porcelain"]);
    // Should be shorter than the original.
    expect(result.split("\n").length).toBeLessThan(text.split("\n").length);
  });
});

// ---------------------------------------------------------------------------
// Integration: filter dispatch consistency
// ---------------------------------------------------------------------------

describe("TestGitFilterFallback", () => {
  // Ensure GitFilter still handles subcommands not claimed by the new filters.

  it("test_git_fetch_still_routes_to_git_filter", () => {
    const f = bc.select_filter(["git", "fetch"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git");
  });

  it("test_git_push_routes_to_git_push_filter", () => {
    const f = bc.select_filter(["git", "push"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-push");
  });

  it("test_git_ls_files_still_routes_to_git_filter", () => {
    const f = bc.select_filter(["git", "ls-files"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git");
  });
});

// ---------------------------------------------------------------------------
// _is_repetitive_json_hunk
// ---------------------------------------------------------------------------

describe("TestIsRepetitiveJsonHunk", () => {
  function _jsonl_hunk(n: number, keys?: Record<string, unknown>): string[] {
    const base = keys ?? { ts: "2026-01-01", entity: "campaign", success: true };
    return Array.from({ length: n }, (_, i) =>
      `+${_pyJsonDumps({ ...base, i })}`,
    );
  }

  it("test_returns_false_for_small_hunk", () => {
    const lines = _jsonl_hunk(5);
    expect(bc._is_repetitive_json_hunk(lines)).toBe(false);
  });

  it("test_returns_true_for_uniform_jsonl", () => {
    const lines = _jsonl_hunk(50);
    expect(bc._is_repetitive_json_hunk(lines)).toBe(true);
  });

  it("test_returns_false_for_plain_code_lines", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `+    result = compute_${i}(x)`,
    );
    expect(bc._is_repetitive_json_hunk(lines)).toBe(false);
  });

  it("test_returns_false_when_key_sets_too_diverse", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      `+${_pyJsonDumps({ ["key_" + String(i)]: i })}`,
    );
    expect(bc._is_repetitive_json_hunk(lines)).toBe(false);
  });

  it("test_returns_false_for_mixed_json_and_code", () => {
    const json_lines = Array.from({ length: 20 }, (_, i) =>
      `+${_pyJsonDumps({ x: i })}`,
    );
    const code_lines = Array.from({ length: 30 }, (_, i) => `+x = ${i}`);
    // Only 40% JSON → below 75% threshold
    expect(bc._is_repetitive_json_hunk([...json_lines, ...code_lines])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitDiffFilter: JSONL hunk → semantic summary
// ---------------------------------------------------------------------------

describe("TestGitDiffFilterJsonlHunk", () => {
  function _make_jsonl_diff(n: number): string {
    const record = {
      ts: "2026-01-01T00:00:00Z",
      entity: "campaign",
      op: "create",
      success: true,
    };
    const added = Array.from({ length: n }, (_, i) =>
      `+${_pyJsonDumps({ ...record, i })}`,
    ).join("\n");
    return (
      "diff --git a/audit.jsonl b/audit.jsonl\n" +
      "--- a/audit.jsonl\n" +
      "+++ b/audit.jsonl\n" +
      "@@ -1,3 +1,100 @@\n" +
      " existing_line\n" +
      added
    );
  }

  it("test_large_jsonl_hunk_gets_semantic_summary", () => {
    const diff = _make_jsonl_diff(100);
    const f = new GitDiffFilter();
    const result = _apply(f, diff, ["git", "diff"]);
    expect(result).toContain("repetitive JSON/JSONL block");
    expect(result).toContain("+100 JSON records added");
  });

  it("test_semantic_summary_includes_sample_lines", () => {
    const diff = _make_jsonl_diff(100);
    const f = new GitDiffFilter();
    const result = _apply(f, diff, ["git", "diff"]);
    // Must include at least one actual JSON line as a sample
    expect(result.includes('{"ts":') || result.includes('"entity"')).toBe(true);
  });

  it("test_semantic_summary_includes_bash_output_hint", () => {
    const diff = _make_jsonl_diff(100);
    const f = new GitDiffFilter();
    const result = _apply(f, diff, ["git", "diff"]);
    expect(result).toContain("bash-output");
  });

  it("test_small_jsonl_hunk_uses_normal_truncation", () => {
    const diff = _make_jsonl_diff(5);
    const f = new GitDiffFilter();
    const result = _apply(f, diff, ["git", "diff"]);
    expect(result).not.toContain("repetitive JSON/JSONL block");
  });

  it("test_diff_header_preserved_in_semantic_summary", () => {
    const diff = _make_jsonl_diff(100);
    const f = new GitDiffFilter();
    const result = _apply(f, diff, ["git", "diff"]);
    expect(result).toContain("diff --git a/audit.jsonl");
  });

  it("test_regression_session_e10faf71_jsonl_pattern", () => {
    // 611-line JSONL append (the pattern that caused the 80% compact failure)
    // is compressed to a semantic summary.
    const record = {
      ts: "2026-06-08T22:46:10.327Z",
      run_id: "local-1780958770327",
      platform: "google_ads",
      entity_type: "campaign",
      operation: "create",
      resource_name: null,
      campaign_name: null,
      before: null,
      after: null,
      module: "TestModule",
      success: true,
    };
    const added = Array.from({ length: 611 }, (_, i) =>
      `+${_pyJsonDumps({ ...record, i })}`,
    ).join("\n");
    const diff =
      "diff --git a/memory/ads/mutation-audit-log.jsonl b/memory/ads/mutation-audit-log.jsonl\n" +
      "--- a/memory/ads/mutation-audit-log.jsonl\n" +
      "+++ b/memory/ads/mutation-audit-log.jsonl\n" +
      "@@ -2403,3 +2403,611 @@\n" +
      " existing_record\n" +
      added;
    const f = new GitDiffFilter();
    const result = _apply(f, diff, ["git", "diff"]);
    expect(result).toContain("repetitive JSON/JSONL block");
    // Result must be dramatically smaller than input
    expect(result.length).toBeLessThan(diff.length * 0.1);
  });
});

// ---------------------------------------------------------------------------
// Compound &&-command wrapping
// ---------------------------------------------------------------------------

describe("TestDetectSingleSegment", () => {
  it("test_detects_git_diff", () => {
    const result = bc._detect_single_segment("git diff");
    expect(result).not.toBeNull();
    const [filter_] = result!;
    expect(filter_.name).toBe("git-diff");
  });

  it("test_detects_git_log", () => {
    const result = bc._detect_single_segment("git log --oneline -5");
    expect(result).not.toBeNull();
    const [filter_] = result!;
    expect(filter_.name).toBe("git-log");
  });

  it("test_rejects_pipe_inside_segment", () => {
    expect(bc._detect_single_segment("git log | head -10")).toBeNull();
  });

  it("test_rejects_semicolon_inside_segment", () => {
    expect(bc._detect_single_segment("git diff; echo done")).toBeNull();
  });

  it("test_rejects_logical_or", () => {
    expect(bc._detect_single_segment("git diff || echo failed")).toBeNull();
  });

  it("test_rejects_command_substitution", () => {
    expect(bc._detect_single_segment("git log $(git rev-parse HEAD)")).toBeNull();
  });

  it.skip("test_unknown_command_routes_to_tail_trunc", () => {
    // PORT: deferred — TailTruncFilter (the catch-all) is not yet ported. In the
    // current seed FILTERS registry select_filter returns null for an
    // unregistered tool, so _detect_single_segment returns null here instead of
    // routing to a TailTruncFilter instance. Lands verbatim when TailTruncFilter
    // is ported and registered as the final catch-all.
  });
});

describe("TestTryWrapCompoundSegments", () => {
  function _wrapper(filter_name: string, seg: string): string | null {
    return `wrapped[${filter_name}](${seg})`;
  }

  it("test_wraps_both_segments", () => {
    const result = bc.try_wrap_compound_segments(
      "git diff && git log --oneline -5",
      { wrapper_args: _wrapper },
    );
    expect(result).not.toBeNull();
    expect(result!).toContain("wrapped[git-diff](git diff)");
    expect(result!).toContain("wrapped[git-log](git log --oneline -5)");
    expect(result!).toContain(" && ");
  });

  it("test_preserves_order", () => {
    const result = bc.try_wrap_compound_segments(
      "git diff && git log --oneline -5",
      { wrapper_args: _wrapper },
    );
    expect(result).not.toBeNull();
    expect(result!.indexOf("git-diff")).toBeLessThan(result!.indexOf("git-log"));
  });

  it.skip("test_unknown_segment_routes_to_tail_trunc", () => {
    // PORT: deferred — TailTruncFilter (the catch-all) is not yet ported. With
    // no catch-all, "echo hello" matches no filter so it is left bare; the
    // Python assertion that it is wrapped as "wrapped[tail-trunc](echo hello)"
    // cannot hold until TailTruncFilter is ported and registered last.
  });

  it.skip("test_all_unknown_segments_route_to_tail_trunc", () => {
    // PORT: deferred — TailTruncFilter (the catch-all) is not yet ported. With
    // no catch-all, an all-unknown compound ("echo foo && echo bar") matches no
    // filter, so try_wrap_compound_segments returns null instead of wrapping
    // each segment with tail-trunc. Lands verbatim when TailTruncFilter ports.
  });

  it("test_returns_none_for_pipe", () => {
    expect(
      bc.try_wrap_compound_segments("git diff | grep foo", { wrapper_args: _wrapper }),
    ).toBeNull();
  });

  it("test_returns_none_for_semicolon", () => {
    expect(
      bc.try_wrap_compound_segments("git diff; git log", { wrapper_args: _wrapper }),
    ).toBeNull();
  });

  it("test_returns_none_for_logical_or", () => {
    expect(
      bc.try_wrap_compound_segments("git diff || git log", { wrapper_args: _wrapper }),
    ).toBeNull();
  });

  it("test_returns_none_for_single_command", () => {
    expect(
      bc.try_wrap_compound_segments("git diff", { wrapper_args: _wrapper }),
    ).toBeNull();
  });

  it("test_three_segment_compound", () => {
    const result = bc.try_wrap_compound_segments(
      "git diff && git log --oneline -5 && git status",
      { wrapper_args: _wrapper },
    );
    expect(result).not.toBeNull();
    const parts = result!.split(" && ");
    expect(parts.length).toBe(3);
  });

  it("test_wrapper_returning_none_leaves_segment_unwrapped", () => {
    function disabled_wrapper(filter_name: string, seg: string): string | null {
      if (filter_name === "git-diff") {
        return null; // simulate disabled filter
      }
      return `wrapped(${seg})`;
    }

    const result = bc.try_wrap_compound_segments(
      "git diff && git log --oneline -5",
      { wrapper_args: disabled_wrapper },
    );
    expect(result).not.toBeNull();
    expect(result!.startsWith("git diff")).toBe(true); // left unwrapped
    expect(result!).toContain("wrapped(git log");
  });

  it("test_all_disabled_returns_none", () => {
    const result = bc.try_wrap_compound_segments(
      "git diff && git log --oneline -5",
      { wrapper_args: () => null }, // all disabled
    );
    expect(result).toBeNull();
  });
});
