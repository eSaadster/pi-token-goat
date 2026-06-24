/**
 * Tests for cloud CLI bash_compress filters: AwsCliFilter, GcloudFilter,
 * AzureCliFilter.
 *
 * 1:1 port of tests/test_bash_compress_cloud.py. Every Python `def test_*` maps
 * to a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes (TestAwsCliFilter, TestGcloudFilter, TestAzureCliFilter,
 * TestTerraformFilterEnhanced) map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the cloud filter classes + select_filter).
 *  - per-class `_filter()` factory -> a local `_filter()` closure in each
 *    describe block returning a fresh filter instance (snake_case preserved).
 *  - `f.apply(stdout, stderr, exit_code, argv)` returns a CompressedOutput whose
 *    `.text` is the body — called directly, exactly as in Python.
 *  - `json.dumps(data)` / `json.loads(s)` -> JSON.stringify / JSON.parse. The
 *    fixtures the filters round-trip use only ASCII string/number values, so
 *    CPython's default separators and JS's defaults agree on the shapes parsed
 *    back here (the assertions inspect parsed objects / substring markers, not
 *    raw spacing). The filters re-serialise via JSON.stringify(data, null, 2)
 *    matching Python's json.dumps(data, indent=2) for these shapes.
 *
 * Byte-exactness: these filters operate on whole lines and on substring markers
 * ("uploaded N file(s)", "dropped N spinner line(s)", the __token_goat__
 * sentinel, the braille glyphs). The assertions are substring / length checks
 * on the returned string (or on the JSON-parsed result), matching the Python
 * `in` / `not in` / `len(...)` checks; the inputs are ASCII so code-unit length
 * equals byte length for the count assertions.
 *
 * Deferral: TerraformFilter is NOT yet ported (no TS module; the barrel does not
 * export it). The whole TestTerraformFilterEnhanced class (8 tests) is therefore
 * `it.skip`-ed with a "// PORT: deferred" marker and counted in tests_skipped.
 * They land verbatim once TerraformFilter is ported and re-exported.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  AwsCliFilter,
  GcloudFilter,
  AzureCliFilter,
} from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// AwsCliFilter
// ---------------------------------------------------------------------------

describe("TestAwsCliFilter", () => {
  function _filter(): AwsCliFilter {
    return new AwsCliFilter();
  }

  // --- dispatch ---

  it("test_matches_aws", () => {
    const f = _filter();
    expect(f.matches(["aws", "ec2", "describe-instances"])).toBe(true);
    expect(f.matches(["aws2", "s3", "ls"])).toBe(true);
  });

  it("test_does_not_match_gcloud", () => {
    const f = _filter();
    expect(f.matches(["gcloud", "compute", "instances", "list"])).toBe(false);
  });

  it("test_select_filter_returns_aws_cli_filter", () => {
    // AwsCliFilter is registered before AwsFilter so it should win.
    const f = bc.select_filter(["aws", "ec2", "describe-instances"]);
    expect(f).toBeInstanceOf(AwsCliFilter);
  });

  // --- JSON array compression ---

  it("test_compresses_json_array_over_threshold", () => {
    const data = Array.from({ length: 15 }, (_, i) => ({
      id: i,
      name: `resource-${i}`,
    }));
    const text = JSON.stringify(data);
    const result = _filter().apply(text, "", 0, [
      "aws",
      "ec2",
      "describe-instances",
    ]);
    const out = JSON.parse(result.text) as Array<Record<string, unknown>>;
    // Should keep first 3 + summary sentinel
    expect(out.length).toBe(4);
    expect(out[out.length - 1]!["__token_goat__"]).toBe(
      "15 items (showing first 3)",
    );
  });

  it("test_short_json_array_passes_through", () => {
    const data = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const text = JSON.stringify(data);
    const result = _filter().apply(text, "", 0, [
      "aws",
      "ec2",
      "describe-instances",
    ]);
    const out = JSON.parse(result.text) as unknown[];
    expect(out.length).toBe(5);
  });

  it("test_compresses_nested_json_array", () => {
    const data = {
      Instances: Array.from({ length: 20 }, (_, i) => ({
        InstanceId: `i-${String(i).padStart(4, "0")}`,
      })),
    };
    const text = JSON.stringify(data);
    const result = _filter().apply(text, "", 0, [
      "aws",
      "ec2",
      "describe-instances",
    ]);
    const out = JSON.parse(result.text) as {
      Instances: Array<Record<string, unknown>>;
    };
    expect(out.Instances.length).toBe(4);
    expect(
      String(out.Instances[out.Instances.length - 1]!["__token_goat__"]),
    ).toContain("20 items (showing first 3)");
  });

  it("test_non_json_passthrough", () => {
    const text = "NAME\tTYPE\tVALUE\nfoo\tSTRING\tbar\n";
    const result = _filter().apply(text, "", 0, ["aws", "ssm", "get-parameter"]);
    expect(result.text).toContain("foo");
    expect(result.text).toContain("bar");
  });

  // --- S3 transfer collapsing ---

  it("test_s3_cp_collapses_upload_lines", () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `upload: local/file${i}.txt to s3://my-bucket/key${i}.txt`,
    );
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, ["aws", "s3", "cp"]);
    expect(result.text).toContain("uploaded 30 file(s)");
    // Individual upload lines should be gone
    expect(result.text).not.toContain("upload: local/file0");
  });

  it("test_s3_sync_collapses_download_lines", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `download: s3://bucket/key${i}.dat to local/file${i}.dat`,
    );
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, ["aws", "s3", "sync"]);
    expect(result.text).toContain("downloaded 20 file(s)");
  });

  it("test_s3_transfer_drops_progress_bars", () => {
    const lines = [
      "upload: local/big.tar to s3://bucket/big.tar",
      "Completed 100 MiB/1.5 GiB (50.0 MiB/s) with 1 file(s) remaining",
      "Completed 200 MiB/1.5 GiB (52.0 MiB/s) with 1 file(s) remaining",
    ];
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, ["aws", "s3", "cp"]);
    // Progress lines dropped
    expect(result.text).not.toContain("MiB/s");
    expect(result.text).toContain("uploaded 1 file(s)");
  });

  it("test_s3_mv_collapses_upload_and_download", () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `upload: file${i} to s3://b/k${i}`),
      ...Array.from(
        { length: 5 },
        (_, i) => `download: s3://b/k${i} to dest/file${i}`,
      ),
    ];
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, ["aws", "s3", "mv"]);
    expect(result.text).toContain("uploaded 5 file(s)");
    expect(result.text).toContain("downloaded 5 file(s)");
  });

  // --- Error preservation ---

  it("test_preserves_stderr_on_error", () => {
    const stdout = "Some partial output\n";
    const stderr =
      "An error occurred (NoCredentialsError) when calling the DescribeInstances operation\n";
    const result = _filter().apply(stdout, stderr, 1, [
      "aws",
      "ec2",
      "describe-instances",
    ]);
    expect(result.text).toContain("NoCredentialsError");
    expect(result.text).toContain("DescribeInstances");
  });

  it("test_empty_input_no_crash", () => {
    const result = _filter().apply("", "", 0, ["aws", "s3", "ls"]);
    expect(typeof result.text).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// GcloudFilter
// ---------------------------------------------------------------------------

describe("TestGcloudFilter", () => {
  function _filter(): GcloudFilter {
    return new GcloudFilter();
  }

  // --- dispatch ---

  it("test_matches_gcloud", () => {
    const f = _filter();
    expect(f.matches(["gcloud", "compute", "instances", "list"])).toBe(true);
    expect(f.matches(["gcloud", "auth", "login"])).toBe(true);
  });

  it("test_does_not_match_aws", () => {
    expect(
      _filter().matches(["aws", "ec2", "describe-instances"]),
    ).toBe(false);
  });

  it("test_select_filter_returns_gcloud_filter", () => {
    const f = bc.select_filter(["gcloud", "compute", "instances", "list"]);
    expect(f).toBeInstanceOf(GcloudFilter);
  });

  // --- spinner lines ---

  it("test_drops_spinner_lines", () => {
    const lines = [
      "⠏ Waiting for operation to complete...",
      "⠋ Waiting for operation to complete...",
      "⠙ Waiting for operation to complete...",
      "Updated [https://compute.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/instances/my-instance].",
    ];
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, [
      "gcloud",
      "compute",
      "instances",
      "update",
    ]);
    expect(result.text).not.toContain("Waiting for operation");
    expect(result.text).toContain("Updated [https://");
    expect(result.text).toContain("dropped 3 spinner line(s)");
  });

  it("test_keeps_updated_created_deleted_lines", () => {
    const text =
      "Created [https://www.googleapis.com/compute/v1/projects/p/instances/i].\n" +
      "Deleted [https://www.googleapis.com/compute/v1/projects/p/instances/old].\n";
    const result = _filter().apply(text, "", 0, [
      "gcloud",
      "compute",
      "instances",
      "create",
    ]);
    expect(result.text).toContain("Created [https://");
    expect(result.text).toContain("Deleted [https://");
  });

  // --- API enablement lines ---

  it("test_collapses_api_enablement_lines", () => {
    const lines = [
      "Enabling service compute.googleapis.com...",
      "Waiting for async operation projects/p/operations/op-123...",
      "Operation [operation-1234] running...",
      "API enabled.",
    ];
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, ["gcloud", "services", "enable"]);
    expect(result.text).not.toContain("Enabling service");
    expect(result.text).not.toContain("Waiting for async");
    expect(result.text).not.toContain("Operation [operation");
    expect(result.text).toContain("collapsed 3 API enablement line(s)");
    expect(result.text).toContain("API enabled.");
  });

  // --- structured data collapsing ---

  it("test_collapses_large_structured_output", () => {
    // Build a dense YAML-like block that looks like structured data
    const lines = Array.from({ length: 30 }, (_, i) => `  key_${i}: value_${i}`);
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, [
      "gcloud",
      "compute",
      "instances",
      "describe",
    ]);
    expect(result.text).toContain("Resource description:");
    expect(result.text).toContain("use --format=json");
  });

  it("test_short_output_not_collapsed", () => {
    const text = "NAME  ZONE  STATUS\nmy-vm us-c1 RUNNING\n";
    const result = _filter().apply(text, "", 0, [
      "gcloud",
      "compute",
      "instances",
      "list",
    ]);
    expect(result.text).toContain("NAME");
    expect(result.text).not.toContain("Resource description");
  });

  it("test_keeps_do_you_want_to_continue", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `  key_${i}: value_${i}`);
    lines.push("Do you want to continue (Y/n)?");
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, [
      "gcloud",
      "compute",
      "instances",
      "delete",
    ]);
    // The prompt line should prevent pure-structured-data collapse
    // (or survive it if the block is still collapsed)
    // At minimum, no crash
    expect(typeof result.text).toBe("string");
  });

  // --- error preservation ---

  it("test_preserves_stderr_on_error", () => {
    const stdout = "";
    const stderr =
      "ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - The resource was not found\n";
    const result = _filter().apply(stdout, stderr, 1, [
      "gcloud",
      "compute",
      "instances",
      "create",
    ]);
    expect(result.text).toContain("Could not fetch resource");
  });

  it("test_empty_input_no_crash", () => {
    const result = _filter().apply("", "", 0, ["gcloud", "auth", "login"]);
    expect(typeof result.text).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// AzureCliFilter
// ---------------------------------------------------------------------------

describe("TestAzureCliFilter", () => {
  function _filter(): AzureCliFilter {
    return new AzureCliFilter();
  }

  // --- dispatch ---

  it("test_matches_az", () => {
    const f = _filter();
    expect(f.matches(["az", "vm", "list"])).toBe(true);
    expect(f.matches(["az", "group", "create"])).toBe(true);
  });

  it("test_does_not_match_aws", () => {
    expect(
      _filter().matches(["aws", "ec2", "describe-instances"]),
    ).toBe(false);
  });

  it("test_select_filter_returns_azure_cli_filter", () => {
    const f = bc.select_filter(["az", "vm", "list"]);
    expect(f).toBeInstanceOf(AzureCliFilter);
  });

  // --- preview warnings ---

  it("test_collapses_preview_warnings", () => {
    const lines = [
      "Command group 'aks alpha' is in preview and under development. Reference and support levels: https://aka.ms/CLI_refstatus",
      "The command 'az aks nodepool' is in preview and under development.",
      "This command is in preview and under development.",
      "{",
      '  "name": "my-cluster"',
      "}",
    ];
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, ["az", "aks", "create"]);
    expect(result.text).not.toContain("is in preview");
    expect(result.text).toContain("collapsed 3 preview warning(s)");
    expect(result.text).toContain('"name"');
  });

  // --- progress JSON collapsing ---

  it("test_collapses_progress_json_blobs", () => {
    const lines = [
      '{"status": "Running", "percentComplete": 0.0}',
      '{"status": "Running", "percentComplete": 25.0}',
      '{"status": "Running", "percentComplete": 50.0}',
      '{"status": "Running", "percentComplete": 75.0}',
      '{"status": "Succeeded", "percentComplete": 100.0}',
      "Deployment succeeded.",
    ];
    const text = lines.join("\n");
    const result = _filter().apply(text, "", 0, ["az", "deployment", "create"]);
    // Only the last progress blob + success message should remain
    const kept_lines = result.text
      .split("\n")
      .filter((ln) => ln.trim() !== "");
    const progress_lines = kept_lines.filter((ln) => ln.includes('"status"'));
    expect(progress_lines.length).toBe(1);
    expect(
      progress_lines[0]!.includes('"Succeeded"') ||
        progress_lines[0]!.includes("Succeeded"),
    ).toBe(true);
    expect(result.text).toContain("Deployment succeeded.");
  });

  // --- resource provider warning kept ---

  it("test_keeps_resource_provider_not_registered", () => {
    const text =
      "Resource provider 'Microsoft.Compute' is not registered for subscription 'abc123'.\n";
    const result = _filter().apply(text, "", 0, ["az", "vm", "create"]);
    // This is actionable; must survive
    expect(result.text).toContain("not registered");
  });

  // --- JSON array compression ---

  it("test_compresses_json_array_over_threshold", () => {
    const data = Array.from({ length: 15 }, (_, i) => ({
      id: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm${i}`,
    }));
    const text = JSON.stringify(data);
    const result = _filter().apply(text, "", 0, ["az", "vm", "list"]);
    const out = JSON.parse(result.text) as Array<Record<string, unknown>>;
    expect(out.length).toBe(4);
    expect(String(out[out.length - 1]!["__token_goat__"])).toContain(
      "15 items (showing first 3)",
    );
  });

  it("test_short_json_passes_through", () => {
    const data = [{ name: "vm1" }, { name: "vm2" }];
    const text = JSON.stringify(data);
    const result = _filter().apply(text, "", 0, ["az", "vm", "list"]);
    const out = JSON.parse(result.text) as unknown[];
    expect(out.length).toBe(2);
  });

  // --- error preservation ---

  it("test_preserves_stderr_on_error", () => {
    const stdout = "";
    const stderr =
      "ERROR: (ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachines/foo' under resource group 'bar' was not found.\n";
    const result = _filter().apply(stdout, stderr, 1, ["az", "vm", "show"]);
    expect(result.text).toContain("ResourceNotFound");
  });

  it("test_empty_input_no_crash", () => {
    const result = _filter().apply("", "", 0, ["az", "group", "list"]);
    expect(typeof result.text).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// TerraformFilter — enhanced plan/apply behaviors
//
// PORT: deferred — TerraformFilter is not yet ported to TS (no
// bash_compress/terraform module; the barrel does not export TerraformFilter).
// The whole class is it.skip-ed until that filter lands; each test maps 1:1 by
// name and will go live unchanged once `bc.TerraformFilter` resolves.
// ---------------------------------------------------------------------------

describe("TestTerraformFilterEnhanced", () => {
  // --- plan: No changes blocks ---

  it.skip("test_plan_collapses_will_not_be_changed_block", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });

  it.skip("test_plan_keeps_addition_block", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });

  it.skip("test_plan_no_changes_summary_kept", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });

  // --- apply: Still creating/modifying collapsing ---

  it.skip("test_apply_collapses_still_creating_lines", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });

  it.skip("test_apply_collapses_still_modifying_lines", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });

  it.skip("test_apply_keeps_error_block", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });

  it.skip("test_apply_multiple_resources_collapsed_independently", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });

  it.skip("test_apply_preserves_errors_on_nonzero_exit", () => {
    // PORT: deferred — needs TerraformFilter (not yet ported).
  });
});
