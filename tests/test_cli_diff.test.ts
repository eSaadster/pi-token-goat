/**
 * Tests for `token-goat diff` — faithful port of tests/test_cli_diff.py.
 *
 * Harness seams:
 *  - `invoke([...])` is the TS CliRunner (tests/_cli_runner.ts): captures
 *    stdout/stderr/output + exit_code. Python `runner.invoke(cli.app, [...])` →
 *    `await invoke([...])`; `result.stdout/.output/.exit_code` map 1:1.
 *  - `tmp_data_dir` is automatic (tests/setup.ts isolates the data dir per test).
 *  - `run_git` is mocked via `vi.spyOn(util, "runGit")`. cli_stats.ts calls it
 *    through `import * as util` → `util.runGit(...)`, so the spy is observed.
 *    The Python `_make_run_git(stdout)` helper → `_mockRunGit(stdout)` returning
 *    a `{ returncode, stdout, stderr }` CompletedProcess.
 *  - Session mode patches `session.validate_session_id` (no-op) +
 *    `session.list_edited` (the edited-files map) via `vi.spyOn`, mirroring the
 *    Python `fake_session` fixture's monkeypatch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as util from "../src/token_goat/util.js";
import * as session from "../src/token_goat/session.js";
import * as cli_stats from "../src/token_goat/cli_stats.js";

import { invoke } from "./_cli_runner.js";

// ---------------------------------------------------------------------------
// run_git mock helpers
// ---------------------------------------------------------------------------

type CP = util.CompletedProcess;

/** Mock run_git that always yields the given stdout (rc 0). */
function _mockRunGit(stdout: string): (args: string[]) => CP {
  return (args: string[]) => ({ args, returncode: 0, stdout, stderr: "" });
}

/**
 * Patch run_git for the git-diff command: rev-parse --verify (ref exists),
 * diff --stat (the file lines + summary), and diff --unified=0 (with --symbols).
 */
function _patchGit(stat_stdout: string, diff_stdout = ""): void {
  vi.spyOn(util, "runGit").mockImplementation((args: string[]): CP => {
    if (args.includes("rev-parse")) {
      return { args, returncode: 0, stdout: "abc1234\n", stderr: "" };
    }
    if (args.includes("--stat")) {
      return { args, returncode: 0, stdout: stat_stdout, stderr: "" };
    }
    if (args.includes("--unified=0")) {
      return { args, returncode: 0, stdout: diff_stdout, stderr: "" };
    }
    return { args, returncode: 0, stdout: "", stderr: "" };
  });
}

const _STAT_STDOUT = ` src/foo.py | 10 ++++------
 src/bar.py |  2 +-
 2 files changed, 6 insertions(+), 6 deletions(-)
`;

// ===========================================================================
// _extract_diff_symbols unit tests
// ===========================================================================

describe("_extract_diff_symbols", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_extract_diff_symbols_empty", () => {
    vi.spyOn(util, "runGit").mockImplementation(_mockRunGit(""));
    expect(cli_stats._extract_diff_symbols("HEAD~1", "/tmp")).toEqual({});
  });

  it("test_extract_diff_symbols_python", () => {
    const diff = `--- a/src/foo.py
+++ b/src/foo.py
@@ -10,3 +10,5 @@ def my_function(x):
+    return x + 1
@@ -50,1 +52,1 @@ class MyClass:
-    pass
+    x = 1
`;
    vi.spyOn(util, "runGit").mockImplementation(_mockRunGit(diff));
    const result = cli_stats._extract_diff_symbols("HEAD~1", "/tmp");
    expect(result).toHaveProperty("src/foo.py");
    const syms = result["src/foo.py"]!;
    expect(syms).toContain("my_function");
    expect(syms).toContain("MyClass");
  });

  it("test_extract_diff_symbols_deduplicates", () => {
    const diff = `--- a/src/bar.py
+++ b/src/bar.py
@@ -10,3 +10,5 @@ def helper():
-    old
@@ -20,2 +22,2 @@ def helper():
+    new
`;
    vi.spyOn(util, "runGit").mockImplementation(_mockRunGit(diff));
    const result = cli_stats._extract_diff_symbols("HEAD~1", "/tmp");
    expect(result["src/bar.py"]!.filter((s) => s === "helper").length).toBe(1);
  });

  it("test_extract_diff_symbols_multiple_files", () => {
    const diff = `--- a/a.py
+++ b/a.py
@@ -1,1 +1,2 @@ def alpha():
+    pass
--- a/b.py
+++ b/b.py
@@ -1,1 +1,2 @@ class Beta:
+    x = 1
`;
    vi.spyOn(util, "runGit").mockImplementation(_mockRunGit(diff));
    const result = cli_stats._extract_diff_symbols("HEAD~1", "/tmp");
    expect(result["a.py"]).toContain("alpha");
    expect(result["b.py"]).toContain("Beta");
  });

  it("test_extract_diff_symbols_strips_keywords", () => {
    const diff = `--- a/x.go
+++ b/x.go
@@ -5,3 +5,4 @@ func DoThing(a int) {
+    a++
`;
    vi.spyOn(util, "runGit").mockImplementation(_mockRunGit(diff));
    const result = cli_stats._extract_diff_symbols("HEAD~1", "/tmp");
    expect(result["x.go"]).toContain("DoThing");
    // "func " prefix must be stripped.
    expect(result["x.go"]!.some((s) => s.includes("func"))).toBe(false);
  });

  it("test_extract_diff_symbols_no_header_context", () => {
    // Hunk with no trailing name after @@ is ignored gracefully.
    const diff = `--- a/c.py
+++ b/c.py
@@ -1,3 +1,4 @@
+new line
`;
    vi.spyOn(util, "runGit").mockImplementation(_mockRunGit(diff));
    const result = cli_stats._extract_diff_symbols("HEAD~1", "/tmp");
    // Either empty or an empty list — no crash.
    expect(result["c.py"] ?? []).toEqual([]);
  });

  it("test_extract_diff_symbols_git_failure", () => {
    vi.spyOn(util, "runGit").mockReturnValue({ args: [], returncode: 128, stdout: "", stderr: "" });
    expect(cli_stats._extract_diff_symbols("HEAD~1", "/tmp")).toEqual({});
  });
});

