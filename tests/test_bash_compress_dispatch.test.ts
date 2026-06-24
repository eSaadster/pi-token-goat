/**
 * Dispatch and golden-output tests for token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_dispatch.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name. Parametrized Python
 * tests (`@pytest.mark.parametrize`) map to `it.each` tables.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _apply`
 *      -> local `_apply(filter, opts?)` helper below. The Python helper runs
 *        `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *        to `[filter_.name]`; the TS port mirrors that exactly.
 *  - `from filter_test_helpers import savings_ratio as _savings_ratio`
 *      -> local `_savings_ratio(filter, opts)` helper returning
 *        `filter_.apply(...).percent_saved / 100.0`.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`.
 *
 * Deferral: ALL 156 Python filters ship, in exact Python order Diff..TailTrunc,
 * with PythonFilter at its mid-list slot and TailTruncFilter last. (GenericFilter
 * is exported as a class but is NOT in the FILTERS registry — it has no binaries
 * so it never matched via select_filter, and CPython's FILTERS omits it too.)
 * Every previously-skipped case whose
 * target filter is now ported has been un-skipped and its assertion ported to
 * the TS API. The few cases that remain `it.skip`-ed are documented inline with
 * a "// reason" comment (none expected — the full registry now covers every
 * filter this file references).
 *
 * Byte-exactness: the savings-ratio helper uses `percent_saved` (already a
 * byte-accurate UTF-8 measure computed inside the filters), so no String.length
 * arithmetic is needed. Where a glyph is asserted it is the same Unicode
 * codepoint as the Python source.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  AnsibleFilter,
  CargoFilter,
  CypressFilter,
  DockerFilter,
  ESLintFilter,
  EzaFilter,
  FzfFilter,
  GhFilter,
  GitFilter,
  GrepFilter,
  GradleFilter,
  JestFilter,
  KubectlFilter,
  LazyGitFilter,
  LinterFilter,
  LsFilter,
  MakeFilter,
  MesonFilter,
  MypyFilter,
  NodeFilter,
  NodePackageFilter,
  OxlintFilter,
  PipFilter,
  PlaywrightFilter,
  PreCommitFilter,
  PylintFilter,
  PytestFilter,
  PythonFilter,
  RgFilter,
  RuffFilter,
  TailTruncFilter,
  TerraformFilter,
  TreeFilter,
  UvFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter / savings_ratio helpers (port of filter_test_helpers).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element — the minimum needed for most dispatch checks.
// ---------------------------------------------------------------------------
function _apply(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

function _savings_ratio(
  filter_: Filter,
  opts: { stdout?: string; stderr?: string; argv?: string[] },
): number {
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  const argv = opts.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0;
}

// ===========================================================================
// 1. Dispatch table: parametrized per-filter match assertions
// ===========================================================================

// Each entry: ([command_tokens], expected_filter_name)
//
// One flat _DISPATCH_CASES list parametrizing test_dispatch_matches — a 1:1
// mirror of the Python module's _DISPATCH_CASES, in the SAME relative order.
// As of Run 9 every target filter ships, so all cases run.

const _DISPATCH_CASES: Array<[string[], string]> = [
  // ---- PytestFilter ----
  [["pytest", "tests/"], "pytest"],
  [["pytest", "-x", "-v", "tests/unit/"], "pytest"],
  [["py.test", "tests/"], "pytest"],
  [["python", "-m", "pytest", "tests/"], "pytest"],
  [["uv", "run", "pytest", "tests/"], "pytest"],
  // ---- JestFilter ----
  [["jest", "--watchAll=false"], "jest"],
  [["mocha", "tests/*.spec.js"], "jest"],
  // ---- VitestFilter ----
  [["vitest", "run"], "vitest"],
  [["vitest", "--watch"], "vitest"],
  // ---- CargoFilter ----
  [["cargo", "build", "--release"], "cargo"],
  [["cargo", "test"], "cargo"],
  [["cargo", "check"], "cargo"],
  [["cargo", "clippy"], "cargo"],
  [["cargo", "run"], "cargo"],
  // ---- NpmInstallFilter ----
  [["npm", "install"], "npm_install"],
  [["npm", "ci"], "npm_install"],
  [["pnpm", "install"], "npm_install"],
  [["yarn", "install"], "npm_install"],
  // ---- PlaywrightFilter ----
  [["playwright", "test"], "playwright"],
  [["playwright", "install"], "playwright"],
  [["npx", "playwright", "test"], "playwright"],
  [["bunx", "playwright", "test"], "playwright"],
  // ---- CypressFilter ----
  [["cypress", "run"], "cypress"],
  [["cypress", "open"], "cypress"],
  [["npx", "cypress", "run"], "cypress"],
  [["bunx", "cypress", "run"], "cypress"],
  // ---- BunFilter ----
  [["bun", "install"], "bun"],
  // ---- NodeFilter (eval probes only) ----
  [["node", "-e", "console.log(1)"], "node"],
  [["node", "-p", "1+1"], "node"],
  // ---- DockerFilter ----
  [["docker", "build", "-t", "my-image", "."], "docker"],
  [["docker", "run", "--rm", "alpine"], "docker"],
  [["podman", "build", "."], "docker"],
  // ---- KubectlLogsFilter (precedes KubectlFilter; matches `kubectl logs`) ----
  [["kubectl", "logs", "my-pod"], "kubectl-logs"],
  // ---- HelmFilter (dedicated; precedes KubectlFilter) ----
  [["helm", "install", "my-release", "chart/"], "helm"],
  // ---- KubectlFilter ----
  [["kubectl", "get", "pods"], "kubectl"],
  // ---- AwsCliFilter (registered before AwsFilter; wins dispatch for `aws`) ----
  [["aws", "s3", "ls"], "aws-cli"],
  [["aws", "ec2", "describe-instances"], "aws-cli"],
  // ---- RuffFilter ----
  [["ruff", "check", "src/"], "ruff"],
  [["ruff", "check", "."], "ruff"],
  // ---- MypyFilter ----
  [["mypy", "src/"], "mypy"],
  [["dmypy", "run", "--", "src/"], "mypy"],
  // ---- ESLintFilter ----
  [["eslint", "src/", "--ext", ".ts"], "eslint"],
  [["eslint", "."], "eslint"],
  // ---- PylintFilter (dedicated, before LinterFilter) ----
  [["pylint", "src/"], "pylint"],
  // ---- OxlintFilter ----
  [["oxlint", "src/"], "oxlint"],
  [["oxc_linter", "src/"], "oxlint"],
  // ---- TurboFilter ----
  [["turbo", "run", "build"], "turbo"],
  [["npx", "turbo", "run", "build"], "turbo"],
  // ---- TscFilter (dedicated; previously fell through to LinterFilter) ----
  [["tsc", "--noEmit"], "tsc"],
  // ---- LinterFilter ----
  [["pyright", "src/"], "linter"],
  // ---- RgFilter (context-line suppressor, first-match for rg/grep) ----
  [["grep", "-r", "pattern", "src/"], "rg"],
  [["rg", "pattern", "src/"], "rg"],
  [["ag", "pattern"], "grep"],
  // ---- GitFilter and dedicated sub-filters ----
  [["git", "status"], "git-status"],
  [["git", "log", "--oneline"], "git-log"],
  [["git", "diff", "HEAD"], "git-diff"],
  [["git", "commit", "-m", "msg"], "git-commit"],
  [["git", "push", "origin", "main"], "git-push"],
  // ---- MakeFilter ----
  [["make", "all"], "make"],
  [["ninja", "-C", "build/"], "make"],
  [["go", "build", "./..."], "go"],
  [["gradle", "build"], "gradle"],
  // ---- GoTestFilter ----
  [["go", "test", "./..."], "go-test"],
  [["go", "test", "-v", "./pkg/..."], "go-test"],
  [["go", "test", "-run", "TestFoo", "./..."], "go-test"],
  // ---- GhFilter ----
  [["gh", "run", "view", "1234"], "gh"],
  [["gh", "pr", "view", "42"], "gh"],
  [["gh", "pr", "list"], "gh"],
  [["gh", "api", "repos/foo/bar"], "gh"],
  // ---- TerraformFilter ----
  [["terraform", "plan"], "terraform"],
  [["terraform", "apply", "-auto-approve"], "terraform"],
  [["tofu", "plan"], "terraform"],
  // ---- PipFilter ----
  [["pip", "install", "requests"], "pip"],
  [["pip3", "install", "-r", "requirements.txt"], "pip"],
  // ---- UvFilter ----
  [["uv", "sync"], "uv"],
  [["uv", "add", "requests"], "uv"],
  [["uv", "pip", "install", "requests"], "uv"],
  // ---- LsFilter (precedes EzaFilter; claims ls/eza/ll/dir) ----
  [["ls", "-la"], "ls"],
  [["ls", "-lah"], "ls"],
  [["eza", "--git", "--long"], "ls"],
  [["eza", "--tree", "--level", "2"], "ls"],
  [["ll"], "ls"],
  [["dir"], "ls"],
  // ---- EzaFilter (exa only — ls/eza claimed above by LsFilter) ----
  [["exa", "--long"], "eza"],
  // ---- TreeFilter ----
  [["tree"], "tree"],
  [["tree", "-L", "3"], "tree"],
  // ---- PythonFilter ----
  [["python", "script.py"], "python"],
  [["python3", "-c", "print('hello')"], "python"],
  // ---- AnsibleFilter ----
  [["ansible", "all", "-m", "ping"], "ansible"],
  [["ansible-playbook", "site.yml"], "ansible"],
  [["ansible-playbook", "-i", "inventory.ini", "deploy.yml"], "ansible"],
  [["ansible-pull", "-U", "git@example.com:playbooks.git"], "ansible"],
  // ---- PreCommitFilter ----
  [["pre-commit", "run", "--all-files"], "pre-commit"],
  [["pre-commit", "install"], "pre-commit"],
  [["pre-commit", "autoupdate"], "pre-commit"],
  // ---- MesonFilter ----
  [["meson", "setup", "build"], "meson"],
  [["meson", "compile", "-C", "build"], "meson"],
];

describe("test_dispatch_matches", () => {
  it.each(_DISPATCH_CASES)(
    "test_dispatch_matches %j -> %s",
    (argv, expected_name) => {
      // select_filter routes each command to the expected filter.
      const result = bc.select_filter(argv);
      expect(result, `select_filter(${JSON.stringify(argv)}) returned None; expected ${expected_name}`).not.toBeNull();
      expect(result!.name).toBe(expected_name);
    },
  );
});

// ===========================================================================
// 2. No-match pass-through
// ===========================================================================

// TailTruncFilter is the last catch-all in FILTERS (always matches); commands
// not claimed by any more-specific filter now route to it. For ≤500-line
// outputs it passes through verbatim, so the change is invisible to callers.

describe("test_unknown_commands_route_to_tail_trunc", () => {
  const _TAIL_TRUNC_COMMANDS: Array<[string[]]> = [
    [["cat", "file.txt"]],
    [["ssh", "user@host"]],
    [["custom-build-tool", "--all"]],
    [["echo", "hello"]],
  ];

  it.each(_TAIL_TRUNC_COMMANDS)("test_unknown_commands_route_to_tail_trunc %j", (argv) => {
    // Commands with no specific filter now fall through to TailTruncFilter.
    const result = bc.select_filter(argv);
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(TailTruncFilter);
  });
});

it("test_no_match_output_verbatim", () => {
  // Short output from an unknown command passes through unchanged.
  // TailTruncFilter is the catch-all fallback (≤500 lines → verbatim
  // pass-through), so signal is preserved just as when GenericFilter is used.
  const stdout = "special-tool: v1.2.3 installed successfully\nDone.";
  const stderr = "";
  // Unknown command now routes to TailTruncFilter (the catch-all).
  const flt = bc.select_filter(["special-tool"]);
  expect(flt).toBeInstanceOf(TailTruncFilter);
  // Short output passes through verbatim.
  const result = flt!.apply(stdout, stderr, 0, ["special-tool"]);
  expect(result.text).toContain("special-tool: v1.2.3 installed successfully");
  expect(result.text).toContain("Done.");
});

// ===========================================================================
// 3. Filter precedence documentation
// ===========================================================================

it("test_pytest_beats_python", () => {
  // 'python -m pytest tests/' -> PytestFilter, not PythonFilter.
  const argv = ["python", "-m", "pytest", "tests/"];
  const f = bc.select_filter(argv);
  expect(f).not.toBeNull();
  expect(
    f!.name,
    "python -m pytest should route to PytestFilter, not PythonFilter; " +
      "PytestFilter precedes PythonFilter in FILTERS and PythonFilter.matches() " +
      "explicitly excludes this case.",
  ).toBe("pytest");
});

it("test_ruff_beats_linter", () => {
  // 'ruff check src/' -> RuffFilter, not LinterFilter.
  // RuffFilter is registered before LinterFilter and ruff is not in
  // LinterFilter.binaries, so this is straightforward. If the order were ever
  // swapped or ruff added to LinterFilter.binaries the test documents intent.
  const argv = ["ruff", "check", "src/"];
  const f = bc.select_filter(argv);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("ruff");
});

it("test_git_grep_routes_to_grep", () => {
  // 'git grep pattern' -> GrepFilter (not GitFilter).
  // GrepFilter.matches() has a special case for 'git grep'. GrepFilter is
  // registered *before* GitFilter in FILTERS, so it wins when the subcommand
  // is 'grep'.
  const argv = ["git", "grep", "TODO"];
  const f = bc.select_filter(argv);
  expect(f).not.toBeNull();
  expect(
    f!.name,
    "git grep should route to GrepFilter (registered before GitFilter)",
  ).toBe("grep");
});

it("test_git_status_routes_to_git_status", () => {
  // 'git status' -> GitStatusVerboseFilter (higher-fidelity, registered before GitFilter).
  const argv = ["git", "status"];
  const f = bc.select_filter(argv);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("git-status");
});

it("test_py_dot_test_dispatches_to_pytest", () => {
  // 'py.test' binary dispatches to PytestFilter.
  const result = bc.select_filter(["py.test", "tests/"]);
  expect(result, "py.test should dispatch to PytestFilter").not.toBeNull();
  expect(result!.name).toBe("pytest");
});

it("test_uv_pip_install_routes_to_uv", () => {
  // 'uv pip install pkg' is routed to UvFilter.
  // 'pip' was removed from _TWO_TOKEN_PREFIXES["uv"] triggers so _strip_prefixes
  // no longer consumes 'pip' as a dispatch keyword. The argv remains
  // ['uv', 'pip', 'install', 'mypackage'] after stripping, and UvFilter.matches()
  // finds 'uv' as the stem and 'pip' in its pm_subcommands set.
  const result = bc.select_filter(["uv", "pip", "install", "mypackage"]);
  expect(result, "uv pip install should route to UvFilter").not.toBeNull();
  expect(result!.name).toBe("uv");
});

it("test_uv_run_pytest_routes_to_pytest", () => {
  // 'uv run pytest tests/' strips the 'uv run' prefix and routes to PytestFilter.
  const argv = ["uv", "run", "pytest", "tests/"];
  const f = bc.select_filter(argv);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("pytest");
});

it("test_uv_sync_routes_to_uv_not_generic", () => {
  // 'uv sync' -> UvFilter, not GenericFilter or PipFilter.
  const argv = ["uv", "sync"];
  const f = bc.select_filter(argv);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("uv");
});

it("test_uv_run_go_routes_to_go", () => {
  // 'uv run go build ./...' strips 'uv run', leaving 'go build', -> GoFilter.
  const argv = ["uv", "run", "go", "build", "./..."];
  const f = bc.select_filter(argv);
  // 'uv run' is a two-token prefix; stripping leaves ['go', 'build', './...']
  // GoFilter (registered before MakeFilter) handles go build.
  expect(f).not.toBeNull();
  expect(f!.name).toBe("go");
});

// ===========================================================================
// 4. Golden-output tests — per filter
// ===========================================================================

// --- PytestFilter -----------------------------------------------------------

const _PYTEST_PASSING_OUTPUT =
  "============================= test session starts ==============================\n" +
  "platform linux -- Python 3.12.0, pytest-7.4.0\n" +
  "rootdir: /src\n" +
  "plugins: cov-4.1.0, xdist-3.3.1\n" +
  "collected 150 items\n" +
  "\n" +
  "...............F..............................................s................ [ 52%]\n" +
  ".................................................................[100%]\n" +
  "\n" +
  "=================================== FAILURES ===================================\n" +
  "_______________ test_login_with_bad_password _______________\n" +
  "\n" +
  "    def test_login_with_bad_password():\n" +
  '>       assert login("user", "wrong") is False\n' +
  "E       AssertionError: assert None is False\n" +
  "\n" +
  "tests/test_auth.py:42: AssertionError\n" +
  "=========================== short test summary info ============================\n" +
  "FAILED tests/test_auth.py::test_login_with_bad_password\n" +
  "========================= 1 failed, 149 passed in 2.54s ========================\n";

describe("TestPytestFilter", () => {
  it("test_failure_block_preserved", () => {
    const f = new PytestFilter();
    const out = _apply(f, { stdout: _PYTEST_PASSING_OUTPUT });
    expect(out).toContain("AssertionError: assert None is False");
    expect(out).toContain("test_login_with_bad_password");
  });

  it("test_summary_preserved", () => {
    const f = new PytestFilter();
    const out = _apply(f, { stdout: _PYTEST_PASSING_OUTPUT });
    expect(out).toContain("1 failed");
    expect(out).toContain("149 passed");
  });

  it("test_dots_progress_stripped", () => {
    const f = new PytestFilter();
    const out = _apply(f, { stdout: _PYTEST_PASSING_OUTPUT });
    // The dots line should not appear verbatim.
    expect(out).not.toContain("[ 52%]");
  });

  it("test_savings_ratio", () => {
    const f = new PytestFilter();
    // Build a large all-passing output with many dots lines to ensure savings.
    const dots = ".".repeat(80) + " [ 50%]\n";
    const big_output =
      "============================= test session starts ==============================\n" +
      "collected 500 items\n\n" +
      dots.repeat(50) +
      "\n========================= 500 passed in 10.00s ========================\n";
    const ratio = _savings_ratio(f, { stdout: big_output });
    expect(ratio, `PytestFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });

  it("test_verbose_passed_lines_collapsed", () => {
    const verbose =
      "============================= test session starts ==============================\n" +
      "collected 5 items\n\n" +
      "PASSED tests/test_a.py::test_one\n" +
      "PASSED tests/test_a.py::test_two\n" +
      "PASSED tests/test_a.py::test_three\n" +
      "========================= 3 passed in 0.10s ========================\n";
    const f = new PytestFilter();
    const out = _apply(f, { stdout: verbose });
    // PASSED lines individually stripped; summary preserved.
    expect(out).toContain("3 passed");
    // Collapsed marker present.
    expect(out).toContain("collapsed 3 PASSED");
  });

  it("test_empty_input_no_crash", () => {
    const f = new PytestFilter();
    const out = _apply(f, { stdout: "", stderr: "" });
    expect(out === "" || out.trim() === "").toBe(true);
  });
});

// --- JestFilter -------------------------------------------------------------

const _JEST_OUTPUT =
  "PASS src/components/Button.test.tsx\n" +
  "PASS src/utils/format.test.ts\n" +
  "FAIL src/api/auth.test.ts\n" +
  "  ● AuthService › login › should reject bad password\n" +
  "\n" +
  "    expect(received).toBe(expected)\n" +
  "\n" +
  "    Expected: false\n" +
  "    Received: null\n" +
  "\n" +
  "      40 |   it('should reject bad password', async () => {\n" +
  "    > 41 |     expect(await service.login('user', 'wrong')).toBe(false);\n" +
  "         |                                                  ^\n" +
  "      42 |   });\n" +
  "\n" +
  "Test Suites: 1 failed, 2 passed, 3 total\n" +
  "Tests:       1 failed, 8 passed, 9 total\n" +
  "Snapshots:   0 total\n" +
  "Time:        3.241 s\n" +
  "Ran all test suites.\n";

describe("TestJestFilter", () => {
  it("test_fail_block_preserved", () => {
    const f = new JestFilter();
    const out = _apply(f, { stdout: _JEST_OUTPUT });
    expect(out).toContain("Expected: false");
    expect(out).toContain("Received: null");
  });

  it("test_pass_lines_collapsed", () => {
    const f = new JestFilter();
    const out = _apply(f, { stdout: _JEST_OUTPUT });
    expect(out).not.toContain("PASS src/components/Button.test.tsx");
    expect(out).toContain("collapsed 2 PASS files");
  });

  it("test_summary_preserved", () => {
    const f = new JestFilter();
    const out = _apply(f, { stdout: _JEST_OUTPUT });
    expect(out).toContain("Test Suites:");
    expect(out).toContain("1 failed");
  });

  it("test_savings_ratio", () => {
    const f = new JestFilter();
    let big = Array.from({ length: 200 }, (_, i) => `PASS src/module${i}/test.spec.ts`).join("\n");
    big += "\n\nTest Suites: 200 passed, 200 total\nTests: 400 passed, 400 total\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `JestFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- CargoFilter ------------------------------------------------------------

const _CARGO_OUTPUT_STDERR =
  "   Compiling proc-macro2 v1.0.79\n" +
  "   Compiling quote v1.0.35\n" +
  "   Compiling unicode-ident v1.0.12\n" +
  "   Compiling syn v2.0.60\n" +
  "   Compiling serde_derive v1.0.197\n" +
  "   Compiling serde v1.0.197\n" +
  "   Compiling thiserror-impl v1.0.58\n" +
  "   Compiling thiserror v1.0.58\n" +
  "   Compiling my-project v0.1.0 (/src)\n" +
  "error[E0308]: mismatched types\n" +
  " --> src/main.rs:10:5\n" +
  "  |\n" +
  '10 |     "not a number"\n' +
  "  |     ^^^^^^^^^^^^^^ expected `i32`, found `&str`\n" +
  "\n" +
  "error: aborting due to previous error\n";

const _CARGO_TEST_STDOUT =
  "running 5 tests\n" +
  "test auth::test_login_ok ... ok\n" +
  "test auth::test_logout ... ok\n" +
  "test auth::test_bad_password ... FAILED\n" +
  "test db::test_connect ... ok\n" +
  "test db::test_query ... ok\n" +
  "\n" +
  "failures:\n" +
  "\n" +
  "---- auth::test_bad_password stdout ----\n" +
  "thread 'auth::test_bad_password' panicked at 'assertion failed: result.is_ok()'\n" +
  "src/auth.rs:42\n" +
  "\n" +
  "failures:\n" +
  "    auth::test_bad_password\n" +
  "\n" +
  "test result: FAILED. 1 failed; 4 passed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s\n";

const _CARGO_CLIPPY_STDERR =
  "   Checking tokio v1.38.0\n" +
  "   Checking serde v1.0.197\n" +
  "   Checking my-project v0.1.0 (/src)\n" +
  "warning: unused variable: `x`\n" +
  " --> src/main.rs:5:9\n" +
  "  |\n" +
  "5 |     let x = 1;\n" +
  "  |         ^ help: if this is intentional, prefix it with an underscore: `_x`\n" +
  "\n" +
  "warning: 1 warning emitted\n";

describe("TestCargoFilter", () => {
  it("test_error_preserved", () => {
    const f = new CargoFilter();
    const out = _apply(f, { stdout: "", stderr: _CARGO_OUTPUT_STDERR });
    expect(out).toContain("mismatched types");
    expect(out).toContain("expected `i32`, found `&str`");
  });

  it("test_compiling_lines_collapsed", () => {
    const f = new CargoFilter();
    const out = _apply(f, { stdout: "", stderr: _CARGO_OUTPUT_STDERR });
    expect(out).toContain("[compiling");
  });

  it("test_savings_ratio", () => {
    const f = new CargoFilter();
    const big_stderr =
      Array.from({ length: 100 }, (_, i) => `   Compiling crate${i} v1.0.${i}`).join("\n") +
      "\n   Finished dev [unoptimized] target(s) in 30s\n";
    const ratio = _savings_ratio(f, { stdout: "", stderr: big_stderr });
    expect(ratio, `CargoFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });

  it("test_cargo_test_pass_lines_collapsed", () => {
    const f = new CargoFilter();
    const argv = ["cargo", "test"];
    const result = f.apply(_CARGO_TEST_STDOUT, "", 1, argv);
    const out = result.text;
    expect(out).toContain("auth::test_bad_password");
    expect(out).toContain("assertion failed");
    expect(out).toContain("test result: FAILED");
    expect(out).toContain("collapsed 4 passing");
  });

  it("test_cargo_test_fail_line_preserved", () => {
    const f = new CargoFilter();
    const argv = ["cargo", "test"];
    const result = f.apply(_CARGO_TEST_STDOUT, "", 1, argv);
    expect(result.text).toContain("FAILED");
  });

  it("test_cargo_clippy_checking_lines_suppressed", () => {
    const f = new CargoFilter();
    const argv = ["cargo", "clippy"];
    const result = f.apply("", _CARGO_CLIPPY_STDERR, 0, argv);
    const out = result.text;
    expect(out).toContain("unused variable");
    expect(out).toContain("dropped");
    expect(!out.includes("Checking") || out.includes("dropped")).toBe(true);
  });

  it("test_cargo_clippy_warning_preserved", () => {
    const f = new CargoFilter();
    const argv = ["cargo", "clippy"];
    const result = f.apply("", _CARGO_CLIPPY_STDERR, 0, argv);
    expect(result.text).toContain("unused variable");
    expect(result.text).toContain("help: if this is intentional");
  });

  it("test_cargo_run_passthrough", () => {
    const f = new CargoFilter();
    const argv = ["cargo", "run"];
    const stdout = "Hello, world!\nProgram finished with code 0\n";
    const result = f.apply(stdout, "", 0, argv);
    expect(result.text).toContain("Hello, world!");
    expect(result.text).toContain("Program finished");
  });

  it("test_cargo_build_dispatches_to_build", () => {
    const f = new CargoFilter();
    const big_stderr =
      Array.from({ length: 20 }, (_, i) => `   Compiling crate${i} v1.0.${i}`).join("\n") +
      "\n   Finished dev target(s) in 5s\n";
    const result = f.apply("", big_stderr, 0, ["cargo", "build"]);
    expect(result.text).toContain("[compiling 20 crates");
    expect(result.text).not.toContain("Finished");
  });
});

// --- NodePackageFilter ------------------------------------------------------

const _NPM_OUTPUT =
  "npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.\n" +
  "npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported\n" +
  "npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported\n" +
  "npm warn deprecated @humanwhocodes/config-array@0.11.14: Use @eslint/config-array\n" +
  "\n" +
  "added 247 packages, and audited 248 packages in 12s\n" +
  "\n" +
  "34 packages are looking for funding\n" +
  "  run `npm fund` for details\n" +
  "\n" +
  "found 0 vulnerabilities\n";

describe("TestNodePackageFilter", () => {
  it("test_summary_preserved", () => {
    const f = new NodePackageFilter();
    const out = _apply(f, { stdout: _NPM_OUTPUT });
    expect(out).toContain("added 247 packages");
  });

  it("test_deprecation_warnings_collapsed", () => {
    const f = new NodePackageFilter();
    const out = _apply(f, { stdout: _NPM_OUTPUT });
    // Individual deprecation lines should be replaced with the summary.
    expect(out).toContain("collapsed 4 deprecation");
  });

  it("test_savings_ratio", () => {
    const f = new NodePackageFilter();
    const big =
      Array.from({ length: 100 }, (_, i) => `npm warn deprecated package${i}@1.0.${i}: outdated`).join("\n") +
      "\nadded 300 packages in 30s\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `NodePackageFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });

  it("test_npm_err_block_preserved", () => {
    const stderr = "npm ERR! code ENOTFOUND\nnpm ERR! network request failed\n";
    const f = new NodePackageFilter();
    const out = _apply(f, { stdout: "", stderr });
    expect(out).toContain("ENOTFOUND");
  });
});

// --- DockerFilter -----------------------------------------------------------

const _DOCKER_STDERR =
  "#1 [internal] load build definition from Dockerfile\n" +
  "#1 sha256:abcd1234ef567890abcd1234ef567890abcd1234ef567890abcd1234ef567890\n" +
  "#1 transferring dockerfile: 1.2kB 0.0s done\n" +
  "#1 DONE 0.1s\n" +
  "\n" +
  "#2 [internal] load .dockerignore\n" +
  "#2 sha256:deadbeef1234567890deadbeef1234567890deadbeef1234567890deadbeef12\n" +
  "#2 transferring context: 35B done\n" +
  "#2 DONE 0.0s\n" +
  "\n" +
  "#3 [1/3] FROM python:3.12-slim\n" +
  "#3 0.3s\n" +
  "#3 1.2MB / 50.0MB 0.5s\n" +
  "#3 50.0MB / 50.0MB 2.1s\n" +
  "#3 DONE 2.5s\n" +
  "\n" +
  "#4 [2/3] RUN pip install --no-cache-dir requests\n" +
  "#4 2.3 Successfully installed requests-2.31\n" +
  "#4 DONE 5.2s\n" +
  "\n" +
  "#5 exporting to image\n" +
  "#5 exporting layers done\n" +
  "#5 writing image sha256:f00cafe1234 done\n";

describe("TestDockerFilter", () => {
  it("test_successful_build_image_line_preserved", () => {
    const f = new DockerFilter();
    const out = _apply(f, { stdout: "", stderr: _DOCKER_STDERR });
    expect(out).toContain("writing image sha256:f00cafe1234 done");
  });

  it("test_digest_lines_dropped", () => {
    const f = new DockerFilter();
    const out = _apply(f, { stdout: "", stderr: _DOCKER_STDERR });
    expect(out).not.toContain("sha256:abcd1234ef567890");
  });

  it("test_transfer_progress_dropped", () => {
    const f = new DockerFilter();
    const out = _apply(f, { stdout: "", stderr: _DOCKER_STDERR });
    expect(out).not.toContain("50.0MB / 50.0MB");
  });

  it("test_savings_ratio", () => {
    const f = new DockerFilter();
    let big = "";
    for (let i = 1; i < 50; i += 1) {
      big += `#${i} [internal] load something\n`;
      big += `#${i} sha256:${"a".repeat(63)}\n`;
      big += `#${i} ${i}.0MB / 100.0MB 1.0s\n`;
      big += `#${i} DONE ${i}.0s\n\n`;
    }
    const ratio = _savings_ratio(f, { stdout: "", stderr: big });
    expect(ratio, `DockerFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- GrepFilter -------------------------------------------------------------

const _GREP_OUTPUT =
  Array.from(
    { length: 100 },
    (_, i) => `src/module_${Math.floor(i / 5)}.py:${i + 1}:    result = process_item(${i + 1})`,
  ).join("\n") + "\n";

describe("TestGrepFilter", () => {
  it("test_small_output_passes_through", () => {
    // Output <= 30 non-empty lines is returned verbatim.
    const f = new GrepFilter();
    const small = Array.from({ length: 10 }, (_, i) => `src/file.py:${i}: match`).join("\n");
    const out = _apply(f, { stdout: small });
    // All 10 lines should be present.
    for (let i = 0; i < 10; i += 1) {
      expect(out).toContain(`src/file.py:${i}: match`);
    }
  });

  it("test_large_output_gets_summary", () => {
    const f = new GrepFilter();
    const out = _apply(f, { stdout: _GREP_OUTPUT });
    expect(out).toContain("grep:");
    expect(out).toContain("matches across");
  });

  it("test_summary_includes_file_counts", () => {
    const f = new GrepFilter();
    const out = _apply(f, { stdout: _GREP_OUTPUT });
    // Should show per-file match counts.
    expect(out).toContain("match(es)");
  });

  it("test_savings_ratio", () => {
    const f = new GrepFilter();
    const ratio = _savings_ratio(f, { stdout: _GREP_OUTPUT });
    expect(ratio, `GrepFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });

  it("test_git_grep_argv_matches", () => {
    // GrepFilter.matches() accepts ['git', 'grep', 'pattern'] after prefix stripping.
    const f = new GrepFilter();
    expect(f.matches(["git", "grep", "TODO"])).toBe(true);
    expect(f.matches(["git", "status"])).toBe(false);
  });
});

// --- RuffFilter -------------------------------------------------------------

const _RUFF_OUTPUT =
  "src/module_a.py:10:80: E501 Line too long (82 > 79 characters)\n" +
  "src/module_b.py:15:80: E501 Line too long (95 > 79 characters)\n" +
  "src/module_c.py:22:80: E501 Line too long (88 > 79 characters)\n" +
  "src/module_a.py:5:1: F401 `os` imported but unused\n" +
  "src/module_b.py:3:1: F401 `sys` imported but unused\n" +
  "src/module_a.py:8:1: F401 `re` imported but unused\n" +
  "src/module_c.py:2:1: F401 `typing.List` imported but unused\n" +
  "src/module_d.py:100:5: E711 Comparison to `None` (use `is` or `is not`)\n" +
  "Found 8 errors.\n";

describe("TestRuffFilter", () => {
  it("test_footer_preserved", () => {
    const f = new RuffFilter();
    const out = _apply(f, { stdout: _RUFF_OUTPUT });
    expect(out).toContain("Found 8 errors.");
  });

  it("test_high_frequency_rule_summarised", () => {
    // E501 fires 3 times across 3 files -> should be summarised.
    const f = new RuffFilter();
    const out = _apply(f, { stdout: _RUFF_OUTPUT });
    expect(out).toContain("E501: 3 occurrences in 3 files");
  });

  it("test_low_frequency_rule_kept_verbatim", () => {
    // E711 fires only once -> kept verbatim, not summarised.
    const f = new RuffFilter();
    const out = _apply(f, { stdout: _RUFF_OUTPUT });
    expect(out).toContain("E711");
    expect(out).toContain("Comparison to `None`");
  });

  it("test_savings_ratio", () => {
    const f = new RuffFilter();
    let big = "";
    for (let i = 1; i <= 100; i += 1) {
      big += `src/file_${i % 5}.py:${i}:80: E501 Line too long (${80 + i} > 79)\n`;
    }
    big += "Found 100 errors.\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `RuffFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- MypyFilter -------------------------------------------------------------

const _MYPY_OUTPUT =
  'src/auth.py:10: error: Incompatible return value type (got "None", expected "str")\n' +
  'src/auth.py:25: error: Incompatible return value type (got "None", expected "str")\n' +
  'src/auth.py:40: error: Incompatible return value type (got "None", expected "str")\n' +
  'src/auth.py:55: error: Incompatible return value type (got "None", expected "str")\n' +
  'src/models.py:5: error: Name "User" is not defined\n' +
  "src/models.py:10: note: See https://mypy.readthedocs.io/en/stable/error_codes.html\n" +
  'src/utils.py:3: error: Module "missing_mod" has no attribute "helper"\n' +
  "Found 6 errors in 3 files (checked 5 source files)\n";

describe("TestMypyFilter", () => {
  it("test_summary_preserved", () => {
    const f = new MypyFilter();
    const out = _apply(f, { stdout: _MYPY_OUTPUT });
    expect(out).toContain("Found 6 errors in 3 files");
  });

  it("test_duplicate_error_messages_collapsed", () => {
    // The repeated 'Incompatible return value' error should be deduped.
    const f = new MypyFilter();
    const out = _apply(f, { stdout: _MYPY_OUTPUT });
    expect(out.includes("suppressed") || out.includes("duplicate")).toBe(true);
  });

  it("test_see_https_note_dropped", () => {
    const f = new MypyFilter();
    const out = _apply(f, { stdout: _MYPY_OUTPUT });
    expect(out).not.toContain("mypy.readthedocs.io");
  });

  it("test_unique_errors_preserved", () => {
    const f = new MypyFilter();
    const out = _apply(f, { stdout: _MYPY_OUTPUT });
    expect(out).toContain('Module "missing_mod"');
    expect(out).toContain('Name "User" is not defined');
  });

  it("test_savings_ratio", () => {
    const f = new MypyFilter();
    let big = "";
    for (let i = 1; i <= 200; i += 1) {
      big += `src/file_${i % 10}.py:${i}: error: Incompatible return value type (got "None", expected "str")\n`;
    }
    big += "Found 200 errors in 10 files\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `MypyFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- GitFilter --------------------------------------------------------------

const _GIT_STATUS_OUTPUT =
  "On branch main\n" +
  "Your branch is up to date with 'origin/main'.\n" +
  "\n" +
  "Changes to be committed:\n" +
  '  (use "git restore --staged <file>..." to unstage)\n' +
  "\tmodified:   src/auth.py\n" +
  "\tnew file:   src/oauth.py\n" +
  "\n" +
  "Changes not staged for commit:\n" +
  '  (use "git add <file>..." to update what will be committed)\n';

const _GIT_LOG_OUTPUT = Array.from(
  { length: 15 },
  (_, i) =>
    `commit ${"a".repeat(40)}\nAuthor: Dev <dev@example.com>\nDate: Mon Jan ${String(i + 1).padStart(2, "0")} 00:00:00 2024\n\n    Commit message ${i + 1}\n`,
).join("");

describe("TestGitFilter", () => {
  it("test_status_headers_preserved", () => {
    const f = new GitFilter();
    const out = f.compress(_GIT_STATUS_OUTPUT, "", 0, ["git", "status"]);
    expect(out).toContain("Changes to be committed");
    expect(out).toContain("Changes not staged for commit");
  });

  it("test_status_file_list_preserved", () => {
    const f = new GitFilter();
    const out = f.compress(_GIT_STATUS_OUTPUT, "", 0, ["git", "status"]);
    expect(out).toContain("src/auth.py");
    expect(out).toContain("src/oauth.py");
  });

  it("test_long_log_collapses_older_commits", () => {
    // git log with >10 commits should collapse older entries.
    const f = new GitFilter();
    const out = f.compress(_GIT_LOG_OUTPUT, "", 0, ["git", "log"]);
    expect(out.includes("elided") || out.includes("earlier commits")).toBe(true);
  });

  it("test_diff_hunk_limit", () => {
    // git diff with many hunks per file should truncate.
    // Mirror the Python test template byte-for-byte: each line newline-terminated
    // (so concatenated hunks keep every "@@" at line-start), constant {n} per hunk.
    const hunkTemplate = (n: number): string =>
      `@@ -${n},10 +${n},10 @@\n` + `-old line ${n}\n`.repeat(5) + `+new line ${n}\n`.repeat(5);
    let diff = "diff --git a/big.py b/big.py\n--- a/big.py\n+++ b/big.py\n";
    for (let i = 0; i < 10; i += 1) {
      diff += hunkTemplate(i * 10);
    }
    const f = new GitFilter();
    const out = f.compress(diff, "", 0, ["git", "diff"]);
    expect(out).toContain("more hunks");
  });

  it("test_push_drops_remote_counting", () => {
    const stderr =
      "remote: Counting objects: 5, done.\n" +
      "remote: Compressing objects: 100% (3/3), done.\n" +
      "remote: Total 5 (delta 1), reused 0 (delta 0)\n" +
      "To github.com:user/repo.git\n" +
      "   abc1234..def5678  main -> main\n";
    const f = new GitFilter();
    const out = f.compress("", stderr, 0, ["git", "push"]);
    // ref-update line must survive.
    expect(out).toContain("main -> main");
    // Remote counting lines should be dropped.
    expect(out).not.toContain("Counting objects");
  });
});

// --- MakeFilter -------------------------------------------------------------

const _MAKE_OUTPUT_STDERR =
  "make[1]: Entering directory '/src/build'\n" +
  "cc -O2 -Wall -c src/main.c -o build/main.o\n" +
  "cc -O2 -Wall -c src/utils.c -o build/utils.o\n" +
  "src/utils.c:42:5: warning: implicit declaration of function 'helper' [-Wimplicit-function-declaration]\n" +
  "cc -O2 -Wall -c src/extra.c -o build/extra.o\n" +
  "gcc build/main.o build/utils.o build/extra.o -o myprogram\n" +
  "make[1]: Leaving directory '/src/build'\n";

describe("TestMakeFilter", () => {
  it("test_warning_preserved", () => {
    const f = new MakeFilter();
    const out = _apply(f, { stdout: "", stderr: _MAKE_OUTPUT_STDERR });
    expect(out).toContain("implicit declaration");
  });

  it("test_recurse_lines_dropped", () => {
    const f = new MakeFilter();
    const out = _apply(f, { stdout: "", stderr: _MAKE_OUTPUT_STDERR });
    // The raw "Entering/Leaving directory" lines should not appear verbatim.
    // The filter replaces them with a summary marker that mentions the words
    // "Entering/Leaving directory" in a count line, which is acceptable.
    // Verify the original lines are gone (not verbatim match).
    expect(out).not.toContain("make[1]: Entering directory");
    expect(out).not.toContain("make[1]: Leaving directory");
  });

  it("test_compiler_echoes_dropped", () => {
    const f = new MakeFilter();
    const out = _apply(f, { stdout: "", stderr: _MAKE_OUTPUT_STDERR });
    // 'cc' lines without warnings/errors should be dropped.
    expect(out).not.toContain("cc -O2 -Wall -c src/main.c");
  });

  it("test_savings_ratio", () => {
    const f = new MakeFilter();
    let big = "";
    for (let i = 0; i < 50; i += 1) {
      big += `make[1]: Entering directory '/src/sub${i}'\n`;
      big += `cc -O2 -Wall -c src/file${i}.c -o build/file${i}.o\n`;
      big += `make[1]: Leaving directory '/src/sub${i}'\n`;
    }
    const ratio = _savings_ratio(f, { stdout: "", stderr: big });
    expect(ratio, `MakeFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- TerraformFilter --------------------------------------------------------

const _TF_OUTPUT =
  "aws_s3_bucket.main: Refreshing state... [id=my-bucket]\n" +
  "aws_iam_role.lambda: Refreshing state... [id=my-lambda-role]\n" +
  "aws_lambda_function.api: Refreshing state... [id=my-api]\n" +
  "aws_cloudfront_distribution.cdn: Reading...\n" +
  "aws_cloudfront_distribution.cdn: Read complete after 1s [id=ABCDEFGHIJK]\n" +
  "\n" +
  "Terraform used the selected providers to generate the following execution plan.\n" +
  "\n" +
  "Plan: 2 to add, 1 to change, 0 to destroy.\n" +
  "\n" +
  "  # aws_s3_bucket.logs will be created\n" +
  '  + resource "aws_s3_bucket" "logs" {\n' +
  '      + bucket = "my-logs-bucket"\n' +
  "    }\n" +
  "\n" +
  "Apply complete! Resources: 2 added, 1 changed, 0 destroyed.\n";

describe("TestTerraformFilter", () => {
  it("test_plan_line_preserved", () => {
    const f = new TerraformFilter();
    const out = _apply(f, { stdout: _TF_OUTPUT });
    expect(out).toContain("Plan: 2 to add");
  });

  it("test_apply_complete_preserved", () => {
    const f = new TerraformFilter();
    const out = _apply(f, { stdout: _TF_OUTPUT });
    expect(out).toContain("Apply complete!");
  });

  it("test_refresh_lines_dropped", () => {
    const f = new TerraformFilter();
    const out = _apply(f, { stdout: _TF_OUTPUT });
    expect(out).not.toContain("Refreshing state");
    expect(out).not.toContain("Read complete");
  });

  it("test_savings_ratio", () => {
    const f = new TerraformFilter();
    const big =
      Array.from({ length: 100 }, (_, i) => `aws_resource_${i}.item: Refreshing state... [id=resource-${i}]`).join("\n") +
      "\nPlan: 0 to add, 0 to change, 0 to destroy.\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `TerraformFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- PipFilter --------------------------------------------------------------

const _PIP_OUTPUT =
  "Collecting requests\n" +
  "  Downloading requests-2.31.0-py3-none-any.whl (62 kB)\n" +
  "Collecting charset-normalizer<4,>=2\n" +
  "  Downloading charset_normalizer-3.3.2-cp312-cp312-linux_x86_64.whl (507 kB)\n" +
  "Collecting idna<4,>=2.5\n" +
  "  Downloading idna-3.7-py3-none-any.whl (66 kB)\n" +
  "Collecting urllib3<3,>=1.21.1\n" +
  "  Downloading urllib3-2.2.1-py3-none-any.whl (54 kB)\n" +
  "Collecting certifi>=2017.4.17\n" +
  "  Downloading certifi-2024.2.2-py3-none-any.whl (163 kB)\n" +
  "Installing collected packages: certifi, idna, urllib3, charset-normalizer, requests\n" +
  "Successfully installed certifi-2024.2.2 charset-normalizer-3.3.2 idna-3.7 requests-2.31.0 urllib3-2.2.1\n";

describe("TestPipFilter", () => {
  it("test_success_line_preserved", () => {
    const f = new PipFilter();
    const out = _apply(f, { stdout: _PIP_OUTPUT });
    expect(out).toContain("Successfully installed");
  });

  it("test_downloading_lines_dropped", () => {
    const f = new PipFilter();
    const out = _apply(f, { stdout: _PIP_OUTPUT });
    expect(out).not.toContain("Downloading requests-2.31.0");
  });

  it("test_collecting_lines_limited", () => {
    const f = new PipFilter();
    const out = _apply(f, { stdout: _PIP_OUTPUT });
    // Only first 5 'Collecting' lines kept; there are exactly 5 so all kept.
    expect(out).toContain("Collecting requests");
  });

  it("test_savings_ratio", () => {
    const f = new PipFilter();
    let big = "";
    for (let i = 0; i < 50; i += 1) {
      big += `Collecting package${i}\n`;
      big += `  Downloading package${i}-1.0.whl (100 kB)\n`;
    }
    big += "Installing collected packages: " + Array.from({ length: 50 }, (_, i) => `package${i}`).join(" ") + "\n";
    big += "Successfully installed all packages\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `PipFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- UvFilter ---------------------------------------------------------------

const _UV_OUTPUT =
  "Resolved 150 packages in 1.23s\n" +
  "   Downloading pydantic-2.6.4-cp312-cp312-linux_x86_64.whl (2.4 MB)\n" +
  "   Fetching pydantic-core-2.16.3-cp312-cp312-linux_x86_64.whl (2.1 MB)\n" +
  "   + pydantic==2.6.4\n" +
  "   + pydantic-core==2.16.3\n" +
  "   + annotated-types==0.6.0\n" +
  "Installed 3 packages in 0.89s\n";

describe("TestUvFilter", () => {
  it("test_resolved_and_installed_preserved", () => {
    const f = new UvFilter();
    const out = _apply(f, { stdout: _UV_OUTPUT });
    expect(out).toContain("Resolved 150 packages");
    expect(out).toContain("Installed 3 packages");
  });

  it("test_downloading_lines_dropped", () => {
    const f = new UvFilter();
    const out = _apply(f, { stdout: _UV_OUTPUT });
    expect(out).not.toContain("Downloading pydantic");
    expect(out).not.toContain("Fetching pydantic-core");
  });

  it("test_diff_lines_dropped", () => {
    const f = new UvFilter();
    const out = _apply(f, { stdout: _UV_OUTPUT });
    expect(out).not.toContain("+ pydantic==2.6.4");
    expect(out).not.toContain("+ pydantic-core==2.16.3");
  });

  it("test_savings_ratio", () => {
    const f = new UvFilter();
    let big = "Resolved 300 packages in 2.5s\n";
    for (let i = 0; i < 100; i += 1) {
      big += `   Downloading package${i}-1.0.whl (1.0 MB)\n`;
      big += `   + package${i}==1.0\n`;
    }
    big += "Installed 100 packages in 5.0s\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `UvFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });

  it("test_uv_run_not_matched", () => {
    // 'uv run my_script.py' is NOT a package-management subcommand.
    const f = new UvFilter();
    expect(f.matches(["uv", "run", "my_script.py"])).toBe(false);
  });

  it("test_uv_sync_matched", () => {
    const f = new UvFilter();
    expect(f.matches(["uv", "sync"])).toBe(true);
  });

  it("test_uv_add_matched", () => {
    const f = new UvFilter();
    expect(f.matches(["uv", "add", "requests"])).toBe(true);
  });
});

// --- PythonFilter -----------------------------------------------------------

const _PYTHON_TRACEBACK =
  "Running analysis...\n" +
  "Traceback (most recent call last):\n" +
  '  File "script.py", line 5, in <module>\n' +
  "    main()\n" +
  '  File "script.py", line 3, in main\n' +
  "    result = compute(None)\n" +
  '  File "script.py", line 10, in compute\n' +
  "    return value.strip()\n" +
  "AttributeError: 'NoneType' object has no attribute 'strip'\n";

const _PYTHON_LONG_TRACEBACK =
  "Traceback (most recent call last):\n" +
  Array.from(
    { length: 15 },
    (_, i) => `  File "frame${i}.py", line ${i}, in func${i}\n    code_${i}()\n`,
  ).join("") +
  "RuntimeError: deep error\n";

describe("TestPythonFilter", () => {
  it("test_error_line_preserved", () => {
    const f = new PythonFilter();
    const out = _apply(f, { stderr: _PYTHON_TRACEBACK });
    expect(out).toContain("AttributeError");
    expect(out).toContain("'NoneType' object has no attribute 'strip'");
  });

  it("test_innermost_frame_preserved", () => {
    const f = new PythonFilter();
    const out = _apply(f, { stderr: _PYTHON_TRACEBACK });
    // The innermost frame is the one in compute().
    expect(out).toContain("return value.strip()");
  });

  it("test_intermediate_frames_stripped", () => {
    const f = new PythonFilter();
    const out = _apply(f, { stderr: _PYTHON_TRACEBACK });
    // Middle frame (in main()) should be stripped for short tracebacks.
    expect(out).not.toContain("result = compute(None)");
  });

  it("test_long_traceback_compressed", () => {
    const f = new PythonFilter();
    const out = _apply(f, { stderr: _PYTHON_LONG_TRACEBACK });
    // Error line must survive.
    expect(out).toContain("RuntimeError: deep error");
    // An omission marker must appear (>10 frames triggers compression).
    expect(out).toContain("frames omitted");
  });

  it("test_savings_ratio", () => {
    const f = new PythonFilter();
    const ratio = _savings_ratio(f, { stdout: "", stderr: _PYTHON_LONG_TRACEBACK });
    expect(ratio, `PythonFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });

  it("test_no_traceback_passes_through", () => {
    // Plain output without tracebacks is not mangled.
    const stdout = "Result: 42\nDone in 0.01s\n";
    const f = new PythonFilter();
    const out = _apply(f, { stderr: stdout });
    expect(out).toContain("Result: 42");
  });

  it("test_python_minus_m_pytest_not_matched", () => {
    // PythonFilter explicitly excludes 'python -m pytest'.
    const f = new PythonFilter();
    expect(f.matches(["python", "-m", "pytest", "tests/"])).toBe(false);
  });
});

// --- LinterFilter -----------------------------------------------------------

const _ESLINT_OUTPUT =
  "/src/components/Button.tsx\n" +
  "  10:5   error    'React' must be in scope when using JSX  react/react-in-jsx-scope\n" +
  "  15:10  warning  'onClick' is missing in props validation  react/prop-types\n" +
  "  20:3   error    'React' must be in scope when using JSX  react/react-in-jsx-scope\n" +
  "  25:8   error    'React' must be in scope when using JSX  react/react-in-jsx-scope\n" +
  "  30:15  warning  'onClick' is missing in props validation  react/prop-types\n" +
  "  35:1   error    'React' must be in scope when using JSX  react/react-in-jsx-scope\n" +
  "\n" +
  "/src/utils/format.ts\n" +
  "  5:1    error    'unused' is defined but never used  no-unused-vars\n" +
  "\n" +
  "✖ 7 problems (5 errors, 2 warnings)\n";

describe("TestLinterFilter", () => {
  it("test_summary_line_preserved", () => {
    const f = new LinterFilter();
    const out = f.compress(_ESLINT_OUTPUT, "", 0, ["eslint"]);
    expect(out).toContain("7 problems");
  });

  it("test_high_frequency_rule_collapsed", () => {
    // react/react-in-jsx-scope fires 4 times -> should be collapsed to 3 + marker.
    const f = new LinterFilter();
    const out = f.compress(_ESLINT_OUTPUT, "", 0, ["eslint"]);
    // At most 3 occurrences kept, then +N marker.
    expect(out).toContain("+1 more react/react-in-jsx-scope violations");
  });

  it("test_unique_rule_preserved", () => {
    const f = new LinterFilter();
    const out = f.compress(_ESLINT_OUTPUT, "", 0, ["eslint"]);
    expect(out).toContain("no-unused-vars");
  });

  it("test_savings_ratio", () => {
    const f = new LinterFilter();
    const lines: string[] = ["/src/App.tsx"];
    for (let i = 0; i < 50; i += 1) {
      lines.push(`  ${i}:1  error  msg  react/react-in-jsx-scope`);
    }
    lines.push("\n✖ 50 problems");
    const big = lines.join("\n");
    const out = f.compress(big, "", 0, ["eslint"]);
    const ratio = 1.0 - Buffer.byteLength(out, "utf8") / Math.max(1, Buffer.byteLength(big, "utf8"));
    expect(ratio, `LinterFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- KubectlFilter ----------------------------------------------------------

const _KUBECTL_GET_OUTPUT =
  "NAME                          READY   STATUS    RESTARTS   AGE\n" +
  Array.from({ length: 50 }, (_, i) => `pod-${String(i + 1).padStart(4, "0")}-abc123            1/1     Running   0          ${i + 1}d`).join("\n") +
  "\n";

describe("TestKubectlFilter", () => {
  it("test_table_header_preserved", () => {
    const f = new KubectlFilter();
    const out = f.compress(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"]);
    expect(out).toContain("NAME");
    expect(out).toContain("STATUS");
  });

  it("test_long_table_truncated", () => {
    const f = new KubectlFilter();
    const out = f.compress(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"]);
    expect(out).toContain("more rows");
  });

  it("test_first_rows_kept", () => {
    const f = new KubectlFilter();
    const out = f.compress(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"]);
    expect(out).toContain("pod-0001");
  });

  it("test_savings_ratio", () => {
    const f = new KubectlFilter();
    const result = f.apply(_KUBECTL_GET_OUTPUT, "", 0, ["kubectl", "get"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio, `KubectlFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });
});

// --- GoTestFilter ----------------------------------------------------------

// Synthetic `go test -v` output exercising every line shape the filter
// recognises: package result, per-test RUN/PASS/FAIL lifecycle, indented
// Errorf body under a FAIL, download-progress noise.
const _GO_TEST_OUTPUT =
  "go: downloading github.com/stretchr/testify v1.8.0\n" +
  "=== RUN   TestAdd\n" +
  "--- PASS: TestAdd (0.00s)\n" +
  "=== RUN   TestSub\n" +
  "--- PASS: TestSub (0.00s)\n" +
  "=== RUN   TestDiv\n" +
  "=== PAUSE TestDiv\n" +
  "=== CONT  TestDiv\n" +
  "    math_test.go:42: divisor must be non-zero\n" +
  "    math_test.go:43: got 0, want 1\n" +
  "--- FAIL: TestDiv (0.00s)\n" +
  "=== RUN   TestMul\n" +
  "--- PASS: TestMul (0.00s)\n" +
  "FAIL\n" +
  "exit status 1\n" +
  "FAIL\texample.com/mypkg\t0.123s\n" +
  "ok  \texample.com/otherpkg\t0.045s\n" +
  "?   \texample.com/emptypkg\t[no test files]\n";

describe("TestGoTestFilter", () => {
  it("test_fail_block_preserved", () => {
    const f = new bc.GoTestFilter();
    const out = _apply(f, { stdout: _GO_TEST_OUTPUT });
    expect(out).toContain("--- FAIL: TestDiv");
    // The indented body lines under the FAIL must survive verbatim so the
    // agent can see the actual failure message.
    expect(out).toContain("math_test.go:42: divisor must be non-zero");
    expect(out).toContain("math_test.go:43: got 0, want 1");
  });

  it("test_pass_lines_collapsed", () => {
    const f = new bc.GoTestFilter();
    const out = _apply(f, { stdout: _GO_TEST_OUTPUT });
    // Passing testcases are summarised to a count, not listed individually.
    expect(out).not.toContain("--- PASS: TestAdd");
    expect(out).not.toContain("--- PASS: TestMul");
    // …and a collapse marker is present.
    expect(out).toContain("collapsed 3 PASS testcases");
  });

  it("test_package_results_kept", () => {
    const f = new bc.GoTestFilter();
    const out = _apply(f, { stdout: _GO_TEST_OUTPUT });
    expect(out).toContain("FAIL\texample.com/mypkg");
    expect(out).toContain("ok  \texample.com/otherpkg");
    expect(out).toContain("?   \texample.com/emptypkg");
  });

  it("test_run_lines_dropped_outside_fail", () => {
    const f = new bc.GoTestFilter();
    const out = _apply(f, { stdout: _GO_TEST_OUTPUT });
    // === RUN for passing testcases dropped (no signal value).
    expect(out).not.toContain("=== RUN   TestAdd");
  });

  it("test_download_lines_dropped", () => {
    const f = new bc.GoTestFilter();
    const out = _apply(f, { stdout: _GO_TEST_OUTPUT });
    // The original verbatim line is removed; the summary marker
    // ("dropped 1 'go: downloading' lines") may quote the string by
    // design, so check for the verbatim package@version reference.
    expect(out).not.toContain("go: downloading github.com/stretchr/testify v1.8.0");
    expect(out).toContain("dropped 1 'go: downloading' lines");
  });

  it("test_savings_ratio_large_pass_run", () => {
    const f = new bc.GoTestFilter();
    const big_lines: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      big_lines.push(`=== RUN   TestCase${String(i).padStart(3, "0")}`);
      big_lines.push(`--- PASS: TestCase${String(i).padStart(3, "0")} (0.00s)`);
    }
    big_lines.push("PASS");
    big_lines.push("ok  \texample.com/big\t0.500s");
    const big = big_lines.join("\n") + "\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `GoTestFilter savings ${(ratio * 100).toFixed(0)}% < 80% on big pass run`).toBeGreaterThanOrEqual(0.8);
  });
});

// --- GhFilter --------------------------------------------------------------

const _GH_RUN_VIEW_OUTPUT =
  "X main · 1234567 · push\n" +
  "Triggered via push about 2 minutes ago\n" +
  "\n" +
  "JOBS\n" +
  "✓ build (ID 9876)\n" +
  "  Set up job\n" +
  "  Run actions/checkout@v4\n" +
  "  Run actions/setup-node@v4\n" +
  "  Install dependencies\n" +
  "  Build\n" +
  "  Complete job\n" +
  "✓ lint (ID 9877)\n" +
  "  Set up job\n" +
  "  Run actions/checkout@v4\n" +
  "  Run ESLint\n" +
  "  Complete job\n" +
  "X test (ID 9878)\n" +
  "  Set up job\n" +
  "  Run actions/checkout@v4\n" +
  "  Run tests\n" +
  "  Error: Test failed at src/foo.test.js:42\n" +
  "  Process completed with exit code 1\n" +
  "  Complete job\n" +
  "\n" +
  "ANNOTATIONS\n" +
  "X test\n" +
  "  Test failed at src/foo.test.js:42\n";

const _GH_PR_LIST_OUTPUT =
  "Showing 3 of 3 open pull requests in owner/repo\n" +
  "\n" +
  "#42  Add feature X     feat/x        about 1 hour ago\n" +
  "#41  Fix bug Y         fix/y         about 2 hours ago\n" +
  "#40  Refactor module Z refactor/z    about 1 day ago\n";

describe("TestGhFilter", () => {
  it("test_run_view_failing_step_preserved", () => {
    const f = new GhFilter();
    const out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"]);
    // The X (failing step) line and everything under it must be preserved.
    expect(out).toContain("X test (ID 9878)");
    expect(out).toContain("Error: Test failed at src/foo.test.js:42");
    expect(out).toContain("Process completed with exit code 1");
  });

  it("test_run_view_passing_steps_collapsed", () => {
    const f = new GhFilter();
    const out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"]);
    // Passing step headers (✓ build, ✓ lint) collapsed to a count.
    expect(out).not.toContain("✓ build");
    expect(out).not.toContain("✓ lint");
    expect(out).toContain("collapsed 2 passing step headers");
  });

  it("test_run_view_action_preamble_dropped", () => {
    const f = new GhFilter();
    const out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"]);
    // The "  Run actions/checkout@v4" preamble lines under PASSING steps
    // should be dropped; the same lines under the FAILING step are preserved
    // because that block stays verbatim.
    // Count occurrences in the output: passing-step preambles are gone.
    // 1 occurrence remains (under the failing X test step).
    const count = out.split("Run actions/checkout@v4").length - 1;
    expect(count).toBe(1);
  });

  it("test_run_view_annotations_kept", () => {
    const f = new GhFilter();
    const out = f.compress(_GH_RUN_VIEW_OUTPUT, "", 1, ["gh", "run", "view", "1234"]);
    expect(out).toContain("ANNOTATIONS");
    expect(out).toContain("Test failed at src/foo.test.js:42");
  });

  it("test_pr_list_passes_through", () => {
    const f = new GhFilter();
    const out = f.compress(_GH_PR_LIST_OUTPUT, "", 0, ["gh", "pr", "list"]);
    // Every PR row is load-bearing — pass-through preserves them all.
    expect(out).toContain("#42");
    expect(out).toContain("#41");
    expect(out).toContain("#40");
  });

  it("test_run_list_truncates_large_output", () => {
    const f = new GhFilter();
    // Build a large list with 50 runs (>30 threshold).
    const header = "Showing 50 of 50 runs in owner/repo\n";
    const rows = Array.from({ length: 50 }, (_, i) => `status-${String(i).padStart(3, "0")}\t#run-${String(i).padStart(4, "0")}\thttps://github.com/run/${i}`);
    const big_output = header + rows.join("\n");
    const out = f.compress(big_output, "", 0, ["gh", "run", "list"]);
    // Should truncate to 30 rows and emit count.
    expect(out).toContain("showing first 30 of 50 runs");
    // Check that some early rows are present and some late rows are not.
    expect(out.includes("run-0000") || out.includes("run-0001")).toBe(true);
    expect(out).not.toContain("run-0049"); // Last row should be elided
  });

  it("test_run_view_savings_ratio", () => {
    const f = new GhFilter();
    // Many passing steps with deep preambles.
    const big_lines: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      big_lines.push(`✓ step-${String(i).padStart(3, "0")} (ID ${i})`);
      for (const action of ["checkout@v4", "setup-node@v4", "cache@v3"]) {
        big_lines.push(`  Run actions/${action}`);
      }
      big_lines.push("  Build");
      big_lines.push("  Complete job");
    }
    big_lines.push("X test (ID 999)");
    big_lines.push("  Error: kaboom");
    const big = big_lines.join("\n") + "\n";
    const result = f.apply(big, "", 1, ["gh", "run", "view", "1"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio, `GhFilter savings ${(ratio * 100).toFixed(0)}% < 50% on big run view`).toBeGreaterThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
// 4b. FzfFilter — fuzzy finder output
// ---------------------------------------------------------------------------

describe("TestFzfFilter", () => {
  it("test_fzf_small_output_passes_through", () => {
    const f = new FzfFilter();
    // Fzf typically outputs 1-5 lines (selected items).
    const output = "file1.py\nfile2.py\nfile3.py";
    const out = f.compress(output, "", 0, ["fzf"]);
    expect(out).toContain("file1.py");
    expect(out).toContain("file2.py");
    expect(out).toContain("file3.py");
  });

  it("test_fzf_large_output_truncates", () => {
    const f = new FzfFilter();
    // Generate >50 lines of output (e.g., from an upstream pipe).
    const lines = Array.from({ length: 75 }, (_, i) => `candidate-${String(i).padStart(3, "0")}`);
    const output = lines.join("\n");
    const out = f.compress(output, "", 0, ["fzf"]);
    // Should truncate and emit elision marker.
    // Keeps first 40 (candidate-000 to candidate-039) + last 10 (candidate-065 to candidate-074).
    expect(out).toContain("candidate-000");
    expect(out).toContain("candidate-039");
    expect(out).not.toContain("candidate-064"); // Middle section elided
    expect(out).toContain("candidate-065"); // Last 10 kept
    expect(out).toContain("25 more lines elided"); // 75 - 40 - 10 = 25
  });
});

// ---------------------------------------------------------------------------
// 4c. LazyGitFilter — git TUI
// ---------------------------------------------------------------------------

describe("TestLazyGitFilter", () => {
  it("test_lazygit_tui_output_returns_note", () => {
    const f = new LazyGitFilter();
    // Simulated terminal control output (ANSI escape codes).
    const output = "\x1b[2J\x1b[H\x1b[1;32mLazyGit\x1b[0m";
    const out = f.compress(output, "", 0, ["lazygit"]);
    expect(out).toContain("interactive terminal UI");
    expect(out).toContain("not piped");
  });

  it("test_lazygit_empty_output_returns_note", () => {
    const f = new LazyGitFilter();
    const output = "";
    const out = f.compress(output, "", 0, ["lazygit"]);
    expect(out).toContain("interactive terminal UI");
  });

  it("test_lazygit_plain_text_output_passes_through", () => {
    const f = new LazyGitFilter();
    // Unusual but possible: plain text output (no ANSI codes, non-empty).
    const output = "Commit: abc123\nAuthor: Someone\n";
    const out = f.compress(output, "", 0, ["lazygit"]);
    expect(out).toContain("Commit: abc123");
    expect(out).toContain("Author: Someone");
  });
});

// ---------------------------------------------------------------------------
// 5. detect_from_command convenience wrapper
// ---------------------------------------------------------------------------

describe("TestDetectFromCommand", () => {
  it("test_simple_command_detected", () => {
    const result = bc.detect_from_command("pytest tests/");
    expect(result).not.toBeNull();
    const [filter_] = result!;
    expect(filter_.name).toBe("pytest");
  });

  it("test_command_with_pipe_not_detected", () => {
    // Commands with shell operators are intentionally skipped.
    expect(bc.detect_from_command("pytest tests/ | head -20")).toBeNull();
  });

  it("test_command_with_redirect_not_detected", () => {
    expect(bc.detect_from_command("pytest tests/ > output.log")).toBeNull();
  });

  it("test_empty_command_returns_none", () => {
    expect(bc.detect_from_command("")).toBeNull();
  });

  it("test_unknown_command_routes_to_tail_trunc", () => {
    // TailTruncFilter is the catch-all; detect_from_command now returns it.
    const result = bc.detect_from_command("unknown-tool --flag");
    expect(result).not.toBeNull();
    const [filter_] = result!;
    expect(filter_).toBeInstanceOf(TailTruncFilter);
  });

  it("test_prefix_stripped_correctly", () => {
    const result = bc.detect_from_command("sudo uv run pytest tests/");
    expect(result).not.toBeNull();
    const [filter_] = result!;
    expect(filter_.name).toBe("pytest");
  });
});

// ---------------------------------------------------------------------------
// 6. FILTERS registry completeness
// ---------------------------------------------------------------------------

it("test_all_filter_names_unique", () => {
  // Every filter in FILTERS must have a unique name.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.length, `Duplicate filter names: ${JSON.stringify(names)}`).toBe(new Set(names).size);
});

it("test_filter_by_name_round_trips", () => {
  // filter_by_name(f.name) returns the same filter for every registered filter.
  for (const f of bc.FILTERS) {
    const found = bc.filter_by_name(f.name);
    expect(found, `filter_by_name(${JSON.stringify(f.name)}) returned None`).not.toBeNull();
    expect(found!.name).toBe(f.name);
  }
});

it("test_filters_list_covers_expected_tools", () => {
  // Verify the expected set of tool names is covered by the registry.
  const names = new Set(bc.FILTERS.map((f) => f.name));
  const expected = new Set<string>([
    "pytest", "jest", "cargo", "npm", "docker", "kubectl",
    "aws", "gh", "ruff", "mypy", "linter", "grep", "git",
    "make", "go-test", "terraform", "pip", "uv", "python",
    "ansible", "pre-commit",
  ]);
  const missing = [...expected].filter((n) => !names.has(n));
  expect(missing, `Missing filters in FILTERS registry: ${JSON.stringify(missing)}`).toEqual([]);
});

it("test_go_test_precedes_make_in_registry", () => {
  // GoTestFilter must precede MakeFilter so `go test` wins over `go build`.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.includes("go-test")).toBe(true);
  expect(names.includes("make")).toBe(true);
  expect(
    names.indexOf("go-test") < names.indexOf("make"),
    "GoTestFilter must be registered before MakeFilter; otherwise " +
      "MakeFilter.matches() (binaries={'go', ...}) wins for `go test`.",
  ).toBe(true);
});

it("test_go_build_routes_to_go_not_go_test", () => {
  // `go build ./...` routes to GoFilter, not GoTestFilter.
  const f = bc.select_filter(["go", "build", "./..."]);
  expect(f).not.toBeNull();
  expect(
    f!.name,
    "go build is not a test command; GoTestFilter.matches() must return " +
      "False; GoFilter (registered after GoTestFilter) handles it.",
  ).toBe("go");
});

it("test_go_vet_routes_to_go", () => {
  // `go vet ./...` is handled by GoFilter.
  const f = bc.select_filter(["go", "vet", "./..."]);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("go");
});

// ---------------------------------------------------------------------------
// 7. AnsibleFilter / PreCommitFilter — golden output + registry guards
// ---------------------------------------------------------------------------

// A representative ansible-playbook run with two tasks across three hosts,
// one of which fails on the second task. Exercises every line shape the
// filter cares about: PLAY/TASK headers, status lines, fatal payload,
// PLAY RECAP block.
const _ANSIBLE_OUTPUT =
  "PLAY [Deploy app] *************************************************************\n" +
  "\n" +
  "TASK [Gathering Facts] ********************************************************\n" +
  "ok: [web1]\n" +
  "ok: [web2]\n" +
  "ok: [web3]\n" +
  "\n" +
  "TASK [Install nginx] **********************************************************\n" +
  "changed: [web1]\n" +
  "changed: [web2]\n" +
  'fatal: [web3]: FAILED! => {"changed": false, "msg": "Package nginx not found", "rc": 100}\n' +
  "\n" +
  "TASK [Start nginx] ************************************************************\n" +
  "ok: [web1]\n" +
  "ok: [web2]\n" +
  "skipping: [web3]\n" +
  "\n" +
  "PLAY RECAP ********************************************************************\n" +
  "web1                       : ok=3    changed=1    unreachable=0    failed=0    skipped=0\n" +
  "web2                       : ok=3    changed=1    unreachable=0    failed=0    skipped=0\n" +
  "web3                       : ok=1    changed=0    unreachable=0    failed=1    skipped=1\n";

// A representative `pre-commit run --all-files` output: env-setup info,
// many passing hooks, one failing hook with diff payload, and a final
// trailing-whitespace hook that passed.
const _PRECOMMIT_OUTPUT =
  "[INFO] Initializing environment for https://github.com/pre-commit/pre-commit-hooks.\n" +
  "[INFO] Installing environment for https://github.com/pre-commit/pre-commit-hooks.\n" +
  "[INFO] Installing environment for https://github.com/psf/black.\n" +
  "Trim trailing whitespace.................................................Passed\n" +
  "Fix end of files.........................................................Passed\n" +
  "Check yaml...........................................(no files to check)Skipped\n" +
  "Check for added large files..............................................Passed\n" +
  "black....................................................................Failed\n" +
  "- hook id: black\n" +
  "- files were modified by this hook\n" +
  "\n" +
  "reformatted src/foo.py\n" +
  "\n" +
  "All done! ✨ 🍰 ✨\n" +
  "1 file reformatted.\n" +
  "\n" +
  "ruff.....................................................................Passed\n" +
  "mypy.....................................................................Passed\n";

describe("TestAnsibleFilter", () => {
  it("test_play_and_task_headers_preserved", () => {
    const f = new AnsibleFilter();
    const out = _apply(f, { stdout: _ANSIBLE_OUTPUT });
    expect(out).toContain("PLAY [Deploy app]");
    expect(out).toContain("TASK [Gathering Facts]");
    expect(out).toContain("TASK [Install nginx]");
    expect(out).toContain("TASK [Start nginx]");
  });

  it("test_status_lines_collapsed_to_count", () => {
    const f = new AnsibleFilter();
    const out = _apply(f, { stdout: _ANSIBLE_OUTPUT });
    // Individual ``ok: [host]`` rows must be gone — replaced by a count.
    expect(out).not.toContain("ok: [web1]");
    expect(out).not.toContain("ok: [web2]");
    // The aggregate marker line carries the counts.
    expect(out.includes("ok") && out.includes("token-goat:")).toBe(true);
  });

  it("test_fatal_block_preserved_verbatim", () => {
    const f = new AnsibleFilter();
    const out = _apply(f, { stdout: _ANSIBLE_OUTPUT });
    // The fatal line and its JSON-ish payload (same line in this fixture)
    // must survive — that's the load-bearing failure signal.
    expect(out).toContain("fatal: [web3]: FAILED!");
    expect(out).toContain("Package nginx not found");
  });

  it("test_play_recap_block_preserved", () => {
    const f = new AnsibleFilter();
    const out = _apply(f, { stdout: _ANSIBLE_OUTPUT });
    // PLAY RECAP and every per-host row carries the run-summary signal.
    expect(out).toContain("PLAY RECAP");
    expect(out.includes("web1") && out.includes("ok=3")).toBe(true);
    expect(out.includes("web3") && out.includes("failed=1")).toBe(true);
  });

  it("test_savings_ratio_large_inventory", () => {
    const f = new AnsibleFilter();
    // 50 hosts × 20 ok-only tasks ~= 1000 status lines, all collapsible.
    const lines: string[] = ["PLAY [big] ***"];
    for (let t = 0; t < 20; t += 1) {
      lines.push(`TASK [task-${t}] ***`);
      for (let h = 0; h < 50; h += 1) {
        lines.push(`ok: [host-${String(h).padStart(2, "0")}]`);
      }
    }
    lines.push("");
    lines.push("PLAY RECAP ***");
    for (let h = 0; h < 50; h += 1) {
      lines.push(
        `host-${String(h).padStart(2, "0")}                       : ok=20   changed=0    ` +
          `unreachable=0    failed=0    skipped=0`,
      );
    }
    const big = lines.join("\n") + "\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `AnsibleFilter savings ${(ratio * 100).toFixed(0)}% < 40% on big run`).toBeGreaterThanOrEqual(0.4);
  });

  it("test_empty_input_no_crash", () => {
    const f = new AnsibleFilter();
    const out = _apply(f, { stdout: "", stderr: "" });
    expect(out === "" || out.trim() === "").toBe(true);
  });
});

describe("TestPreCommitFilter", () => {
  it("test_failed_hook_preserved", () => {
    const f = new PreCommitFilter();
    const out = _apply(f, { stdout: _PRECOMMIT_OUTPUT });
    expect(out).toContain("black....................................................................Failed");
    // The failure body (hook id, file list, diff) must survive verbatim.
    expect(out).toContain("- hook id: black");
    expect(out).toContain("reformatted src/foo.py");
    expect(out).toContain("1 file reformatted.");
  });

  it("test_passing_hooks_collapsed", () => {
    const f = new PreCommitFilter();
    const out = _apply(f, { stdout: _PRECOMMIT_OUTPUT });
    // Individual Passed lines disappear (4 before the failure: Trim, Fix,
    // large files, plus 2 after: ruff, mypy — minus the Skipped yaml).
    expect(out).not.toContain("Trim trailing whitespace");
    expect(out).not.toContain("Fix end of files");
    // The collapse marker is present at least once.
    expect(out.includes("collapsed") && out.includes("Passed")).toBe(true);
  });

  it("test_info_env_setup_collapsed", () => {
    const f = new PreCommitFilter();
    const out = _apply(f, { stdout: _PRECOMMIT_OUTPUT });
    // First [INFO] line is kept verbatim; subsequent ones are dropped.
    // The fixture has three [INFO] lines — exactly one survives as a
    // verbatim "[INFO] Initializing environment" line plus the marker.
    expect(out).toContain("[INFO] Initializing environment for");
    // The two further [INFO] lines should be gone.
    expect(out).not.toContain("Installing environment for https://github.com/pre-commit");
    expect(out).not.toContain("Installing environment for https://github.com/psf/black");
    // The dropped-count marker is present.
    expect(out).toContain("dropped 2 pre-commit [INFO] env-setup lines");
  });

  it("test_skipped_counted", () => {
    const f = new PreCommitFilter();
    const out = _apply(f, { stdout: _PRECOMMIT_OUTPUT });
    // Skipped hook is not preserved verbatim but counted in the collapse.
    expect(out).not.toContain("Check yaml");
    expect(out).toContain("Skipped"); // appears in the collapsed marker
  });

  it("test_savings_ratio_many_passing_hooks", () => {
    const f = new PreCommitFilter();
    const lines: string[] = [
      "[INFO] Initializing environment for repo.",
      "[INFO] Installing environment for repo.",
      "[INFO] Restored package cache.",
    ];
    for (let i = 0; i < 80; i += 1) {
      lines.push(`hook-${String(i).padStart(3, "0")}` + ".".repeat(60 - String(i).length) + "Passed");
    }
    const big = lines.join("\n") + "\n";
    const ratio = _savings_ratio(f, { stdout: big });
    expect(ratio, `PreCommitFilter savings ${(ratio * 100).toFixed(0)}% < 40%`).toBeGreaterThanOrEqual(0.4);
  });

  it("test_no_match_for_make", () => {
    // `make pre-commit` should still route to MakeFilter, not us.
    // `pre-commit` only matches when the binary itself is `pre-commit`;
    // a make target with that name has stem `make` and goes to MakeFilter.
    const f = new PreCommitFilter();
    expect(f.matches(["make", "pre-commit"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Registry-order guards for the new filters
// ---------------------------------------------------------------------------

it("test_ansible_and_pre_commit_in_registry", () => {
  // Both new filters are registered exactly once and reachable by name.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.filter((n) => n === "ansible").length).toBe(1);
  expect(names.filter((n) => n === "pre-commit").length).toBe(1);
  expect(bc.filter_by_name("ansible")).not.toBeNull();
  expect(bc.filter_by_name("pre-commit")).not.toBeNull();
});

it("test_ansible_dispatches_independently_of_make", () => {
  // `ansible-playbook deploy.yml` must route to AnsibleFilter, not MakeFilter.
  // Belt-and-braces guard: ansible-playbook shares no binary stem with
  // MakeFilter (make, gradle, mvn etc.), but we encode the expectation
  // explicitly so a future rename or accidental binary-set expansion in
  // MakeFilter fails loudly here rather than silently swallowing ansible
  // output through the wrong compressor.
  const f = bc.select_filter(["ansible-playbook", "site.yml"]);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("ansible");
});

it("test_pre_commit_precedes_python_catchall_in_registry", () => {
  // PreCommitFilter must precede PythonFilter in FILTERS.
  // PythonFilter is the catch-all for the Python toolchain; if a future
  // refactor adds `pre-commit` to its binaries set or moves PythonFilter
  // earlier, `pre-commit run` would silently route to PythonFilter and lose
  // the hook-level compression. This guard documents the contract.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.includes("pre-commit")).toBe(true);
  expect(names.includes("python")).toBe(true);
  expect(
    names.indexOf("pre-commit") < names.indexOf("python"),
    "PreCommitFilter must be registered before PythonFilter (catch-all).",
  ).toBe(true);
});

it("test_ansible_precedes_python_catchall_in_registry", () => {
  // AnsibleFilter must precede PythonFilter in FILTERS.
  // Same reasoning as the pre-commit precedence guard: ansible* binaries
  // must never silently fall through to the catch-all PythonFilter.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.includes("ansible")).toBe(true);
  expect(names.includes("python")).toBe(true);
  expect(
    names.indexOf("ansible") < names.indexOf("python"),
    "AnsibleFilter must be registered before PythonFilter (catch-all).",
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// GhFilter _compress_gh_list — targeted tests (iteration 3)
// ---------------------------------------------------------------------------

describe("TestGhFilterCompressGhList", () => {
  // Tests for the _compress_gh_list() helper and its routing in GhFilter.compress().

  // ------------------------------------------------------------------
  // issue list — same row-cap logic as pr/run list
  // ------------------------------------------------------------------

  it("test_issue_list_truncates_at_30_rows", () => {
    // gh issue list with >30 data rows is truncated to first 30 + summary.
    const f = new GhFilter();
    const header = "Showing 50 of 50 open issues in owner/repo\n";
    const rows = Array.from({ length: 50 }, (_, i) => `#${String(i).padStart(4, "0")}\topen\tBug report ${i}\t2026-05-${String((i % 28) + 1).padStart(2, "0")}`);
    const big_output = header + rows.join("\n");

    const out = f.compress(big_output, "", 0, ["gh", "issue", "list"]);

    // Count summary present
    expect(out).toContain("showing first 30 of 50 issues");
    // First row preserved
    expect(out).toContain("#0000");
    // 30th row (0-indexed 29) preserved; 31st (index 30) elided
    expect(out).toContain(`#${String(29).padStart(4, "0")}`);
    expect(out).not.toContain(`#${String(30).padStart(4, "0")}`);
  });

  it("test_issue_list_under_threshold_passes_through", () => {
    // gh issue list with <=30 rows passes through without truncation.
    const f = new GhFilter();
    const header = "Showing 10 of 10 open issues in owner/repo\n";
    const rows = Array.from({ length: 10 }, (_, i) => `#${i}\topen\tIssue ${i}`);
    const output = header + rows.join("\n");

    const out = f.compress(output, "", 0, ["gh", "issue", "list"]);

    expect(out).not.toContain("showing first 30");
    // All rows present
    for (let i = 0; i < 10; i += 1) {
      expect(out).toContain(`#${i}`);
    }
  });

  it("test_pr_list_exactly_30_rows_passes_through", () => {
    // gh pr list with exactly 30 data rows passes through unchanged.
    const f = new GhFilter();
    const header = "Showing 30 of 30 pull requests\n";
    const rows = Array.from({ length: 30 }, (_, i) => `#${i}\topen\tPR ${i}`);
    const output = header + rows.join("\n");

    const out = f.compress(output, "", 0, ["gh", "pr", "list"]);

    expect(out).not.toContain("showing first 30");
    expect(out).toContain("#29");
  });

  it("test_pr_list_31_rows_triggers_truncation", () => {
    // gh pr list with 31 data rows triggers truncation (over-threshold by 1).
    const f = new GhFilter();
    const header = "Showing 31 of 31 pull requests\n";
    const rows = Array.from({ length: 31 }, (_, i) => `#${i}\topen\tPR ${i}`);
    const output = header + rows.join("\n");

    const out = f.compress(output, "", 0, ["gh", "pr", "list"]);

    expect(out).toContain("showing first 30 of 31 prs");
    expect(out).not.toContain("#30"); // 31st row (0-indexed 30) is elided
  });

  // ------------------------------------------------------------------
  // Non-list subcommands must NOT be row-truncated
  // ------------------------------------------------------------------

  it("test_pr_view_not_row_truncated", () => {
    // gh pr view passes through all content without row truncation.
    const f = new GhFilter();
    // Build pr view output that looks like a long PR body (not tabular rows).
    const header_block =
      "title:\tAdd great feature\n" +
      "state:\tOPEN\n" +
      "author:\talice\n" +
      "body:\n";
    const body_lines = Array.from({ length: 50 }, (_, i) => `  Line ${i} of the PR body.`).join("\n");
    const output = header_block + body_lines;

    const out = f.compress(output, "", 0, ["gh", "pr", "view", "42"]);

    // Must not emit a row-count summary
    expect(out).not.toContain("showing first 30");
    // Body lines must be intact (squeeze_blank_lines may merge blanks but text stays)
    expect(out).toContain("Line 0 of the PR body");
    expect(out).toContain("Line 49 of the PR body");
  });

  it("test_gh_api_not_row_truncated", () => {
    // gh api passes through without row truncation.
    const f = new GhFilter();
    // Simulate gh api returning 50 JSON lines (one item per line).
    const json_lines = Array.from({ length: 50 }, (_, i) => `{"id": ${i}, "name": "item${i}"}`);
    const output = json_lines.join("\n");

    const out = f.compress(output, "", 0, ["gh", "api", "/repos/owner/repo/issues"]);

    expect(out).not.toContain("showing first 30");
    expect(out).toContain('"id": 49'); // Last item must be present
  });

  it("test_run_list_label_says_runs", () => {
    // _compress_gh_list uses 'runs' (not 'prs' or 'issues') for run list.
    const f = new GhFilter();
    const header = "Showing 40 runs\n";
    const rows = Array.from({ length: 40 }, (_, i) => `completed\trun-${i}`);
    const output = header + rows.join("\n");

    const out = f.compress(output, "", 0, ["gh", "run", "list"]);

    expect(out).toContain("showing first 30 of 40 runs");
  });

  it("test_issue_list_label_says_issues", () => {
    // _compress_gh_list uses 'issues' (not 'runs' or 'prs') for issue list.
    const f = new GhFilter();
    const header = "Showing 40 issues\n";
    const rows = Array.from({ length: 40 }, (_, i) => `open\t#${i}\tBug ${i}`);
    const output = header + rows.join("\n");

    const out = f.compress(output, "", 0, ["gh", "issue", "list"]);

    expect(out).toContain("showing first 30 of 40 issues");
  });
});

// --- NodeFilter (node -e / node -p eval probes) -----------------------------

const _NODE_TRACE_WITH_MODULES =
  "/path/to/script.js:1\n" +
  "require('missing-pkg')\n" +
  "^\n" +
  "\n" +
  "Error: Cannot find module 'missing-pkg'\n" +
  "Require stack:\n" +
  "- /path/to/script.js\n" +
  "    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1039:15)\n" +
  "    at Function.Module._load (node:internal/modules/cjs/loader:885:27)\n" +
  "    at Module.require (node:internal/modules/cjs/loader:1006:19)\n" +
  "    at require (node:internal/helpers:182:18)\n" +
  "    at Object.<anonymous> (/path/to/node_modules/some-pkg/index.js:5:1)\n" +
  "    at Module._compile (node:internal/modules/cjs/loader:1376:14)\n" +
  "    at Object.Module._extensions..js (node:internal/modules/cjs/loader:1400:10)\n" +
  "    at Module.load (node:internal/modules/cjs/loader:1200:32)\n" +
  "    at Function.Module._load (node:internal/modules/cjs/loader:1016:12)\n" +
  "    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/cjs/loader:1076:10)\n" +
  "    at node:internal/main/run_main_module:30:49\n";

describe("TestNodeFilter", () => {
  // Tests for NodeFilter: node -e / node -p eval probe compression.

  function _f(): NodeFilter {
    return new NodeFilter();
  }

  // --- dispatch / matches --------------------------------------------------

  it("test_matches_eval_flag", () => {
    // node -e 'code' is claimed by NodeFilter.
    const f = _f();
    expect(f.matches(["node", "-e", "console.log(1)"])).toBe(true);
  });

  it("test_matches_print_flag", () => {
    // node -p 'expr' is claimed by NodeFilter.
    const f = _f();
    expect(f.matches(["node", "-p", "1+1"])).toBe(true);
  });

  it("test_does_not_match_script_run", () => {
    // node script.js (no eval flag) should NOT be claimed.
    const f = _f();
    expect(f.matches(["node", "script.js"])).toBe(false);
  });

  it("test_does_not_match_npm", () => {
    // npm commands should not be claimed by NodeFilter.
    const f = _f();
    expect(f.matches(["npm", "install"])).toBe(false);
  });

  // --- node_modules frame collapse -----------------------------------------

  it("test_node_modules_frames_collapsed", () => {
    // node_modules frames are replaced with a single omission placeholder.
    const f = _f();
    const out = f.compress(_NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "require('missing-pkg')"]);
    expect(out).toContain("node_modules frame(s) omitted");
    // The node_modules frame itself must be gone.
    expect(out).not.toContain("node_modules/some-pkg/index.js");
  });

  it("test_error_header_preserved", () => {
    // The Error: line must survive unchanged.
    const f = _f();
    const out = f.compress(_NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "x"]);
    expect(out).toContain("Error: Cannot find module 'missing-pkg'");
  });

  it("test_internal_frames_collapsed", () => {
    // node:internal frames are collapsed to a placeholder.
    const f = _f();
    const out = f.compress(_NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "x"]);
    expect(out).toContain("Node.js internal frame(s) omitted");
    // Raw node:internal lines must not appear verbatim.
    expect(out).not.toContain("node:internal/modules/cjs/loader");
  });

  it("test_savings_ratio", () => {
    // Compression must save >= 20% on a representative node_modules trace.
    const f = _f();
    const result = f.apply(_NODE_TRACE_WITH_MODULES, "", 1, ["node", "-e", "require('missing-pkg')"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio, `NodeFilter savings ${(ratio * 100).toFixed(0)}% < 20%`).toBeGreaterThanOrEqual(0.2);
  });

  // --- success passthrough -------------------------------------------------

  it("test_success_passthrough", () => {
    // Successful eval output is returned unchanged (just token-capped).
    const f = _f();
    const out = f.compress("42\n", "", 0, ["node", "-p", "6*7"]);
    expect(out).toContain("42");
    // No compression markers on success.
    expect(out).not.toContain("omitted");
  });

  // --- empty output --------------------------------------------------------

  it("test_empty_output_no_crash", () => {
    // Empty stderr/stdout on failure does not raise.
    const f = _f();
    const out = f.compress("", "", 1, ["node", "-e", "process.exit(1)"]);
    expect(typeof out).toBe("string");
  });
});
