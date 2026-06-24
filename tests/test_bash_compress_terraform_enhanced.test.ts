/**
 * Tests for enhanced TerraformFilter: init provider collapsing, show attribute
 * collapsing, plan data-source block collapsing.
 *
 * 1:1 port of tests/test_bash_compress_terraform_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion polarity;
 * the Python test classes (TestTerraformInitCompression,
 * TestTerraformShowCompression, TestTerraformPlanDataSourceCollapsing) map to
 * `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `import token_goat.bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" (re-exports the
 *        framework + TerraformFilter).
 *  - The Python `tf` fixture (a fresh `bc.TerraformFilter()`) maps to a local
 *    `const tf = new TerraformFilter()` inside each `it()`.
 *  - The Python tests call `tf.apply(stdout, "", 0, argv)` directly and read
 *    `.text`; the TS port calls `tf.apply(...)` with the same positional args and
 *    reads `.text`.
 *  - The `_make_show_output` helper on TestTerraformShowCompression maps to a
 *    module-local function of the same name.
 *
 * Fixtures are pure ASCII, so code-unit length equals byte length; no Buffer
 * arithmetic is needed for these particular tests.
 */
import { describe, expect, it } from "vitest";

import { TerraformFilter } from "../src/token_goat/bash_compress.js";

// ===========================================================================
// terraform init — provider download line collapsing
// ===========================================================================

describe("TestTerraformInitCompression", () => {
  it("test_collapses_finding_installing_installed_lines", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "Initializing the backend...",
      "Initializing provider plugins...",
      '- Finding hashicorp/aws versions matching "~> 4.0"...',
      "- Installing hashicorp/aws v4.67.0...",
      "- Installed hashicorp/aws v4.67.0 (signed by HashiCorp)",
      '- Finding hashicorp/random versions matching "~> 3.0"...',
      "- Installing hashicorp/random v3.5.1...",
      "- Installed hashicorp/random v3.5.1 (signed by HashiCorp)",
      "Terraform has been successfully initialized!",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "init"]);
    const text = result.text;
    expect(text).toContain("Terraform has been successfully initialized!");
    expect(text).toContain("Initializing the backend");
    expect(text).not.toContain("- Finding hashicorp/aws");
    expect(text).not.toContain("- Installing hashicorp/aws");
    expect(text).not.toContain("- Installed hashicorp/aws");
    expect(text).toContain("collapsed");
  });

  it("test_keeps_reusing_previous_version_lines", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "Initializing provider plugins...",
      "- Reusing previous version of hashicorp/aws (4.67.0)",
      "- Reusing previous version of hashicorp/random (3.5.1)",
      "Terraform has been successfully initialized!",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "init"]);
    expect(result.text).toContain("Reusing previous version");
    expect(result.text).toContain("Terraform has been successfully initialized!");
  });

  it("test_keeps_warnings_and_errors", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "- Installing hashicorp/aws v4.67.0...",
      "- Installed hashicorp/aws v4.67.0 (signed by HashiCorp)",
      "Warning: Redundant argument",
      "Terraform has been successfully initialized!",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "init"]);
    expect(result.text).toContain("Warning: Redundant argument");
    expect(result.text).not.toContain("- Installing");
  });

  it("test_short_init_passes_through_unchanged", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "Initializing the backend...",
      "Terraform has been successfully initialized!",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "init"]);
    expect(result.text).toContain("Initializing the backend");
    expect(result.text).toContain("Terraform has been successfully initialized!");
  });

  it("test_downloading_lines_collapsed", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "- Downloading hashicorp/aws v4.67.0 for linux_amd64...",
      "- Downloading hashicorp/random v3.5.1 for linux_amd64...",
      "Terraform has been successfully initialized!",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "init"]);
    expect(result.text).not.toContain("Downloading");
    expect(result.text).toContain("Terraform has been successfully initialized!");
  });

  it("test_locking_lines_collapsed", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "- Locking hashicorp/aws (4.67.0) in .terraform.lock.hcl...",
      "- Locking hashicorp/random (3.5.1) in .terraform.lock.hcl...",
      "Terraform has been successfully initialized!",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "init"]);
    expect(result.text).not.toContain("Locking");
    expect(result.text).toContain("Terraform has been successfully initialized!");
  });

  it("test_many_providers_collapsed_to_note", () => {
    const tf = new TerraformFilter();
    const provider_lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      provider_lines.push(
        `- Finding hashicorp/provider${i} versions matching "~> 1.0"...`,
        `- Installing hashicorp/provider${i} v1.0.${i}...`,
        `- Installed hashicorp/provider${i} v1.0.${i} (signed by HashiCorp)`,
      );
    }
    const stdout = [
      "Initializing provider plugins...",
      ...provider_lines,
      "Terraform has been successfully initialized!",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "init"]);
    expect(result.text).toContain("Terraform has been successfully initialized!");
    expect(result.text).toContain("collapsed 60 provider install/find lines");
  });
});

// ===========================================================================
// terraform show — per-resource attribute collapsing
// ===========================================================================

function _make_show_output(n_extra_attrs = 20): string {
  const extra: string[] = [];
  for (let i = 0; i < n_extra_attrs; i++) {
    // Python f'    attr_{i:<20} = "value_{i}"' — {i:<20} left-justifies str(i)
    // in a 20-wide field, so the prefix is `attr_` + that padded number.
    const field = `attr_${String(i).padEnd(20, " ")}`;
    extra.push(`    ${field} = "value_${i}"`);
  }
  const lines = [
    "# aws_instance.web:",
    'resource "aws_instance" "web" {',
    '    id                           = "i-0abc123def456"',
    '    arn                          = "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456"',
    '    name                         = "my-web-server"',
    '    instance_type                = "t3.micro"',
    ...extra,
    "}",
    "",
    "# aws_s3_bucket.data:",
    'resource "aws_s3_bucket" "data" {',
    '    id                           = "my-data-bucket"',
    '    bucket                       = "my-data-bucket"',
    '    region                       = "us-east-1"',
    ...extra.slice(0, 5),
    "}",
  ];
  return lines.join("\n");
}

