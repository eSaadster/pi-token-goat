/**
 * Tests for GitCommitFilter and GitPushFilter.
 *
 * 1:1 port of tests/test_bash_compress_git_commit_push.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes map to `describe()` blocks of the same
 * name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the ported git filters + select_filter,
 *        and re-exports _strip_git_crlf_warnings from framework and
 *        _PYTEST_DOT_LINE_RE from the git module).
 *  - module-level `_apply(filt, stdout, argv, stderr="", exit_code=0)` helper
 *      -> a local `_apply(...)` with the identical signature/defaults; it runs
 *        `filt.apply(stdout, stderr, exit_code, argv).text`.
 *
 * Byte-exactness: these filters operate on whole lines and on UTF-8 marker
 * glyphs (the lefthook check/cross marks, the box-drawing banner). The
 * "much shorter than input" assertions compare Python `len(str)` which counts
 * UNICODE CODE POINTS, not bytes — so they map to JS `[...str].length`
 * (Array.from over code points), NOT `str.length` (UTF-16 units) and NOT
 * Buffer byte length. Every fixture here is BMP except the emoji 🥊 and the
 * box-drawing/check glyphs; 🥊 is a surrogate pair so the code-point count
 * diverges from .length, hence the explicit code-point counting helper.
 *
 * No test here needs a not-yet-ported filter, so nothing is skipped.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  GitCommitFilter,
  GitPushFilter,
  GitFilter,
  GenericFilter,
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
  exit_code = 0,
): string {
  return filt.apply(stdout, stderr, exit_code, argv).text;
}

/**
 * Python len(str) counts Unicode code points; JS str.length counts UTF-16
 * units (surrogate pairs count as 2). The "much shorter than input" tests use
 * Python's len(), so count code points to preserve parity.
 */
function _len(s: string): number {
  return [...s].length;
}

// ===========================================================================
// GitCommitFilter — dispatch
// ===========================================================================

