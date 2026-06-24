/**
 * Tests for WranglerFilter, HardhatFilter, and ServerlessFilter.
 *
 * 1:1 port of tests/test_bash_compress_deploy_filters.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes (TestWranglerFilter, TestHardhatFilter,
 * TestServerlessFilter) map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, stdout, opts?)` helper below. The Python
 *        helper runs `filter_.apply(stdout, stderr, exit_code, argv).text`,
 *        defaulting argv to `[filter_.name]`; the TS port mirrors that exactly.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the IaC/deploy filter classes +
 *        select_filter).
 *  - Class-body `F = bc.WranglerFilter()` (a shared class attribute) ->
 *    a `const F = new WranglerFilter()` inside the describe block.
 *
 * Byte-exactness: these filters operate on whole lines and substring markers
 * ("asset upload line(s) collapsed", "build-step noise", "Solidity compilation
 * step", "Serverless deploy step line(s)", "polling dot", ...). The assertions
 * are substring `in` / `not in` checks on the returned string. The fixtures are
 * ASCII-only, so code-unit length equals byte length; for the single
 * compression-ratio test the byte counts are read straight off the
 * CompressedOutput (.compressed_bytes / .original_bytes) the filter computes.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  HardhatFilter,
  ServerlessFilter,
  WranglerFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element — the minimum needed for most dispatch checks.
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  stdout = "",
  opts?: { stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ---------------------------------------------------------------------------
// WranglerFilter
// ---------------------------------------------------------------------------

const _WRANGLER_DEPLOY_LARGE = `\
wrangler 3.45.0
Building...
Bundling with esbuild...
+ /index.html (1234 bytes)
+ /styles/main.css (5678 bytes)
+ /assets/logo.png (23456 bytes)
+ /assets/hero.jpg (98765 bytes)
+ /js/app.js (45678 bytes)
+ /js/vendor.js (123456 bytes)
Total Upload: 298.3 KiB / gzip: 79.4 KiB
Uploaded my-worker (0.47 sec)
Deployed my-worker
  https://my-worker.example.workers.dev
`;

const _WRANGLER_SKIP_ASSETS = `\
wrangler 3.45.0
3 assets already up to date
Uploaded my-worker (0.12 sec)
Deployed my-worker
  https://my-worker.example.workers.dev
`;

const _WRANGLER_ERROR = `\
wrangler 3.45.0
Building...
`;

describe("TestWranglerFilter", () => {
  const F = new WranglerFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_wrangler", () => {
    expect(F.matches(["wrangler", "deploy"])).toBeTruthy();
  });

  it("test_matches_wrangler2", () => {
    expect(F.matches(["wrangler2", "publish"])).toBeTruthy();
  });

  it("test_no_match_npm", () => {
    expect(F.matches(["npm", "run", "deploy"])).toBeFalsy();
  });

  it("test_no_match_cdk", () => {
    expect(F.matches(["cdk", "deploy"])).toBeFalsy();
  });

  // --- select ------------------------------------------------------------

  it("test_select_wrangler", () => {
    expect(bc.select_filter(["wrangler", "deploy"]) instanceof WranglerFilter).toBe(true);
  });

  it("test_select_wrangler2", () => {
    expect(bc.select_filter(["wrangler2", "publish"]) instanceof WranglerFilter).toBe(true);
  });

  // --- compress: upload lines collapsed ----------------------------------

  it("test_upload_lines_collapsed", () => {
    const out = _compress(F, _WRANGLER_DEPLOY_LARGE);
    expect(out).toContain("6 asset upload line(s) collapsed");
  });

  it("test_upload_lines_not_in_output", () => {
    const out = _compress(F, _WRANGLER_DEPLOY_LARGE);
    // Individual file paths should not appear
    expect(out).not.toContain("/index.html");
    expect(out).not.toContain("/assets/logo.png");
  });

  it("test_build_step_noise_dropped", () => {
    const out = _compress(F, _WRANGLER_DEPLOY_LARGE);
    expect(out).not.toContain("Building...");
    expect(out).not.toContain("Bundling with esbuild");
  });

  it("test_summary_lines_kept", () => {
    const out = _compress(F, _WRANGLER_DEPLOY_LARGE);
    expect(out).toContain("Total Upload:");
    expect(out).toContain("Deployed my-worker");
    expect(out).toContain("workers.dev");
  });

  it("test_skip_assets_collapsed", () => {
    const out = _compress(F, _WRANGLER_SKIP_ASSETS);
    expect(
      out.toLowerCase().includes("skip") ||
        out.includes("already up to date") ||
        out.includes("asset-skip"),
    ).toBe(true);
  });

  it("test_error_output_preserved", () => {
    const out = _compress(F, _WRANGLER_ERROR, {
      stderr: "Error: Script not found",
      exit_code: 1,
    });
    expect(out).toContain("Error: Script not found");
  });

  it("test_error_on_exit_code_nonzero", () => {
    const out = _compress(F, "wrangler 3.45.0\n", {
      stderr: "Error: invalid config",
      exit_code: 1,
    });
    expect(out).toContain("Error: invalid config");
  });

  it("test_build_step_note_in_output", () => {
    const out = _compress(F, _WRANGLER_DEPLOY_LARGE);
    expect(out).toContain("build-step noise");
  });
});

// ---------------------------------------------------------------------------
// HardhatFilter
// ---------------------------------------------------------------------------

const _HARDHAT_COMPILE_OUTPUT = `\
Compiling 12 files with Solc 0.8.24
Compiling 3 files with Solc 0.8.20
Solc 0.8.24 finished in 4.50s
Solc 0.8.20 finished in 1.20s
Compilation finished successfully
`;

const _HARDHAT_TEST_OUTPUT = `\
Compiling 5 files with Solc 0.8.24
Solc 0.8.24 finished in 2.10s
Compilation finished successfully

  Token
    Deployment
      ✓ should transfer tokens (45ms)
      ✓ should fail on zero address (12ms)
      ✓ should emit Transfer event (31ms)
    Admin
      ✓ should set owner (8ms)

  4 passing (2s)
`;

const _HARDHAT_FAILING_TESTS = `\
Compiling 2 files with Solc 0.8.24
Compilation finished successfully

  Token
    ✓ should mint correctly (23ms)

    1) should transfer tokens

  1 passing (1s)
  1 failing

  1) Token should transfer tokens:
     AssertionError: expected 0 to equal 100
`;

const _HARDHAT_DEPLOY_SCRIPT = `\
Deploying MyToken...
deployer: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Gas used: 1234567
Transaction hash: 0xabc123def456
Block number: 12345678
MyToken deployed to: 0x5FbDB2315678afecb367f032d93F642f64180aa3
Deploying MyGovernor...
MyGovernor deployed to: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
`;

describe("TestHardhatFilter", () => {
  const F = new HardhatFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_hardhat", () => {
    expect(F.matches(["hardhat", "compile"])).toBeTruthy();
  });

  it("test_matches_npx_hardhat", () => {
    // After _strip_prefixes, npx hardhat → hardhat
    expect(bc.select_filter(["npx", "hardhat", "test"]) instanceof HardhatFilter).toBe(true);
  });

  it("test_no_match_truffle", () => {
    expect(F.matches(["truffle", "compile"])).toBeFalsy();
  });

  it("test_no_match_forge", () => {
    expect(F.matches(["forge", "test"])).toBeFalsy();
  });

  // --- select ------------------------------------------------------------

  it("test_select_hardhat", () => {
    expect(bc.select_filter(["hardhat", "compile"]) instanceof HardhatFilter).toBe(true);
  });

  it("test_select_npx_hardhat", () => {
    expect(bc.select_filter(["npx", "hardhat", "test"]) instanceof HardhatFilter).toBe(true);
  });

  // --- compile path -----------------------------------------------------

  it("test_compile_step_lines_collapsed", () => {
    const out = _compress(F, _HARDHAT_COMPILE_OUTPUT);
    expect(out).toContain("collapsed");
    expect(out).toContain("Solidity compilation step");
  });

  it("test_solc_timing_collapsed", () => {
    const out = _compress(F, _HARDHAT_COMPILE_OUTPUT);
    expect(out).toContain("Solc per-version timing");
  });

  it("test_compile_finished_kept", () => {
    const out = _compress(F, _HARDHAT_COMPILE_OUTPUT);
    expect(out).toContain("Compilation finished successfully");
  });

  it("test_compile_lines_not_verbatim", () => {
    const out = _compress(F, _HARDHAT_COMPILE_OUTPUT);
    expect(out).not.toContain("Compiling 12 files");
    expect(out).not.toContain("Solc 0.8.24 finished in 4.50s");
  });

  // --- test path --------------------------------------------------------

  it("test_passing_tests_collapsed", () => {
    const out = _compress(F, _HARDHAT_TEST_OUTPUT);
    expect(out).toContain("passing test line(s)");
  });

  it("test_passing_checkmarks_not_verbatim", () => {
    const out = _compress(F, _HARDHAT_TEST_OUTPUT);
    expect(out).not.toContain("should transfer tokens");
  });

  it("test_test_summary_kept", () => {
    const out = _compress(F, _HARDHAT_TEST_OUTPUT);
    expect(out).toContain("4 passing");
  });

  it("test_describe_block_headers_kept", () => {
    const out = _compress(F, _HARDHAT_TEST_OUTPUT);
    expect(out).toContain("Token");
    expect(out).toContain("Deployment");
  });

  // --- failing tests path -----------------------------------------------

  it("test_failing_summary_kept", () => {
    const out = _compress(F, _HARDHAT_FAILING_TESTS);
    expect(out).toContain("1 failing");
  });

  it("test_assertion_error_kept", () => {
    const out = _compress(F, _HARDHAT_FAILING_TESTS);
    expect(out).toContain("AssertionError");
  });

  // --- deploy script path -----------------------------------------------

  it("test_deploy_header_kept", () => {
    const out = _compress(F, _HARDHAT_DEPLOY_SCRIPT);
    expect(out).toContain("Deploying MyToken");
  });

  it("test_deployed_to_address_kept", () => {
    const out = _compress(F, _HARDHAT_DEPLOY_SCRIPT);
    expect(out).toContain("MyToken deployed to:");
  });

  it("test_tx_noise_dropped", () => {
    const out = _compress(F, _HARDHAT_DEPLOY_SCRIPT);
    expect(out).toContain("transaction receipt noise");
    // Individual noise fields should be gone
    expect(out).not.toContain("Gas used:");
    expect(out).not.toContain("Transaction hash:");
    expect(out).not.toContain("Block number:");
  });

  // --- error path -------------------------------------------------------

  it("test_error_on_stderr_exit_code", () => {
    const out = _compress(F, "", {
      stderr: "Error HH303: Unrecognized task run\n",
      exit_code: 1,
    });
    expect(out).toContain("HH303");
  });
});

// ---------------------------------------------------------------------------
// ServerlessFilter
// ---------------------------------------------------------------------------

const _SLS_DEPLOY_FULL = `\
Serverless: Packaging service...
Serverless: Excluding development dependencies...
Serverless: Creating Stack...
Serverless: Checking Stack create progress...
........
Serverless: Stack create finished...
Serverless: Uploading CloudFormation file to S3...
Serverless: Uploading artifacts...
Serverless: Uploading service myservice.zip file to S3 (11.1 MB)...
Serverless: Validating template...
Serverless: Updating Stack...
Serverless: Checking Stack update progress...
.................
  UPDATE_IN_PROGRESS  AWS::CloudFormation::Stack  myservice-dev
  CREATE_IN_PROGRESS  AWS::IAM::Role  IamRoleLambdaExecution
  CREATE_COMPLETE  AWS::IAM::Role  IamRoleLambdaExecution
  CREATE_IN_PROGRESS  AWS::Lambda::Function  hello
  CREATE_COMPLETE  AWS::Lambda::Function  hello
  UPDATE_COMPLETE  AWS::CloudFormation::Stack  myservice-dev
Serverless: Stack update finished...
Service deployed to stack myservice-dev (42s)

Service Information
service: myservice
stage: dev
region: us-east-1
stack: myservice-dev
endpoints:
  GET - https://abc123.execute-api.us-east-1.amazonaws.com/dev/hello
functions:
  hello: myservice-dev-hello
`;

const _SLS_DEPLOY_FAILURE = `\
Serverless: Packaging service...
Serverless: Updating Stack...
  UPDATE_IN_PROGRESS  AWS::CloudFormation::Stack  myservice-dev
  CREATE_FAILED  AWS::Lambda::Function  hello  Resource handler returned message: "Invalid code"
  UPDATE_ROLLBACK_IN_PROGRESS  AWS::CloudFormation::Stack  myservice-dev
`;

describe("TestServerlessFilter", () => {
  const F = new ServerlessFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_serverless", () => {
    expect(F.matches(["serverless", "deploy"])).toBeTruthy();
  });

  it("test_matches_sls", () => {
    expect(F.matches(["sls", "deploy"])).toBeTruthy();
  });

  it("test_no_match_cdk", () => {
    expect(F.matches(["cdk", "deploy"])).toBeFalsy();
  });

  it("test_no_match_pulumi", () => {
    expect(F.matches(["pulumi", "up"])).toBeFalsy();
  });

  // --- select ------------------------------------------------------------

  it("test_select_serverless", () => {
    expect(bc.select_filter(["serverless", "deploy"]) instanceof ServerlessFilter).toBe(true);
  });

  it("test_select_sls", () => {
    expect(bc.select_filter(["sls", "deploy"]) instanceof ServerlessFilter).toBe(true);
  });

  // --- compress: step lines ---------------------------------------------

  it("test_step_lines_collapsed", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).toContain("Serverless deploy step line(s)");
  });

  it("test_packaging_line_not_verbatim", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).not.toContain("Serverless: Packaging service");
  });

  it("test_uploading_line_not_verbatim", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).not.toContain("Serverless: Uploading CloudFormation");
  });

  // --- compress: CF events ----------------------------------------------

  it("test_in_progress_events_dropped", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    // Individual IN_PROGRESS event lines should not appear verbatim;
    // the compression note mentions "_IN_PROGRESS" in a summary line, that is fine.
    // Check that the actual event lines (with leading spaces and resource types) are gone.
    expect(out).not.toContain("CREATE_IN_PROGRESS  AWS::IAM::Role");
    expect(out).not.toContain("UPDATE_IN_PROGRESS  AWS::CloudFormation::Stack");
  });

  it("test_complete_events_kept", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).toContain("CREATE_COMPLETE");
    expect(out).toContain("UPDATE_COMPLETE");
  });

  it("test_dot_progress_dropped", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).toContain("polling dot");
  });

  // --- compress: service info -------------------------------------------

  it("test_deploy_summary_kept", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).toContain("Service deployed to stack myservice-dev");
  });

  it("test_service_info_section_kept", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).toContain("Service Information");
    expect(out).toContain("service: myservice");
    expect(out).toContain("stage: dev");
  });

  it("test_endpoint_url_kept", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).toContain("execute-api.us-east-1.amazonaws.com");
  });

  it("test_function_list_kept", () => {
    const out = _compress(F, _SLS_DEPLOY_FULL);
    expect(out).toContain("hello: myservice-dev-hello");
  });

  // --- compress: failure path -------------------------------------------

  it("test_failed_cf_event_kept", () => {
    const out = _compress(F, _SLS_DEPLOY_FAILURE);
    expect(out).toContain("CREATE_FAILED");
    expect(out).toContain("Invalid code");
  });

  it("test_error_on_stderr_exit_code", () => {
    const out = _compress(F, "", {
      stderr: "Error: Your AWS credentials are invalid\n",
      exit_code: 1,
    });
    expect(out).toContain("AWS credentials");
  });

  // --- compression ratio ------------------------------------------------

  it("test_significant_compression", () => {
    const result = new ServerlessFilter().apply(_SLS_DEPLOY_FULL, "", 0, ["serverless"]);
    // At least 30% reduction on a typical full deploy output
    expect(result.compressed_bytes).toBeLessThan(result.original_bytes * 0.75);
  });
});