describe("TestTerraformShowCompression", () => {
  it("test_collapses_non_key_attributes", () => {
    const tf = new TerraformFilter();
    const stdout = _make_show_output(20);
    const result = tf.apply(stdout, "", 0, ["terraform", "show"]);
    const text = result.text;
    expect(text).toContain("aws_instance.web");
    expect(text).toContain("aws_s3_bucket.data");
    expect(text).toContain("collapsed");
  });

  it("test_keeps_id_arn_name_region", () => {
    const tf = new TerraformFilter();
    const stdout = _make_show_output(10);
    const result = tf.apply(stdout, "", 0, ["terraform", "show"]);
    const text = result.text;
    expect(text).toContain("i-0abc123def456");
    expect(text).toContain("arn:aws:ec2");
    expect(text).toContain("my-web-server");
    expect(text).toContain("us-east-1");
  });

  it("test_keeps_resource_block_opener_closer", () => {
    const tf = new TerraformFilter();
    const stdout = _make_show_output(5);
    const result = tf.apply(stdout, "", 0, ["terraform", "show"]);
    const text = result.text;
    expect(text).toContain('resource "aws_instance" "web" {');
    expect(text).toContain("}");
  });

  it("test_state_subcommand_also_compressed", () => {
    const tf = new TerraformFilter();
    const stdout = _make_show_output(15);
    const result = tf.apply(stdout, "", 0, ["terraform", "state"]);
    const text = result.text;
    expect(text).toContain("aws_instance.web");
    expect(text).toContain("collapsed");
  });

  it("test_short_show_output_passes_through", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "# aws_instance.web:",
      'resource "aws_instance" "web" {',
      '    id = "i-abc"',
      "}",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "show"]);
    expect(result.text).toContain("i-abc");
  });

  it("test_show_without_resource_headers_falls_back_to_head_tail", () => {
    const tf = new TerraformFilter();
    // JSON output or plain attribute list without "# resource:" headers
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const stdout = lines.join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "show"]);
    // head/tail fallback: should be shorter than original
    expect(result.text.split("\n").length).toBeLessThan(50);
  });

  it("test_module_resource_header_recognized", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "# module.vpc.aws_vpc.main:",
      'resource "aws_vpc" "main" {',
      '    id                 = "vpc-0abc"',
      '    arn                = "arn:aws:ec2:us-east-1:123:vpc/vpc-0abc"',
      '    cidr_block         = "10.0.0.0/16"',
      "    enable_dns_support = true",
      "    tags               = {}",
      "}",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "show"]);
    expect(result.text).toContain("module.vpc.aws_vpc.main");
    expect(result.text).toContain("vpc-0abc");
  });

  it("test_tags_all_attribute_kept", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "# aws_instance.web:",
      'resource "aws_instance" "web" {',
      '    id                 = "i-abc"',
      '    tags_all           = { Name = "web" }',
      "    cpu_core_count     = 1",
      "    cpu_threads_per_core = 2",
      "}",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "show"]);
    expect(result.text).toContain("tags_all");
    expect(result.text).not.toContain("cpu_core_count");
  });
});

// ===========================================================================
// terraform plan — data source read block collapsing
// ===========================================================================

describe("TestTerraformPlanDataSourceCollapsing", () => {
  it("test_collapses_will_be_read_during_apply_block", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "# data.aws_ami.ubuntu will be read during apply",
      ' <= data "aws_ami" "ubuntu" {',
      "      + id         = (known after apply)",
      "      + image_id   = (known after apply)",
      "    }",
      "# aws_instance.web will be created",
      '  + resource "aws_instance" "web" {',
      "      + ami           = (known after apply)",
      '      + instance_type = "t3.micro"',
      "    }",
      "Plan: 1 to add, 0 to change, 0 to destroy.",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "plan"]);
    const text = result.text;
    // Data source block should be collapsed
    expect(!text.includes("will be read during apply") || text.includes("collapsed")).toBe(
      true,
    );
    // Real resource creation must be preserved (in last-20 window)
    expect(text).toContain("Plan: 1 to add");
  });

  it("test_data_source_collapse_noted", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "# data.aws_caller_identity.current will be read during apply",
      ' <= data "aws_caller_identity" "current" {',
      "      + account_id = (known after apply)",
      "    }",
      "Plan: 0 to add, 0 to change, 0 to destroy.",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "plan"]);
    // The collapsed note should appear
    expect(result.text.includes("collapsed") || result.text.includes("Plan: 0 to add")).toBe(
      true,
    );
  });

  it("test_unchanged_resource_still_collapsed", () => {
    const tf = new TerraformFilter();
    const stdout = [
      "# aws_instance.old will not be changed",
      '  resource "aws_instance" "old" {',
      '      id = "i-old"',
      "  }",
      "# data.aws_ami.ubuntu will be read during apply",
      ' <= data "aws_ami" "ubuntu" {',
      "      + id = (known after apply)",
      "    }",
      "Plan: 0 to add, 0 to change, 0 to destroy.",
    ].join("\n");
    const result = tf.apply(stdout, "", 0, ["terraform", "plan"]);
    const text = result.text;
    expect(text).toContain("Plan: 0 to add");
    expect(!text.includes("will not be changed") || text.includes("collapsed")).toBe(true);
    expect(!text.includes("will be read during apply") || text.includes("collapsed")).toBe(
      true,
    );
  });
});
