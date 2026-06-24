/**
 * Tests for ErlangFilter, FlyFilter, and ForgeFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_erlang_fly_forge.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes (TestErlangFilter, TestFlyFilter,
 * TestForgeFilter) map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports ErlangFilter / FlyFilter / ForgeFilter + select_filter +
 *        the FILTERS registry).
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, opts?)` helper below; runs
 *        `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *         to `[filter_.name]` (matching the Python helper exactly) and
 *         exit_code/stderr to 0/"".
 *  - `isinstance(bc.select_filter(...), bc.XFilter)` -> `f instanceof XFilter`.
 *
 * Byte-exactness: the assertions here are substring `in` / `not in` checks on
 * the returned `.text`. The fixtures are pure ASCII, so code-unit length equals
 * the UTF-8 byte count — no Buffer arithmetic is needed for these inputs.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  ErlangFilter,
  FlyFilter,
  ForgeFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site). When argv is omitted the filter's
// own `.name` is used as the sole argv element.
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ===========================================================================
// ErlangFilter
// ===========================================================================

const _REBAR3_COMPILE_SUCCESS = `===> Verifying dependencies
===> Analyzing applications
===> Compiling myapp
Compiling src/myapp_sup.erl
Compiling src/myapp_app.erl
Compiling src/myapp_server.erl
Compiling src/myapp_utils.erl
Compiling src/myapp_handler.erl
`;

const _REBAR3_EUNIT_SUCCESS = `===> Verifying dependencies
===> Compiling myapp
===> Performing EUnit tests
  myapp_server_tests:server_starts_test...ok
  myapp_server_tests:server_handles_call_test...ok
  myapp_server_tests:server_stops_test...ok
  myapp_utils_tests:format_ok_test...ok
  myapp_utils_tests:parse_ok_test...ok
All 5 tests passed.
`;

const _REBAR3_CT_FAIL = `===> Running Common Test suites
  myapp_SUITE:test_connect...FAILED
  Reason: timeout connecting to localhost:8080
  myapp_SUITE:test_query...ok
2 tests, 1 failed
`;

const _REBAR3_DEPS = `===> Verifying dependencies
Fetching cowboy 2.9.0
Fetching ranch 2.1.0
Downloading cowlib 2.11.0
Already up-to-date: jsx
All dependencies already locked
`;

describe("TestErlangFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_rebar3", () => {
    const f = new ErlangFilter();
    expect(f.matches(["rebar3", "compile"])).toBe(true);
  });

  it("test_matches_rebar3_eunit", () => {
    const f = new ErlangFilter();
    expect(f.matches(["rebar3", "eunit"])).toBe(true);
  });

  it("test_matches_rebar3_ct", () => {
    const f = new ErlangFilter();
    expect(f.matches(["rebar3", "ct"])).toBe(true);
  });

  it("test_matches_rebar", () => {
    const f = new ErlangFilter();
    expect(f.matches(["rebar", "compile"])).toBe(true);
  });

  it("test_no_match_mix", () => {
    const f = new ErlangFilter();
    expect(f.matches(["mix", "compile"])).toBe(false);
  });

  it("test_no_match_erlc", () => {
    // standalone erlc is not rebar3 output
    const f = new ErlangFilter();
    expect(f.matches(["erlc", "src/foo.erl"])).toBe(false);
  });

  // --- select ------------------------------------------------------------

  it("test_select_rebar3", () => {
    expect(bc.select_filter(["rebar3", "compile"]) instanceof ErlangFilter).toBe(true);
  });

  it("test_select_rebar3_eunit", () => {
    expect(bc.select_filter(["rebar3", "eunit"]) instanceof ErlangFilter).toBe(true);
  });

  // --- compress: compilation lines collapsed ----------------------------

  it("test_compilation_lines_collapsed", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_COMPILE_SUCCESS });
    expect(out).toContain(".erl compilation line(s) collapsed");
  });

  it("test_individual_erl_files_not_in_output", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_COMPILE_SUCCESS });
    expect(out).not.toContain("myapp_sup.erl");
    expect(out).not.toContain("myapp_handler.erl");
  });

  it("test_compile_step_noise_dropped", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_COMPILE_SUCCESS });
    expect(out).not.toContain("Verifying dependencies");
    expect(out).not.toContain("Analyzing applications");
  });

  // --- compress: EUnit passing tests collapsed --------------------------

  it("test_passing_eunit_tests_collapsed", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_EUNIT_SUCCESS });
    expect(out).toContain("passing test line(s)");
  });

  it("test_individual_pass_lines_not_in_output", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_EUNIT_SUCCESS });
    expect(out).not.toContain("server_starts_test");
    expect(out).not.toContain("format_ok_test");
  });

  it("test_summary_line_kept", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_EUNIT_SUCCESS });
    expect(out).toContain("All 5 tests passed");
  });

  // --- compress: CT failure lines kept ---------------------------------

  it("test_failure_lines_kept", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_CT_FAIL, exit_code: 1 });
    expect(out).toContain("FAILED");
  });

  it("test_failure_reason_kept", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_CT_FAIL, exit_code: 1 });
    expect(out).toContain("timeout connecting");
  });

  it("test_failure_summary_kept", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_CT_FAIL, exit_code: 1 });
    expect(out).toContain("1 failed");
  });

  // --- compress: dependency fetch lines collapsed -----------------------

  it("test_dep_fetch_lines_collapsed", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_DEPS });
    expect(out).toContain("dependency-fetch line(s) collapsed");
  });

  it("test_dep_names_not_in_output", () => {
    const f = new ErlangFilter();
    const out = _compress(f, { stdout: _REBAR3_DEPS });
    expect(out).not.toContain("Fetching cowboy");
    expect(out).not.toContain("Downloading cowlib");
  });
});

// ===========================================================================
// FlyFilter
// ===========================================================================

const _FLY_DEPLOY_SUCCESS = `==> Building image with Docker
Sending build context to Docker daemon  12.54kB
Step 1/8 : FROM elixir:1.14-alpine
 ---> abc123def456
Step 2/8 : RUN mix deps.get
 ---> Using cache
 ---> def456abc789
Step 3/8 : COPY . .
 ---> 789abc123def
#4 CACHED [stage-1 5/6]
#5 DONE 2.1s
Successfully built deadbeef12ab
Successfully tagged registry.fly.io/myapp:latest
==> Releasing image
--> Waiting for machine 1234abcd to start
 Machine 1234abcd is now in a started state
--> Waiting for machine 5678efgh to start
 Machine 5678efgh is now in a started state
==> Monitoring deployment
Monitoring deployment (Ctrl-C to stop)
Deployed myapp v3 successfully
Visit your newly deployed app at https://myapp.fly.dev
`;

const _FLY_DEPLOY_ERROR = `==> Building image with Docker
Step 1/4 : FROM python:3.11
Error response from daemon: pull access denied for python
`;

const _FLY_DNS_NOISE = `Checking DNS configuration for myapp.fly.dev
Waiting for IPv4 address
Waiting for IPv6 address
The above IP address may need 1-2 minutes to propagate
`;

describe("TestFlyFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_fly_deploy", () => {
    const f = new FlyFilter();
    expect(f.matches(["fly", "deploy"])).toBe(true);
  });

  it("test_matches_flyctl", () => {
    const f = new FlyFilter();
    expect(f.matches(["flyctl", "deploy"])).toBe(true);
  });

  it("test_matches_fly_status", () => {
    const f = new FlyFilter();
    expect(f.matches(["fly", "status"])).toBe(true);
  });

  it("test_matches_fly_scale", () => {
    const f = new FlyFilter();
    expect(f.matches(["fly", "scale", "count", "3"])).toBe(true);
  });

  it("test_no_match_docker", () => {
    const f = new FlyFilter();
    expect(f.matches(["docker", "build"])).toBe(false);
  });

  it("test_no_match_heroku", () => {
    const f = new FlyFilter();
    expect(f.matches(["heroku", "deploy"])).toBe(false);
  });

  // --- select ------------------------------------------------------------

  it("test_select_fly", () => {
    expect(bc.select_filter(["fly", "deploy"]) instanceof FlyFilter).toBe(true);
  });

  it("test_select_flyctl", () => {
    expect(bc.select_filter(["flyctl", "deploy"]) instanceof FlyFilter).toBe(true);
  });

  // --- compress: Docker build steps collapsed ---------------------------

  it("test_build_steps_collapsed", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_SUCCESS });
    expect(out).toContain("Docker build step line(s) collapsed");
  });

  it("test_individual_step_lines_not_in_output", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_SUCCESS });
    expect(out).not.toContain("Sending build context");
    expect(out).not.toContain("Step 1/8");
    expect(out).not.toContain("Step 2/8");
  });

  it("test_image_id_lines_not_in_output", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_SUCCESS });
    expect(out).not.toContain("Successfully built deadbeef");
    expect(out).not.toContain("Successfully tagged");
  });

  // --- compress: step headers always kept -------------------------------

  it("test_step_headers_kept", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_SUCCESS });
    expect(out).toContain("==> Building image");
    expect(out).toContain("==> Releasing image");
  });

  // --- compress: per-machine wait lines collapsed -----------------------

  it("test_machine_wait_lines_collapsed", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_SUCCESS });
    expect(out).toContain("per-machine wait line(s) collapsed");
  });

  it("test_machine_ids_not_in_output", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_SUCCESS });
    expect(out).not.toContain("1234abcd");
    expect(out).not.toContain("5678efgh");
  });

  // --- compress: deploy summary kept ------------------------------------

  it("test_deploy_summary_kept", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_SUCCESS });
    expect(
      out.includes("Deployed myapp v3 successfully") ||
        out.includes("Visit your newly deployed"),
    ).toBe(true);
  });

  // --- compress: DNS noise dropped -------------------------------------

  it("test_dns_noise_dropped", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DNS_NOISE });
    expect(out).not.toContain("Checking DNS configuration");
    expect(out).not.toContain("Waiting for IPv4");
    expect(out).not.toContain("Waiting for IPv6");
  });

  it("test_dns_drop_noted", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DNS_NOISE });
    const lower = out.toLowerCase();
    expect(lower.includes("dns") || lower.includes("noise") || lower.includes("dropped")).toBe(
      true,
    );
  });

  // --- compress: error output preserved ---------------------------------

  it("test_error_preserved", () => {
    const f = new FlyFilter();
    const out = _compress(f, { stdout: _FLY_DEPLOY_ERROR, exit_code: 1 });
    expect(out).toContain("pull access denied");
  });
});

// ===========================================================================
// ForgeFilter
// ===========================================================================

const _FORGE_BUILD_SUCCESS = `Compiling 12 files with solc 0.8.24
Compiling 3 Solidity files
Solc 0.8.24 finished in 4.21s
Solc 0.8.19 finished in 1.02s
Compiler run successful!
`;

const _FORGE_TEST_SUCCESS = `Compiling 5 files with solc 0.8.24
Solc 0.8.24 finished in 2.10s
Compiler run successful!

Running 8 tests for test/Token.t.sol:TokenTest
[PASS] testTransfer() (gas: 52341)
[PASS] testApprove() (gas: 47123)
[PASS] testTransferFrom() (gas: 63412)
[PASS] testMint() (gas: 44532)
[PASS] testBurn() (gas: 39871)
[PASS] testBalanceOf() (gas: 25234)
[PASS] testAllowance() (gas: 28654)
[PASS] testTotalSupply() (gas: 22113)
Test result: ok. 8 passed; 0 failed; 0 skipped; finished in 1.34s

Ran 1 test suite in 3.45s (3.45s CPU time): 8 tests passed, 0 failed, 0 skipped (8 total tests)
`;

const _FORGE_TEST_FAIL = `Compiling 3 files with solc 0.8.24
Solc 0.8.24 finished in 1.10s
Compiler run successful!

Running 3 tests for test/Vault.t.sol:VaultTest
[PASS] testDeposit() (gas: 44123)
[FAIL. Counterexample: calldata=0x..., args=[0]] testWithdraw() (gas: 31000)
  [FAIL] testWithdrawAll() (gas: 0)

Test result: FAILED. 1 passed; 2 failed; 0 skipped; finished in 0.54s
`;

const _FORGE_GAS_REPORT = `Compiler run successful!
Running 2 tests for test/MyContract.t.sol:MyContractTest
[PASS] testFoo() (gas: 12345)
[PASS] testBar() (gas: 67890)
Test result: ok. 2 passed; 0 failed; 0 skipped

| Contract Name | Deployment Cost | Deployment Size |
|---------------|-----------------|-----------------|
| MyContract    | 234567          | 1234            |

| Function Name | min  | avg  | median | max  | # calls |
|---------------|------|------|--------|------|---------|
| foo           | 1234 | 1567 | 1400   | 2100 | 5       |
| bar           | 4321 | 4800 | 4600   | 5200 | 3       |
`;

describe("TestForgeFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_forge_build", () => {
    const f = new ForgeFilter();
    expect(f.matches(["forge", "build"])).toBe(true);
  });

  it("test_matches_forge_test", () => {
    const f = new ForgeFilter();
    expect(f.matches(["forge", "test"])).toBe(true);
  });

  it("test_matches_forge_script", () => {
    const f = new ForgeFilter();
    expect(f.matches(["forge", "script", "script/Deploy.s.sol"])).toBe(true);
  });

  it("test_matches_forge_compile", () => {
    const f = new ForgeFilter();
    expect(f.matches(["forge", "compile"])).toBe(true);
  });

  it("test_no_match_hardhat", () => {
    const f = new ForgeFilter();
    expect(f.matches(["hardhat", "compile"])).toBe(false);
  });

  it("test_no_match_npx_hardhat", () => {
    const f = new ForgeFilter();
    expect(f.matches(["npx", "hardhat", "compile"])).toBe(false);
  });

  it("test_no_match_foundry_cast", () => {
    // cast is a different foundry binary — not forge
    const f = new ForgeFilter();
    expect(f.matches(["cast", "call"])).toBe(false);
  });

  // --- select ------------------------------------------------------------

  it("test_select_forge", () => {
    expect(bc.select_filter(["forge", "build"]) instanceof ForgeFilter).toBe(true);
  });

  it("test_select_forge_test", () => {
    expect(bc.select_filter(["forge", "test"]) instanceof ForgeFilter).toBe(true);
  });

  // --- compress: compilation lines collapsed ----------------------------

  it("test_compile_step_lines_collapsed", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_BUILD_SUCCESS });
    expect(out).toContain("Solidity compilation step line(s) collapsed");
  });

  it("test_solc_timing_lines_collapsed", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_BUILD_SUCCESS });
    // Solc timing lines should be collapsed into the same counter
    expect(out).not.toContain("Compiling 12 files with solc");
    expect(out).not.toContain("Solc 0.8.24 finished in");
  });

  it("test_compile_done_kept", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_BUILD_SUCCESS });
    expect(out).toContain("Compiler run successful");
  });

  // --- compress: passing tests collapsed --------------------------------

  it("test_passing_tests_collapsed", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_SUCCESS });
    expect(out).toContain("passing test line(s)");
  });

  it("test_individual_pass_lines_not_in_output", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_SUCCESS });
    expect(out).not.toContain("[PASS] testTransfer()");
    expect(out).not.toContain("[PASS] testMint()");
  });

  it("test_test_suite_header_kept", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_SUCCESS });
    expect(out).toContain("Running 8 tests for");
  });

  it("test_test_summary_kept", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_SUCCESS });
    expect(out.includes("Test result: ok") || out.includes("8 passed")).toBe(true);
  });

  it("test_footer_kept", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_SUCCESS });
    expect(out).toContain("Ran 1 test suite");
  });

  // --- compress: failure path -------------------------------------------

  it("test_fail_lines_kept", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_FAIL, exit_code: 1 });
    expect(out).toContain("[FAIL");
  });

  it("test_fail_summary_kept", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_FAIL, exit_code: 1 });
    expect(out).toContain("2 failed");
  });

  it("test_pass_lines_collapsed_even_on_partial_failure", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_TEST_FAIL, exit_code: 1 });
    expect(out).not.toContain("[PASS] testDeposit()");
  });

  // --- compress: gas report table separator rows dropped ----------------

  it("test_gas_table_separator_rows_dropped", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_GAS_REPORT });
    // Pure separator rows (|---|---|) should be gone
    expect(out).toContain("| MyContract    |"); // data row kept
    expect(out).not.toContain("|-----------"); // separator dropped
  });

  it("test_gas_table_header_row_kept", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_GAS_REPORT });
    // "| Function Name | min | avg ..." header row is structural — kept
    expect(out).toContain("Function Name");
  });

  it("test_gas_separator_note_emitted", () => {
    const f = new ForgeFilter();
    const out = _compress(f, { stdout: _FORGE_GAS_REPORT });
    expect(out).toContain("gas-report table separator row(s)");
  });
});