describe("TestGitCommitFilterDispatch", () => {
  it("test_registered_before_git_filter", () => {
    const f = bc.select_filter(["git", "commit", "-m", "msg"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-commit");
  });

  it("test_does_not_match_git_push", () => {
    const f = bc.select_filter(["git", "push"]);
    expect(f).not.toBeNull();
    expect(f!.name).not.toBe("git-commit");
  });

  it("test_does_not_match_non_git", () => {
    const f = new GitCommitFilter();
    expect(f.matches(["hg", "commit"])).toBe(false);
  });

  it("test_does_not_match_git_log", () => {
    const f = new GitCommitFilter();
    expect(f.matches(["git", "log"])).toBe(false);
  });
});

// ===========================================================================
// GitCommitFilter — lefthook commit compressed to 1 line
// ===========================================================================

const _LEFTHOOK_COMMIT_OUTPUT = `╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
All checks passed!
┃  wal-guard ❯
bringing up nodes...
....
4 passed in 4.58s
  ────────────────────────────────────
summary: (done in 5.37 seconds)
✔️ lint (0.11 seconds)
✔️ wal-guard (5.21 seconds)
[main d112339] feat(bash-cache): normalize command strings
 2 files changed, 238 insertions(+), 1 deletion(-)`;

describe("TestGitCommitFilterLefthook", () => {
  it("test_lefthook_passing_compressed_to_one_line", () => {
    const f = new GitCommitFilter();
    const result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"]);
    // Must be a single line (no unescaped newlines within the payload)
    const lines = result.split("\n").filter((ln) => ln.trim());
    expect(lines.length).toBe(1);
  });

  it("test_lefthook_passing_contains_hook_checkmarks", () => {
    const f = new GitCommitFilter();
    const result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"]);
    expect(result).toContain("lint");
    expect(result).toContain("wal-guard");
    expect(result).toContain("✔");
  });

  it("test_lefthook_passing_contains_commit_ref", () => {
    const f = new GitCommitFilter();
    const result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"]);
    expect(result).toContain("d112339");
    expect(result).toContain("feat(bash-cache)");
  });

  it("test_lefthook_passing_contains_files_changed", () => {
    const f = new GitCommitFilter();
    const result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"]);
    expect(result).toContain("2 files changed");
  });

  it("test_lefthook_passing_much_shorter_than_input", () => {
    const f = new GitCommitFilter();
    const result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"]);
    expect(_len(result)).toBeLessThan(Math.floor(_len(_LEFTHOOK_COMMIT_OUTPUT) / 2));
  });

  it("test_lefthook_failing_hook_preserves_error", () => {
    const failing_output = `╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
error: some lint error on line 42
  ────────────────────────────────────
summary: (done in 1.23 seconds)
✖ lint (1.20 seconds)
✔️ wal-guard (0.03 seconds)`;
    const f = new GitCommitFilter();
    const result = _apply(f, failing_output, ["git", "commit", "-m", "msg"]);
    // Error message must be preserved
    expect(result).toContain("lint error on line 42");
  });

  it("test_no_lefthook_passthrough", () => {
    const simple_output = "[main d112339] feat: simple commit\n 1 file changed, 5 insertions(+)";
    const f = new GitCommitFilter();
    const result = _apply(f, simple_output, ["git", "commit", "-m", "msg"]);
    expect(result).toContain("d112339");
    expect(result).toContain("1 file changed");
  });
});

// ===========================================================================
// Fixtures shared across GitPushFilter remote-progress tests
// ===========================================================================

// Realistic small push: 5 lines of intermediate progress per stage (each stage
// would be 100 lines in a real large-repo push — here we use 5 to keep the
// fixture readable while still exercising the compression path).
const _REMOTE_PROGRESS_SMALL = `Enumerating objects: 5, done.
Counting objects:   0% (1/5)
Counting objects:  20% (1/5)
Counting objects:  40% (2/5)
Counting objects:  60% (3/5)
Counting objects:  80% (4/5)
Counting objects: 100% (5/5), done.
Delta compression using up to 8 threads
Compressing objects:  33% (1/3)
Compressing objects:  67% (2/3)
Compressing objects: 100% (3/3), done.
Writing objects:  33% (1/3)
Writing objects:  67% (2/3)
Writing objects: 100% (3/3), 1.02 KiB | 1.02 MiB/s, done.
Total 3 (delta 1), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas:   0% (0/1)
remote: Resolving deltas: 100% (1/1), completed with 1 local object.
remote:\x20
remote: Create a pull request for 'feat/new' on GitHub by visiting:
remote:   https://github.com/owner/repo/pull/new/feat/new
remote:\x20
To github.com:owner/repo.git
   7f3a1b2..9c4d5e6  feat/new -> feat/new`;

// Simulate large push: 100 intermediate lines per stage → ~400 lines total
const _REMOTE_PROGRESS_LARGE = (() => {
  const _lines: string[] = ["Enumerating objects: 1234, done."];
  for (let _pct = 0; _pct <= 100; _pct += 1) {
    _lines.push(`Counting objects: ${_pct}% (${_pct * 10}/1000)`);
  }
  _lines.push("Counting objects: 100% (1000/1000), done.");
  _lines.push("Delta compression using up to 16 threads");
  for (let _pct = 0; _pct <= 100; _pct += 1) {
    _lines.push(`Compressing objects: ${_pct}% (${_pct * 8}/800)`);
  }
  _lines.push("Compressing objects: 100% (800/800), done.");
  for (let _pct = 0; _pct <= 100; _pct += 1) {
    _lines.push(`Writing objects: ${_pct}% (${_pct * 10}/1000)`);
  }
  _lines.push("Writing objects: 100% (1000/1000), 12.34 MiB | 5.00 MiB/s, done.");
  _lines.push("Total 1000 (delta 500), reused 0 (delta 0), pack-reused 0");
  for (let _pct = 0; _pct <= 100; _pct += 1) {
    _lines.push(`remote: Resolving deltas: ${_pct}% (${_pct * 5}/500)`);
  }
  _lines.push("remote: Resolving deltas: 100% (500/500), completed with 200 local objects.");
  _lines.push("remote: ");
  _lines.push("remote: Create a pull request for 'main' on GitHub by visiting:");
  _lines.push("remote:   https://github.com/owner/repo/pull/new/main");
  _lines.push("remote: ");
  _lines.push("To github.com:owner/repo.git");
  _lines.push("   abc1234..def5678  main -> main");
  return _lines.join("\n");
})();

// ===========================================================================
// GitPushFilter — dispatch
// ===========================================================================

describe("TestGitPushFilterDispatch", () => {
  it("test_registered_before_git_filter", () => {
    const f = bc.select_filter(["git", "push"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-push");
  });

  it("test_does_not_match_git_commit", () => {
    const f = bc.select_filter(["git", "commit", "-m", "x"]);
    expect(f).not.toBeNull();
    expect(f!.name).not.toBe("git-push");
  });

  it("test_does_not_match_non_git", () => {
    const f = new GitPushFilter();
    expect(f.matches(["hg", "push"])).toBe(false);
  });

  it("test_does_not_match_git_pull", () => {
    const f = new GitPushFilter();
    expect(f.matches(["git", "pull"])).toBe(false);
  });
});

// ===========================================================================
// GitPushFilter — push with passing tests compressed
// ===========================================================================

const _PYTEST_DOTS_PASSING =
  ".".repeat(50) + " [ 10%]\n" +
  ".".repeat(50) + " [ 20%]\n" +
  ".".repeat(50) + " [ 30%]\n" +
  ".".repeat(50) + " [ 40%]\n" +
  ".".repeat(50) + " [ 50%]\n" +
  ".".repeat(50) + " [ 60%]\n" +
  ".".repeat(50) + " [ 70%]\n" +
  ".".repeat(50) + " [ 80%]\n" +
  ".".repeat(50) + " [ 90%]\n" +
  ".".repeat(50) + " [100%]\n" +
  "8333 passed in 9m 21s\n" +
  "   abc123..def456  main -> origin/main";

describe("TestGitPushFilterPassing", () => {
  it("test_push_with_passing_tests_compressed", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"]);
    const lines = result.split("\n").filter((ln) => ln.trim());
    // Should be 2 lines or fewer
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("test_push_passing_contains_test_count", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"]);
    expect(result).toContain("8333");
    expect(result.toLowerCase()).toContain("passed");
  });

  it("test_push_passing_contains_ref_update", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"]);
    expect(result.includes("origin/main") || result.includes("main")).toBe(true);
  });

  it("test_push_passing_much_shorter_than_input", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"]);
    expect(_len(result)).toBeLessThan(Math.floor(_len(_PYTEST_DOTS_PASSING) / 3));
  });

  it("test_push_no_dots_passthrough", () => {
    const simple_output =
      "   abc123..def456  main -> origin/main\nBranch 'main' set up to track remote branch 'main'.";
    const f = new GitPushFilter();
    const result = _apply(f, simple_output, ["git", "push"]);
    expect(result).toContain("origin/main");
  });
});

// ===========================================================================
// GitPushFilter — push with failing tests preserves error
// ===========================================================================

const _PYTEST_DOTS_FAILING =
  ".".repeat(40) + "F" + ".".repeat(9) + " [ 10%]\n" +
  ".".repeat(50) + " [ 20%]\n" +
  "FAILED tests/test_foo.py::test_bar - AssertionError: expected 1 got 2\n" +
  ".".repeat(48) + "FF [100%]\n" +
  "3 failed, 8330 passed in 9m 45s\n" +
  "   abc123..def456  main -> origin/main";

describe("TestGitPushFilterFailing", () => {
  it("test_push_with_failing_tests_preserves_failure_info", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], "", 1);
    expect(result.includes("FAILED") || result.toLowerCase().includes("failed")).toBe(true);
  });

  it("test_push_failing_contains_error_message", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], "", 1);
    expect(result.includes("AssertionError") || result.includes("test_bar")).toBe(true);
  });

  it("test_push_failing_strips_dots", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], "", 1);
    // The compressed result should not contain lines of pure dots
    const dot_lines = result
      .split("\n")
      .filter((ln) => _reMatch(bc._PYTEST_DOT_LINE_RE, ln));
    expect(dot_lines.length).toBe(0);
  });

  it("test_push_failing_mentions_count", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], "", 1);
    expect(result.includes("3 failed") || result.includes("FAILED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Python re.Pattern.match(line) — anchored at the START. JS has no anchored
// match primitive; the bc-exported regexes are non-global, so clone-free
// .exec + index===0 reproduces match() faithfully (mirrors git.ts/_reMatch).
// ---------------------------------------------------------------------------
function _reMatch(re: RegExp, line: string): boolean {
  const flags = re.flags.replace(/[gy]/g, "");
  const r = new RegExp(re.source, flags);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

// ===========================================================================
// Edge Case 1: Windows CRLF line endings
// ===========================================================================

describe("TestGitCommitFilterCRLF", () => {
  it("test_crlf_line_endings_handled", () => {
    // Test that CRLF line endings are properly handled.
    const crlf_output =
      "╭─────────────────────╮\r\n" +
      "│ 🥊 lefthook  v2.1.8  hook:  pre-commit │\r\n" +
      "╰─────────────────────╯\r\n" +
      "┃  lint ❯\r\n" +
      "All checks passed!\r\n" +
      "  ────────────────────────────────────\r\n" +
      "summary: (done in 5.37 seconds)\r\n" +
      "✔️ lint (0.11 seconds)\r\n" +
      "✔️ typecheck (0.20 seconds)\r\n" +
      "[main d112339] feat: test\r\n" +
      " 1 file changed, 10 insertions(+)";
    const f = new GitCommitFilter();
    const result = _apply(f, crlf_output, ["git", "commit", "-m", "msg"]);
    // Should not fail and should preserve hook names
    expect(result).toContain("lint");
    expect(result).toContain("typecheck");
    expect(result).toContain("d112339");
  });
});

// ===========================================================================
// Edge Case 2: Multiple hook stages (3+ hooks)
// ===========================================================================

describe("TestGitCommitFilterMultipleHooks", () => {
  it("test_three_hooks_all_pass", () => {
    // Test with 3 hook stages instead of 2.
    const output = `╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
All checks passed!
┃  typecheck ❯
Type check passed!
┃  format ❯
Formatting check passed!
  ────────────────────────────────────
summary: (done in 10.5 seconds)
✔️ lint (0.11 seconds)
✔️ typecheck (5.20 seconds)
✔️ format (5.19 seconds)
[main abc1234] feat: multi-hook
 3 files changed, 100 insertions(+), 5 deletions(-)`;
    const f = new GitCommitFilter();
    const result = _apply(f, output, ["git", "commit", "-m", "msg"]);
    const lines = result.split("\n").filter((ln) => ln.trim());
    expect(lines.length).toBe(1);
    expect(result).toContain("lint");
    expect(result).toContain("typecheck");
    expect(result).toContain("format");
    expect(result).toContain("✔");
  });

  it("test_four_hooks_one_fails", () => {
    // Test with 4 hook stages, one failing.
    const output = `┃  lint ❯
Error on line 42
┃  typecheck ❯
Type check passed!
┃  format ❯
Formatting check passed!
┃  security ❯
Security scan passed!
  ────────────────────────────────────
summary: (done in 15.2 seconds)
✖ lint (1.20 seconds)
✔️ typecheck (5.20 seconds)
✔️ format (3.10 seconds)
✔️ security (5.75 seconds)`;
    const f = new GitCommitFilter();
    const result = _apply(f, output, ["git", "commit", "-m", "msg"]);
    // Error should be preserved
    expect(result).toContain("Error on line 42");
  });
});

// ===========================================================================
// Edge Case 3: commit --amend and --fixup variants
// ===========================================================================

describe("TestGitCommitFilterAmendFixup", () => {
  it("test_commit_amend_matches", () => {
    // Test that 'git commit --amend' is dispatched to GitCommitFilter.
    const f = bc.select_filter(["git", "commit", "--amend"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-commit");
  });

  it("test_commit_fixup_matches", () => {
    // Test that 'git commit --fixup' is dispatched to GitCommitFilter.
    const f = bc.select_filter(["git", "commit", "--fixup=HEAD"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-commit");
  });

  it("test_commit_amend_with_message_matches", () => {
    // Test that 'git commit --amend -m msg' is dispatched.
    const f = bc.select_filter(["git", "commit", "--amend", "-m", "fix"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git-commit");
  });

  it("test_commit_amend_lefthook_compressed", () => {
    // Test that --amend commits with lefthook are compressed.
    const output = `╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
All checks passed!
  ────────────────────────────────────
summary: (done in 0.5 seconds)
✔️ lint (0.45 seconds)
[main d112339] feat: updated
 1 file changed, 2 insertions(+)`;
    const f = new GitCommitFilter();
    const result = _apply(f, output, ["git", "commit", "--amend", "-m", "fix"]);
    const lines = result.split("\n").filter((ln) => ln.trim());
    expect(lines.length).toBe(1);
    expect(result).toContain("lint");
  });
});

// ===========================================================================
// Edge Case 4: Failed hook preserves error block (last 10 lines)
// ===========================================================================

describe("TestGitCommitFilterFailedHookErrorPreservation", () => {
  it("test_failed_hook_preserves_traceback", () => {
    // Test that failed hook output preserves the error traceback.
    const output = `┃  lint ❯
src/module.py:42: Error: undefined name 'foo'
src/module.py:99: Error: unused import 'bar'
Error on line 42
Error on line 99
Some intermediate output
Some more output
The actual traceback starts here
  File "src/module.py", line 42, in <module>
    raise ValueError("Critical error")
ValueError: Critical error
  ────────────────────────────────────
summary: (done in 1.23 seconds)
✖ lint (1.20 seconds)`;
    const f = new GitCommitFilter();
    const result = _apply(f, output, ["git", "commit", "-m", "msg"]);
    // The traceback and error should be preserved
    expect(result).toContain("ValueError: Critical error");
    expect(result).toContain('File "src/module.py", line 42');
  });

  it("test_failed_hook_multiple_errors_preserved", () => {
    // Test that multiple error messages in failed hook are preserved.
    const output = `┃  typecheck ❯
error: Argument 1 to "foo" has incompatible type "str"; expected "int"
error: Name "undefined_var" is not defined
error: Operator "+" not supported for types "str" and "int"
Some output line 1
Some output line 2
Some output line 3
Some output line 4
Some output line 5
Some output line 6
Some output line 7
Traceback (most recent call last):
  File "test.py", line 10, in <module>
    result = func(x)
  File "lib.py", line 5, in func
    return x + "string"
TypeError: unsupported operand type(s) for +
  ────────────────────────────────────
summary: (done in 2.50 seconds)
✖ typecheck (2.40 seconds)`;
    const f = new GitCommitFilter();
    const result = _apply(f, output, ["git", "commit", "-m", "msg"]);
    // At least one error line should be preserved
    expect(
      result.includes("TypeError: unsupported operand") ||
        result.includes("error:") ||
        result.includes("Traceback"),
    ).toBe(true);
  });
});

// ===========================================================================
// GitPushFilter — remote/local percentage-progress compression
// ===========================================================================

describe("TestGitPushFilterRemoteProgress", () => {
  // Tests for the new remote/local progress compression path.

  it("test_remote_progress_activates_filter", () => {
    // Output with remote progress lines is compressed (not passed through).
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    expect(_len(result)).toBeLessThan(_len(_REMOTE_PROGRESS_SMALL));
  });

  it("test_intermediate_progress_lines_dropped", () => {
    // Lines like 'Counting objects:  20% (1/5)' are stripped; only final kept.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    expect(result).not.toContain("Counting objects:  20%");
    expect(result).not.toContain("Counting objects:  40%");
    expect(result).not.toContain("Compressing objects:  33%");
    expect(result).not.toContain("Writing objects:  33%");
    expect(result).not.toContain("remote: Resolving deltas:   0%");
  });

  it("test_final_stage_line_kept", () => {
    // The 100% / 'done' line for each stage is preserved in output.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    expect(result).toContain("Counting objects: 100%");
    expect(result).toContain("Compressing objects: 100%");
    expect(result).toContain("Writing objects: 100%");
    expect(result).toContain("remote: Resolving deltas: 100%");
  });

  it("test_blank_remote_lines_dropped", () => {
    // Blank 'remote: ' padding lines are not present in compressed output.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    // No line should be exactly "remote:" or "remote: " (just whitespace after colon)
    for (const ln of result.split(/\r\n|\r|\n/)) {
      expect(ln.trim()).not.toBe("remote:");
    }
  });

  it("test_pr_url_kept", () => {
    // GitHub PR-creation URL lines are preserved — they are actionable info.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    expect(result).toContain("https://github.com/owner/repo/pull/new/feat/new");
  });

  it("test_ref_update_line_kept", () => {
    // The branch ref-update line (SHA range + branch names) is preserved.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    expect(result).toContain("7f3a1b2..9c4d5e6");
    expect(result).toContain("feat/new");
  });

  it("test_to_remote_line_kept", () => {
    // The 'To github.com:...' destination line is preserved.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    expect(result).toContain("To github.com:owner/repo.git");
  });

  it("test_non_progress_lines_pass_through", () => {
    // Lines unrelated to progress (Total, Delta compression, Enumerating) pass through.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"]);
    expect(result).toContain("Enumerating objects: 5, done.");
    expect(result).toContain("Delta compression using up to 8 threads");
    expect(result).toContain("Total 3 (delta 1)");
  });

  it("test_large_push_compresses_dramatically", () => {
    // A 400-line push output (simulating 14 KB) compresses to ≤20 lines.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_LARGE, ["git", "push"]);
    const lines = result.split(/\r\n|\r|\n/).filter((ln) => ln.trim());
    expect(lines.length).toBeLessThanOrEqual(20);
    // Still preserves the key outputs
    expect(result).toContain("abc1234..def5678");
    expect(result).toContain("https://github.com/owner/repo/pull/new/main");
  });

  it("test_large_push_final_stage_lines_present", () => {
    // After large push compression, the final-100% line for each stage is present.
    const f = new GitPushFilter();
    const result = _apply(f, _REMOTE_PROGRESS_LARGE, ["git", "push"]);
    expect(result).toContain("Counting objects: 100% (1000/1000), done.");
    expect(result).toContain("Compressing objects: 100% (800/800), done.");
    expect(result).toContain("Writing objects: 100% (1000/1000)");
    expect(result).toContain("remote: Resolving deltas: 100% (500/500)");
  });

  it("test_error_line_during_push_kept", () => {
    // error: lines in a push output (e.g. rejected refs) pass through verbatim.
    const output =
      "Counting objects:   0% (1/10)\n" +
      "Counting objects: 100% (10/10), done.\n" +
      "error: failed to push some refs to 'github.com:owner/repo.git'\n" +
      "hint: Updates were rejected because the remote contains work that you do not have locally.\n" +
      "To github.com:owner/repo.git\n" +
      " ! [rejected]  main -> main (non-fast-forward)";
    const f = new GitPushFilter();
    const result = _apply(f, output, ["git", "push"], "", 1);
    expect(result).toContain("error: failed to push some refs");
    expect(result).toContain("hint: Updates were rejected");
    expect(result).toContain("[rejected]");
  });

  it("test_multiremote_both_ref_updates_kept", () => {
    // When multiple ref lines appear they are all preserved.
    const output =
      "Counting objects: 100% (5/5), done.\n" +
      "Writing objects: 100% (5/5), 1.00 KiB | 1.00 MiB/s, done.\n" +
      "Total 5 (delta 2), reused 0 (delta 0), pack-reused 0\n" +
      "To github.com:owner/repo.git\n" +
      "   aaa1111..bbb2222  main -> main\n" +
      "   ccc3333..ddd4444  v1.0 -> v1.0";
    const f = new GitPushFilter();
    const result = _apply(f, output, ["git", "push"]);
    expect(result).toContain("aaa1111..bbb2222");
    expect(result).toContain("ccc3333..ddd4444");
  });

  it("test_no_progress_lines_passthrough_unchanged", () => {
    // Output with no progress lines is returned unchanged (passthrough guard).
    const simple = "To github.com:owner/repo.git\n   7f3a1b2..9c4d5e6  main -> main";
    const f = new GitPushFilter();
    const result = _apply(f, simple, ["git", "push"]);
    expect(result).toBe(simple);
  });
});

// ===========================================================================
// GitPushFilter — pytest pre-push + remote progress combined
// ===========================================================================

describe("TestGitPushFilterCombinedPytestAndRemote", () => {
  // When a pre-push hook runs pytest AND the push has remote progress lines.

  it("test_combined_output_compresses_dots_and_remote", () => {
    // Both pytest dots and remote progress lines are collapsed.
    const combined =
      // Remote progress from the actual push
      "Counting objects:   0% (1/100)\n" +
      "Counting objects: 100% (100/100), done.\n" +
      "Writing objects: 100% (100/100), 2.00 KiB | 2.00 MiB/s, done.\n" +
      "Total 100 (delta 50), reused 0 (delta 0), pack-reused 0\n" +
      "remote: Resolving deltas:   0% (0/50)\n" +
      "remote: Resolving deltas: 100% (50/50), done.\n" +
      "remote: \n" +
      // Pytest dot output from the pre-push hook
      ".".repeat(50) + " [ 50%]\n" +
      ".".repeat(50) + " [100%]\n" +
      "500 passed in 45s\n" +
      "   abc1234..def5678  main -> main";
    const f = new GitPushFilter();
    const result = _apply(f, combined, ["git", "push"]);
    // pytest summary preserved
    expect(result).toContain("500 passed");
    // ref update preserved
    expect(result.includes("abc1234..def5678") || result.includes("main")).toBe(true);
    // no raw dot lines
    const dot_lines = result
      .split(/\r\n|\r|\n/)
      .filter((ln) => _reMatch(bc._PYTEST_DOT_LINE_RE, ln));
    expect(dot_lines.length).toBe(0);
  });
});

// ===========================================================================
// CRLF line-ending normalisation warnings (git add / commit / checkout)
//
// Git on Windows emits a two-line warning per touched file:
//   warning: LF will be replaced by CRLF in <path>.
//   The file will have its original line endings in your working directory
// These carry no actionable signal and can appear dozens of times per session.
// ===========================================================================

function _crlf_pair(path: string): string {
  return (
    `warning: LF will be replaced by CRLF in ${path}.\n` +
    "The file will have its original line endings in your working directory"
  );
}

// Modern git (2.37+) emits a single self-contained line per touched file; this
// is the exact wording produced by git 2.53.0.windows.1.  No continuation line.
function _crlf_modern(path: string): string {
  return (
    `warning: in the working copy of '${path}', LF will be replaced by CRLF ` +
    "the next time Git touches it"
  );
}
function _crlf_modern_reverse(path: string): string {
  return (
    `warning: in the working copy of '${path}', CRLF will be replaced by LF ` +
    "the next time Git touches it"
  );
}

describe("TestStripGitCrlfWarningsHelper", () => {
  it("test_strips_pair_and_counts", () => {
    const text =
      _crlf_pair("a.py") + "\n" +
      _crlf_pair("b.py") + "\n" +
      _crlf_pair("c.py");
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(3);
    expect(cleaned.trim()).toBe("");
    expect(cleaned).not.toContain("will be replaced");
    expect(cleaned).not.toContain("original line endings");
  });

  it("test_reverse_wording_crlf_to_lf", () => {
    const text =
      "warning: CRLF will be replaced by LF in script.sh.\n" +
      "The file will have its original line endings in your working directory";
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(1);
    expect(cleaned.trim()).toBe("");
  });

  it("test_continuation_with_trailing_period", () => {
    const text =
      "warning: LF will be replaced by CRLF in x.txt.\n" +
      "The file will have its original line endings in your working directory.";
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(1);
    expect(cleaned.trim()).toBe("");
  });

  it("test_real_output_passes_through", () => {
    const text = "On branch main\nnothing to commit, working tree clean";
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(0);
    expect(cleaned).toBe(text);
  });

  it("test_interspersed_real_lines_preserved", () => {
    const text =
      _crlf_pair("src/a.py") + "\n" +
      "Updating files: 100% (42/42), done.\n" +
      _crlf_pair("src/b.py") + "\n" +
      "Switched to branch 'feature'\n" +
      _crlf_pair("src/c.py");
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(3);
    expect(cleaned).toContain("Updating files: 100% (42/42), done.");
    expect(cleaned).toContain("Switched to branch 'feature'");
    expect(cleaned).not.toContain("will be replaced");
    expect(cleaned).not.toContain("original line endings");
  });

  it("test_orphan_continuation_dropped", () => {
    // A continuation line whose header was already stripped (e.g. split
    // across a truncation boundary) must not survive as noise.
    const text =
      "real output line\nThe file will have its original line endings in your working directory";
    const [cleaned] = bc._strip_git_crlf_warnings(text);
    expect(cleaned).toContain("real output line");
    expect(cleaned).not.toContain("original line endings");
  });

  it("test_no_match_is_zero_cost_identity", () => {
    const text = "some unrelated build output\nwith two lines";
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(0);
    expect(cleaned).toBe(text);
  });

  // --- Modern git 2.37+ single-line format ------------------------------
  // These exercise the format actually emitted by git 2.53; they fail on
  // the pre-fix regex (which only matched the obsolete two-line pair).

  it("test_modern_single_line_stripped_and_counted", () => {
    const text =
      _crlf_modern("a.py") + "\n" +
      _crlf_modern("b.py") + "\n" +
      _crlf_modern("c.py");
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(3);
    expect(cleaned.trim()).toBe("");
    expect(cleaned).not.toContain("will be replaced");
    expect(cleaned).not.toContain("next time Git touches it");
  });

  it("test_modern_reverse_wording_crlf_to_lf", () => {
    const text = _crlf_modern_reverse("script.sh");
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(1);
    expect(cleaned.trim()).toBe("");
  });

  it("test_modern_trailing_period", () => {
    const text = _crlf_modern("x.txt") + ".";
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(1);
    expect(cleaned.trim()).toBe("");
  });

  it("test_modern_interspersed_real_lines_preserved", () => {
    const text =
      _crlf_modern("src/a.py") + "\n" +
      "Updating files: 100% (42/42), done.\n" +
      _crlf_modern("src/b.py") + "\n" +
      "Switched to branch 'feature'\n" +
      _crlf_modern("src/c.py");
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(3);
    expect(cleaned).toContain("Updating files: 100% (42/42), done.");
    expect(cleaned).toContain("Switched to branch 'feature'");
    expect(cleaned).not.toContain("next time Git touches it");
  });

  it("test_modern_crlf_terminated_input", () => {
    // Windows-native git writes \r\n line endings; the helper must still
    // strip the warning when the regex would otherwise see a bare \r before
    // the line anchor.
    const text =
      _crlf_modern("a.py") + "\r\n" +
      _crlf_modern("b.py") + "\r\n";
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(2);
    expect(cleaned).not.toContain("next time Git touches it");
  });

  it("test_legacy_pair_crlf_terminated_input", () => {
    // The legacy two-line pair, \r\n-terminated, must also strip cleanly.
    const text =
      "warning: LF will be replaced by CRLF in a.py.\r\n" +
      "The file will have its original line endings in your working directory\r\n";
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(1);
    expect(cleaned).not.toContain("will be replaced");
    expect(cleaned).not.toContain("original line endings");
  });

  it("test_mixed_modern_and_legacy_formats", () => {
    const text =
      _crlf_modern("modern.py") + "\n" +
      _crlf_pair("legacy.py");
    const [cleaned, count] = bc._strip_git_crlf_warnings(text);
    expect(count).toBe(2);
    expect(cleaned.trim()).toBe("");
  });
});

describe("TestGitFilterCrlfSuppression", () => {
  it("test_git_add_stderr_warnings_stripped", () => {
    // `git add` falls through to GitFilter (name "git"); warnings land on stderr.
    const stderr =
      _crlf_pair("foo/bar.py") + "\n" +
      _crlf_pair("foo/baz.py") + "\n" +
      _crlf_pair("README.md");
    const f = bc.select_filter(["git", "add", "-A"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git");
    const result = f!.apply("", stderr, 0, ["git", "add", "-A"]).text;
    expect(result).not.toContain("will be replaced");
    expect(result).not.toContain("original line endings");
  });

  it("test_real_output_survives_with_warnings", () => {
    const stdout = "Updating files: 100% (12/12), done.";
    const stderr =
      _crlf_pair("a.py") + "\n" +
      _crlf_pair("b.py");
    const f = new GitFilter();
    const result = f.apply(stdout, stderr, 0, ["git", "checkout", "main"]).text;
    expect(result).toContain("Updating files: 100% (12/12), done.");
    expect(result).not.toContain("will be replaced");
  });

  it("test_commit_filter_strips_crlf_warnings_on_stderr", () => {
    const stdout = "[main d112339] feat: x\n 2 files changed, 4 insertions(+)";
    const stderr =
      _crlf_pair("src/a.py") + "\n" +
      _crlf_pair("src/b.py") + "\n" +
      _crlf_pair("src/c.py");
    const result = _apply(new GitCommitFilter(), stdout, ["git", "commit", "-m", "x"], stderr);
    expect(result).toContain("d112339");
    expect(result).not.toContain("will be replaced");
    expect(result).not.toContain("original line endings");
  });

  it("test_git_add_modern_stderr_warnings_stripped", () => {
    // Modern git 2.37+ format through the GitFilter (`git add` → name "git").
    // Fails on the pre-fix regex that only knew the obsolete two-line pair.
    const stderr =
      _crlf_modern("foo/bar.py") + "\n" +
      _crlf_modern("foo/baz.py") + "\n" +
      _crlf_modern("README.md");
    const f = bc.select_filter(["git", "add", "-A"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("git");
    const result = f!.apply("", stderr, 0, ["git", "add", "-A"]).text;
    expect(result).not.toContain("will be replaced");
    expect(result).not.toContain("next time Git touches it");
  });

  it("test_commit_filter_strips_modern_crlf_warnings", () => {
    const stdout = "[main d112339] feat: x\n 2 files changed, 4 insertions(+)";
    const stderr =
      _crlf_modern("src/a.py") + "\n" +
      _crlf_modern("src/b.py");
    const result = _apply(new GitCommitFilter(), stdout, ["git", "commit", "-m", "x"], stderr);
    expect(result).toContain("d112339");
    expect(result).not.toContain("next time Git touches it");
  });

  it("test_modern_crlf_terminated_stderr_through_apply", () => {
    // \r\n-terminated stderr (Windows-native) routed through Filter.apply;
    // normalise() collapses \r\n→\n before the strip runs, so the warning
    // is suppressed.  Fails pre-fix (stripping ran before normalise on \r\n).
    const stderr =
      _crlf_modern("a.py") + "\r\n" +
      _crlf_modern("b.py") + "\r\n";
    const f = new GitFilter();
    const result = f.apply("Updating files: 100% (3/3), done.", stderr, 0, ["git", "checkout", "main"]).text;
    expect(result).toContain("Updating files: 100% (3/3), done.");
    expect(result).not.toContain("next time Git touches it");
  });

  it("test_legacy_crlf_terminated_stderr_through_apply", () => {
    // Same path for the legacy two-line pair with \r\n endings.
    const stderr =
      "warning: LF will be replaced by CRLF in a.py.\r\n" +
      "The file will have its original line endings in your working directory\r\n";
    const f = new GitFilter();
    const result = f.apply("Updating files: 100% (1/1), done.", stderr, 0, ["git", "checkout", "main"]).text;
    expect(result).toContain("Updating files: 100% (1/1), done.");
    expect(result).not.toContain("will be replaced");
    expect(result).not.toContain("original line endings");
  });

  it("test_non_git_filter_leaves_phrase_untouched", () => {
    // A non-git command that happens to echo the phrase must not be altered.
    const echoed =
      "warning: LF will be replaced by CRLF in fake.txt.\n" +
      "The file will have its original line endings in your working directory";
    // GenericFilter (name "generic") is the universal fallback for any
    // command without a dedicated filter; its name must not start with
    // "git" so the CRLF-suppression gate stays off.
    const f = new GenericFilter();
    expect(f.name.startsWith("git")).toBe(false);
    const result = f.apply(echoed, "", 0, ["echo", echoed]).text;
    expect(result).toContain("will be replaced");
    expect(result).toContain("original line endings");
  });
});

// ===========================================================================
// GitPushFilter — pre-push hook runs a bundler (vite/webpack/esbuild)
// ===========================================================================

const _VITE_PREPUSH_PASSING =
  "> lefthook run pre-push\n" +
  "> build\n" +
  "> vite build\n" +
  "vite v5.4.2 building for production...\n" +
  "transforming (1) index.html\n" +
  "transforming (212) src/main.tsx\n" +
  "✓ 423 modules transformed.\n" +
  "rendering chunks (1)...\n" +
  "computing gzip size (1)...\n" +
  "dist/index.html                     0.50 kB │ gzip:   0.31 kB\n" +
  "dist/assets/index-BH4Mhpqg.css     12.84 kB │ gzip:   3.21 kB\n" +
  "dist/assets/vendor-Df9aLp2k.js    142.10 kB │ gzip:  45.88 kB\n" +
  "dist/assets/index-Qa83Lm0p.js     321.26 kB │ gzip:  99.21 kB\n" +
  "dist/assets/chunk-Aa11Bb22.js      58.04 kB │ gzip:  18.77 kB\n" +
  "dist/assets/chunk-Cc33Dd44.js      44.91 kB │ gzip:  14.03 kB\n" +
  "dist/assets/chunk-Ee55Ff66.js      31.18 kB │ gzip:   9.55 kB\n" +
  "dist/assets/chunk-Gg77Hh88.js      22.07 kB │ gzip:   6.61 kB\n" +
  "dist/assets/logo-Ii99Jj00.svg       4.12 kB │ gzip:   1.98 kB\n" +
  "dist/assets/font-Kk11Ll22.woff2    18.40 kB\n" +
  "✓ built in 8.23s\n" +
  "   abc123..def456  main -> origin/main";

const _VITE_PREPUSH_FAILING =
  "> lefthook run pre-push\n" +
  "> vite build\n" +
  "vite v5.4.2 building for production...\n" +
  "transforming (212) src/main.tsx\n" +
  "dist/assets/index-Qa83Lm0p.js     321.26 kB │ gzip:  99.21 kB\n" +
  "error during build:\n" +
  '[vite]: Rollup failed to resolve import "./missing" from "src/app.tsx".\n' +
  "  This is most likely unintended because it can break your application.\n";

const _WEBPACK_PREPUSH =
  "> husky - pre-push hook\n" +
  "> webpack --mode production\n" +
  "asset main.js 321 KiB [emitted] [minimized] (name: main)\n" +
  "asset vendor.js 142 KiB [emitted] [minimized] (name: vendor)\n" +
  "  ./node_modules/react/index.js 190 bytes [built] [code generated]\n" +
  "  ./node_modules/react-dom/index.js 4.2 KiB [built] [code generated]\n" +
  "  ./node_modules/lodash/lodash.js 540 KiB [built] [code generated]\n" +
  "modules by path ./node_modules/ 4.2 MiB\n" +
  "runtime modules 1.2 KiB 6 modules\n" +
  "webpack 5.89.0 compiled successfully in 4821 ms\n" +
  "   abc123..def456  main -> origin/main";

describe("TestGitPushFilterBundler", () => {
  it("test_vite_prepush_compressed_small", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"]);
    const lines = result.split("\n").filter((ln) => ln.trim());
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("test_vite_prepush_drops_asset_rows", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"]);
    // No asset-size rows survive.
    expect(result).not.toContain("gzip:");
    expect(result).not.toContain("dist/assets/index-Qa83Lm0p.js");
    expect(result).not.toContain("modules transformed");
  });

  it("test_vite_prepush_keeps_summary_marker", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"]);
    expect(result).toContain("suppressed");
    expect(result).toContain("built in 8.23s");
  });

  it("test_vite_prepush_keeps_push_ref", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"]);
    expect(result).toContain("origin/main");
  });

  it("test_vite_prepush_keeps_hook_trigger", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"]);
    expect(result).toContain("pre-push");
  });

  it("test_vite_prepush_much_shorter", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"]);
    expect(_len(result)).toBeLessThan(Math.floor(_len(_VITE_PREPUSH_PASSING) / 3));
  });

  it("test_vite_prepush_failure_preserves_error", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _VITE_PREPUSH_FAILING, ["git", "push"], "", 1);
    expect(result).toContain("error during build");
    expect(result).toContain("Rollup failed to resolve import");
    // Asset rows are still suppressed even on failure.
    expect(result).not.toContain("gzip:");
  });

  it("test_webpack_prepush_compressed", () => {
    const f = new GitPushFilter();
    const result = _apply(f, _WEBPACK_PREPUSH, ["git", "push"]);
    const lines = result.split("\n").filter((ln) => ln.trim());
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(result).not.toContain("node_modules");
    expect(result).toContain("compiled successfully");
    expect(result).toContain("origin/main");
  });

  it("test_to_remote_line_passes_through", () => {
    // "To <remote>" header line is git push output and must survive.
    const payload =
      "> lefthook run pre-push\n" +
      "> vite build\n" +
      "vite v5.4.2 building for production...\n" +
      "✓ 423 modules transformed.\n" +
      "dist/assets/index-Qa83Lm0p.js     321.26 kB │ gzip:  99.21 kB\n" +
      "dist/assets/vendor-Df9aLp2k.js    142.10 kB │ gzip:  45.88 kB\n" +
      "✓ built in 8.23s\n" +
      "To github.com:owner/repo.git\n" +
      "   abc123..def456  main -> origin/main";
    const f = new GitPushFilter();
    const result = _apply(f, payload, ["git", "push"]);
    expect(result).toContain("To github.com:owner/repo.git");
    expect(result).toContain("origin/main");
    expect(result).not.toContain("gzip:");
  });

  it("test_no_bundler_passthrough", () => {
    // Plain push with no bundler block is unchanged.
    const simple = "   abc123..def456  main -> origin/main";
    const f = new GitPushFilter();
    const result = _apply(f, simple, ["git", "push"]);
    expect(result.trim()).toBe(simple.trim());
  });
});