// ===========================================================================
// CLI integration: session mode
// ===========================================================================

describe("diff session mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Inject a fake session with two edited files. */
  function _fakeSession(): void {
    vi.spyOn(session, "validate_session_id").mockImplementation(() => undefined);
    vi.spyOn(session, "list_edited").mockReturnValue({
      "src/alpha.py": 3,
      "src/beta.py": 1,
    });
  }

  it("test_diff_session_mode_plain", async () => {
    _fakeSession();
    const r = await invoke(["diff", "--session", "abc123def456abc1"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("abc123de"); // first 8 chars
    expect(r.stdout).toContain("src/alpha.py");
    expect(r.stdout).toContain("src/beta.py");
    expect(r.stdout).toContain("3 edit");
  });

  it("test_diff_session_mode_json", async () => {
    _fakeSession();
    const r = await invoke(["diff", "--session", "abc123def456abc1", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as {
      mode: string;
      files: Array<{ path: string }>;
    };
    expect(data.mode).toBe("session");
    const paths = data.files.map((f) => f.path);
    expect(paths).toContain("src/alpha.py");
    expect(paths).toContain("src/beta.py");
  });

  it("test_diff_session_empty", async () => {
    vi.spyOn(session, "validate_session_id").mockImplementation(() => undefined);
    vi.spyOn(session, "list_edited").mockReturnValue({});
    const r = await invoke(["diff", "--session", "abc123def456abc1"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("no files");
  });
});

// ===========================================================================
// CLI integration: git diff mode
// ===========================================================================

describe("diff git mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_diff_git_plain", async () => {
    _patchGit(_STAT_STDOUT);
    const r = await invoke(["diff", "--since", "HEAD~1"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("src/foo.py");
    expect(r.stdout).toContain("src/bar.py");
    expect(r.stdout).toContain("2 files changed");
  });

  it("test_diff_git_json", async () => {
    _patchGit(_STAT_STDOUT);
    const r = await invoke(["diff", "--since", "HEAD~1", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as {
      mode: string;
      since: string;
      files: Array<{ path: string }>;
    };
    expect(data.mode).toBe("git");
    expect(data.since).toBe("HEAD~1");
    const paths = data.files.map((f) => f.path);
    expect(paths).toContain("src/foo.py");
    expect(paths).toContain("src/bar.py");
  });

  it("test_diff_git_symbols", async () => {
    const diff_stdout = `--- a/src/foo.py
+++ b/src/foo.py
@@ -5,3 +5,4 @@ def process(x):
+    x += 1
`;
    _patchGit(_STAT_STDOUT, diff_stdout);
    const r = await invoke(["diff", "--since", "HEAD~1", "--symbols"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("process");
  });

  it("test_diff_git_symbols_json", async () => {
    const diff_stdout = `--- a/src/foo.py
+++ b/src/foo.py
@@ -5,3 +5,4 @@ def process(x):
+    x += 1
`;
    _patchGit(_STAT_STDOUT, diff_stdout);
    const r = await invoke(["diff", "--since", "HEAD~1", "--symbols", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as {
      files: Array<{ path: string; symbols: string[] }>;
    };
    const foo = data.files.find((f) => f.path === "src/foo.py")!;
    expect(foo.symbols).toContain("process");
  });

  it("test_diff_git_no_changes", async () => {
    _patchGit("");
    const r = await invoke(["diff", "--since", "HEAD~1"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("No changes");
  });

  it("test_diff_git_no_changes_json", async () => {
    _patchGit("");
    const r = await invoke(["diff", "--since", "HEAD~1", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as { files: unknown[] };
    expect(data.files).toEqual([]);
  });

  it("test_diff_bad_ref", async () => {
    vi.spyOn(util, "runGit").mockReturnValue({
      args: [],
      returncode: 128,
      stdout: "",
      stderr: "fatal: ambiguous argument",
    });
    const r = await invoke(["diff", "--since", "nonexistent-ref"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("not found");
  });

  it("test_diff_rename_notation", async () => {
    const stat_with_rename = ` {old => new}/file.py | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
`;
    _patchGit(stat_with_rename);
    const r = await invoke(["diff", "--since", "HEAD~1"]);
    expect(r.exit_code).toBe(0);
    // Should not crash on rename notation.
    expect(r.stdout).toContain("1 file changed");
  });
});
