/**
 * Tests for PulumiFilter, CdkFilter, and WasmPackFilter.
 *
 * 1:1 port of tests/test_bash_compress_pulumi_cdk_wasmpack.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes (TestPulumiFilter, TestCdkFilter,
 * TestWasmPackFilter) map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, stdout, stderr, exit_code, argv)` helper
 *        below, matching the Python `apply_filter` positional signature
 *        (stdout="", stderr="", exit_code=0, argv=None). When argv is omitted
 *        the filter's own `.name` is used as the sole argv element.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the iac filter classes + select_filter + FILTERS).
 *  - Each Python test class has a class-level `F = bc.XFilter()`; ported to a
 *    module-level `const F = new XFilter()` inside each `describe()` block.
 *  - `isinstance(f, bc.XFilter)` -> `f instanceof XFilter`.
 *
 * The fixtures contain a few non-ASCII characters (✅, ✨, ❌, 🎯, :-) etc.)
 * but every assertion is a substring `.includes()` / negated `.includes()`
 * check on the returned string, matching the Python `in` / `not in` checks; no
 * Buffer arithmetic is needed for these particular tests.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { CdkFilter, PulumiFilter, WasmPackFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site). Positional signature matches the
// Python call sites: _compress(F, stdout), _compress(F, "", stderr, exit_code).
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  stdout = "",
  stderr = "",
  exit_code = 0,
  argv?: string[],
): string {
  const argvArg = argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argvArg).text;
}

// ---------------------------------------------------------------------------
// PulumiFilter
// ---------------------------------------------------------------------------

const _PULUMI_UP = `Updating (dev):

     Type                         Name           Plan
 +   pulumi:pulumi:Stack          myapp-dev      create
 +   ├─ aws:s3:Bucket             my-bucket      create
 +   └─ aws:lambda:Function       my-fn          create

     aws:s3:Bucket (my-bucket): creating...
     aws:lambda:Function (my-fn): creating...
     aws:s3:Bucket (my-bucket): still creating... (10s elapsed)
     aws:s3:Bucket (my-bucket): still creating... (20s elapsed)
     aws:s3:Bucket (my-bucket): created (22s)
     aws:lambda:Function (my-fn): still creating... (10s elapsed)
     aws:lambda:Function (my-fn): created (15s)

Resources:
    + 3 to create

Duration: 38s
`;

const _PULUMI_CLEAN = `Previewing update (dev):

No changes. Everything is up-to-date

Resources:
    3 unchanged

Duration: 2s
`;

const _PULUMI_ERROR = `Updating (dev):

     aws:s3:Bucket (my-bucket): creating...

Diagnostics:
  error: preview failed: resource plugin 'aws' not found
`;

describe("TestPulumiFilter", () => {
  const F = new PulumiFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_pulumi", () => {
    expect(F.matches(["pulumi", "up"])).toBeTruthy();
  });

  it("test_no_match_terraform", () => {
    expect(F.matches(["terraform", "apply"])).toBeFalsy();
  });

  it("test_no_match_cdk", () => {
    expect(F.matches(["cdk", "deploy"])).toBeFalsy();
  });

  // --- select ------------------------------------------------------------

  it("test_select_filter", () => {
    const f = bc.select_filter(["pulumi", "up"]);
    expect(f instanceof PulumiFilter).toBe(true);
  });

  // --- compress: progress suppression ------------------------------------

  it("test_still_creating_dropped", () => {
    const out = _compress(F, _PULUMI_UP);
    expect(out).not.toContain("still creating");
  });

  it("test_creating_progress_dropped", () => {
    const out = _compress(F, _PULUMI_UP);
    // The initial "creating..." lines should be dropped
    // (completion "created" lines should remain)
    expect(_count(out, "creating")).toBeLessThanOrEqual(2);
  });

  it("test_created_completion_kept", () => {
    const out = _compress(F, _PULUMI_UP);
    expect(out).toContain("my-bucket): created");
    expect(out).toContain("my-fn): created");
  });

  it("test_summary_kept", () => {
    const out = _compress(F, _PULUMI_UP);
    expect(out).toContain("Resources:");
    expect(out).toContain("Duration:");
  });

  it("test_clean_preview_preserved", () => {
    const out = _compress(F, _PULUMI_CLEAN);
    expect(out).toContain("No changes");
    expect(out).toContain("Resources:");
  });

  it("test_error_exit_preserves_stderr", () => {
    const out = _compress(F, "", _PULUMI_ERROR, 1);
    expect(out).toContain("not found");
  });

  it("test_token_goat_note_on_suppression", () => {
    const out = _compress(F, _PULUMI_UP);
    expect(out).toContain("token-goat");
  });

  // --- FILTERS registry --------------------------------------------------

  it("test_in_filters_registry", () => {
    const names = bc.FILTERS.map((f) => f.name);
    expect(names).toContain("pulumi");
  });
});

// ---------------------------------------------------------------------------
// CdkFilter
// ---------------------------------------------------------------------------

const _CDK_DEPLOY = `MyStack: deploying... [1/1]

[0%] start: Building ...
[50%] success: Built asset ...
[100%] success: Built image asset ...

  CREATE_IN_PROGRESS  AWS::CloudFormation::Stack  MyStack
  CREATE_IN_PROGRESS  AWS::S3::Bucket             MyBucket
  CREATE_IN_PROGRESS  AWS::Lambda::Function       MyFunction
  CREATE_COMPLETE     AWS::S3::Bucket             MyBucket
  CREATE_COMPLETE     AWS::Lambda::Function       MyFunction
  CREATE_COMPLETE     AWS::CloudFormation::Stack  MyStack

 ✅  MyStack

Outputs:
MyStack.BucketName = my-bucket-abc123

Stack ARN:
arn:aws:cloudformation:us-east-1:123456789012:stack/MyStack/abc

✨  Total time: 42.5s
`;

const _CDK_SYNTH = `Successfully synthesized to cdk.out
Supply a stack id (MyStack) to display its template.
`;

const _CDK_DIFF = `Stack MyStack
There were no differences
`;

const _CDK_FAIL = `MyStack: deploying...

  CREATE_IN_PROGRESS   AWS::S3::Bucket  BadBucket
  CREATE_FAILED        AWS::S3::Bucket  BadBucket  Invalid bucket name

❌  Deployment failed: Error: The stack named MyStack failed to deploy
`;

describe("TestCdkFilter", () => {
  const F = new CdkFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_cdk", () => {
    expect(F.matches(["cdk", "deploy"])).toBeTruthy();
  });

  it("test_no_match_pulumi", () => {
    expect(F.matches(["pulumi", "up"])).toBeFalsy();
  });

  it("test_no_match_terraform", () => {
    expect(F.matches(["terraform", "apply"])).toBeFalsy();
  });

  // --- select ------------------------------------------------------------

  it("test_select_filter", () => {
    const f = bc.select_filter(["cdk", "deploy"]);
    expect(f instanceof CdkFilter).toBe(true);
  });

  // --- compress: IN_PROGRESS suppression ---------------------------------

  it("test_in_progress_events_dropped", () => {
    const out = _compress(F, _CDK_DEPLOY);
    expect(out).not.toContain("CREATE_IN_PROGRESS");
  });

  it("test_asset_progress_dropped", () => {
    const out = _compress(F, _CDK_DEPLOY);
    expect(out).not.toContain("[0%] start:");
    expect(out).not.toContain("[50%] success:");
    expect(out).not.toContain("[100%] success:");
  });

  it("test_complete_events_kept", () => {
    const out = _compress(F, _CDK_DEPLOY);
    expect(out).toContain("CREATE_COMPLETE");
    expect(out).toContain("MyBucket");
  });

  it("test_summary_kept", () => {
    const out = _compress(F, _CDK_DEPLOY);
    expect(out).toContain("Outputs:");
    expect(out).toContain("Stack ARN:");
  });

  it("test_checkmark_summary_kept", () => {
    const out = _compress(F, _CDK_DEPLOY);
    expect(out).toContain("✅");
  });

  it("test_total_time_dropped", () => {
    const out = _compress(F, _CDK_DEPLOY);
    expect(out).not.toContain("Total time:");
  });

  it("test_synth_output_preserved", () => {
    const out = _compress(F, _CDK_SYNTH);
    expect(out).toContain("Successfully synthesized");
  });

  it("test_no_diff_preserved", () => {
    const out = _compress(F, _CDK_DIFF);
    expect(out).toContain("There were no differences");
  });

  it("test_failed_events_kept", () => {
    const out = _compress(F, _CDK_FAIL);
    expect(out).toContain("CREATE_FAILED");
    expect(out).toContain("Invalid bucket name");
  });

  it("test_error_exit_preserves_stderr", () => {
    const out = _compress(F, "", _CDK_FAIL, 1);
    expect(out).toContain("Deployment failed");
  });

  it("test_token_goat_note_on_suppression", () => {
    const out = _compress(F, _CDK_DEPLOY);
    expect(out).toContain("token-goat");
  });

  // --- FILTERS registry --------------------------------------------------

  it("test_in_filters_registry", () => {
    const names = bc.FILTERS.map((f) => f.name);
    expect(names).toContain("cdk");
  });
});

// ---------------------------------------------------------------------------
// WasmPackFilter
// ---------------------------------------------------------------------------

const _WASMPACK_BUILD = `[INFO]: Checking for the Wasm target...
[INFO]: Compiling to Wasm...
   Compiling proc-macro2 v1.0.86
   Compiling quote v1.0.36
   Compiling syn v2.0.60
   Compiling wasm-bindgen-macro-support v0.2.92
   Compiling wasm-bindgen v0.2.92
   Compiling my-crate v0.1.0 (/workspace/my-crate)
    Finished release [optimized] target(s) in 42.50s
[INFO]: Installing wasm-bindgen...
[INFO]: Optimizing wasm binaries with \`wasm-opt\`...
[INFO]: :-) Done in 45s.
[INFO]: :-) Your wasm pkg is ready to publish at ./pkg.
`;

const _WASMPACK_BUILD_WARN = `[INFO]: Checking for the Wasm target...
[WARN]: origin crate has no wasm_bindgen dependency
   Compiling my-crate v0.1.0 (/workspace/my-crate)
    Finished dev [unoptimized + debuginfo] target(s) in 3.20s
[INFO]: :-) Done in 5s.
`;

const _WASMPACK_TEST = `[INFO]: 🎯  Testing your wasm!
   Compiling my-crate v0.1.0 (/workspace/my-crate)
    Finished test [unoptimized + debuginfo] target(s) in 5.10s

running 3 tests
test add ... ok
test sub ... ok
test mul ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
`;

const _WASMPACK_ERROR = `[INFO]: Checking for the Wasm target...
error[E0433]: failed to resolve: use of undeclared crate or module \`bad\`
  --> src/lib.rs:1:5
   |
1  | use bad::Thing;
   |     ^^^ use of undeclared crate or module \`bad\`
`;

describe("TestWasmPackFilter", () => {
  const F = new WasmPackFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_wasm_pack", () => {
    expect(F.matches(["wasm-pack", "build"])).toBeTruthy();
  });

  it("test_no_match_cargo", () => {
    expect(F.matches(["cargo", "build"])).toBeFalsy();
  });

  it("test_no_match_npm", () => {
    expect(F.matches(["npm", "run", "build"])).toBeFalsy();
  });

  // --- select ------------------------------------------------------------

  it("test_select_filter", () => {
    const f = bc.select_filter(["wasm-pack", "build"]);
    expect(f instanceof WasmPackFilter).toBe(true);
  });

  // --- compress: INFO / Compiling suppression ----------------------------

  it("test_info_lines_dropped", () => {
    const out = _compress(F, _WASMPACK_BUILD);
    // Pure INFO step announcements should be dropped.  The [INFO]: :-) Your
    // wasm pkg is ready line is preserved because it carries the done signal.
    expect(out).not.toContain("Checking for the Wasm target");
    expect(out).not.toContain("Compiling to Wasm");
    expect(out).not.toContain("Installing wasm-bindgen");
    expect(out).not.toContain("Optimizing wasm binaries");
  });

  it("test_compiling_deps_dropped", () => {
    const out = _compress(F, _WASMPACK_BUILD);
    expect(out).not.toContain("Compiling proc-macro2");
    expect(out).not.toContain("Compiling quote");
    expect(out).not.toContain("Compiling syn");
  });

  it("test_finished_line_kept", () => {
    const out = _compress(F, _WASMPACK_BUILD);
    expect(out).toContain("Finished");
    expect(out).toContain("42.50s");
  });

  it("test_warning_kept", () => {
    const out = _compress(F, _WASMPACK_BUILD_WARN);
    expect(out).toContain("[WARN]:");
    expect(out).toContain("wasm_bindgen");
  });

  it("test_done_summary_kept", () => {
    const out = _compress(F, _WASMPACK_BUILD);
    // "Done" appears in [INFO] lines which are dropped, but "Your wasm pkg"
    // is matched by WASMPACK_DONE_RE directly — test the completion signal.
    expect(out).toContain("Your wasm pkg is ready");
  });

  it("test_test_summary_kept", () => {
    const out = _compress(F, _WASMPACK_TEST);
    expect(out).toContain("test result:");
    expect(out).toContain("3 passed");
  });

  it("test_test_individual_results_kept", () => {
    const out = _compress(F, _WASMPACK_TEST);
    // Individual test result lines (not filtered) should pass through
    expect(out).toContain("test add ... ok");
  });

  it("test_error_exit_preserves_stderr", () => {
    const out = _compress(F, "", _WASMPACK_ERROR, 1);
    expect(out).toContain("E0433");
  });

  it("test_token_goat_note_on_suppression", () => {
    const out = _compress(F, _WASMPACK_BUILD);
    expect(out).toContain("token-goat");
  });

  // --- FILTERS registry --------------------------------------------------

  it("test_in_filters_registry", () => {
    const names = bc.FILTERS.map((f) => f.name);
    expect(names).toContain("wasm-pack");
  });
});

// ---------------------------------------------------------------------------
// Python str.count(sub) — count of non-overlapping occurrences.
// ---------------------------------------------------------------------------
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
