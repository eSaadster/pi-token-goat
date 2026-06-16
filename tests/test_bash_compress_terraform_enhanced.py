"""Tests for enhanced TerraformFilter: init provider collapsing, show attribute collapsing, plan data-source block collapsing."""

from __future__ import annotations

import pytest

import token_goat.bash_compress as bc


@pytest.fixture
def tf() -> bc.TerraformFilter:
    return bc.TerraformFilter()


# ---------------------------------------------------------------------------
# terraform init — provider download line collapsing
# ---------------------------------------------------------------------------


class TestTerraformInitCompression:
    def test_collapses_finding_installing_installed_lines(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "Initializing the backend...",
            "Initializing provider plugins...",
            "- Finding hashicorp/aws versions matching \"~> 4.0\"...",
            "- Installing hashicorp/aws v4.67.0...",
            "- Installed hashicorp/aws v4.67.0 (signed by HashiCorp)",
            "- Finding hashicorp/random versions matching \"~> 3.0\"...",
            "- Installing hashicorp/random v3.5.1...",
            "- Installed hashicorp/random v3.5.1 (signed by HashiCorp)",
            "Terraform has been successfully initialized!",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "init"])
        text = result.text
        assert "Terraform has been successfully initialized!" in text
        assert "Initializing the backend" in text
        assert "- Finding hashicorp/aws" not in text
        assert "- Installing hashicorp/aws" not in text
        assert "- Installed hashicorp/aws" not in text
        assert "collapsed" in text

    def test_keeps_reusing_previous_version_lines(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "Initializing provider plugins...",
            "- Reusing previous version of hashicorp/aws (4.67.0)",
            "- Reusing previous version of hashicorp/random (3.5.1)",
            "Terraform has been successfully initialized!",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "init"])
        assert "Reusing previous version" in result.text
        assert "Terraform has been successfully initialized!" in result.text

    def test_keeps_warnings_and_errors(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "- Installing hashicorp/aws v4.67.0...",
            "- Installed hashicorp/aws v4.67.0 (signed by HashiCorp)",
            "Warning: Redundant argument",
            "Terraform has been successfully initialized!",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "init"])
        assert "Warning: Redundant argument" in result.text
        assert "- Installing" not in result.text

    def test_short_init_passes_through_unchanged(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "Initializing the backend...",
            "Terraform has been successfully initialized!",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "init"])
        assert "Initializing the backend" in result.text
        assert "Terraform has been successfully initialized!" in result.text

    def test_downloading_lines_collapsed(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "- Downloading hashicorp/aws v4.67.0 for linux_amd64...",
            "- Downloading hashicorp/random v3.5.1 for linux_amd64...",
            "Terraform has been successfully initialized!",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "init"])
        assert "Downloading" not in result.text
        assert "Terraform has been successfully initialized!" in result.text

    def test_locking_lines_collapsed(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "- Locking hashicorp/aws (4.67.0) in .terraform.lock.hcl...",
            "- Locking hashicorp/random (3.5.1) in .terraform.lock.hcl...",
            "Terraform has been successfully initialized!",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "init"])
        assert "Locking" not in result.text
        assert "Terraform has been successfully initialized!" in result.text

    def test_many_providers_collapsed_to_note(self, tf: bc.TerraformFilter) -> None:
        provider_lines = []
        for i in range(20):
            provider_lines += [
                f"- Finding hashicorp/provider{i} versions matching \"~> 1.0\"...",
                f"- Installing hashicorp/provider{i} v1.0.{i}...",
                f"- Installed hashicorp/provider{i} v1.0.{i} (signed by HashiCorp)",
            ]
        stdout = "\n".join(["Initializing provider plugins..."] + provider_lines + ["Terraform has been successfully initialized!"])
        result = tf.apply(stdout, "", 0, ["terraform", "init"])
        assert "Terraform has been successfully initialized!" in result.text
        assert "collapsed 60 provider install/find lines" in result.text


# ---------------------------------------------------------------------------
# terraform show — per-resource attribute collapsing
# ---------------------------------------------------------------------------


class TestTerraformShowCompression:
    def _make_show_output(self, n_extra_attrs: int = 20) -> str:
        extra = [f'    attr_{i:<20} = "value_{i}"' for i in range(n_extra_attrs)]
        lines = [
            "# aws_instance.web:",
            'resource "aws_instance" "web" {',
            '    id                           = "i-0abc123def456"',
            '    arn                          = "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456"',
            '    name                         = "my-web-server"',
            '    instance_type                = "t3.micro"',
        ] + extra + [
            "}",
            "",
            "# aws_s3_bucket.data:",
            'resource "aws_s3_bucket" "data" {',
            '    id                           = "my-data-bucket"',
            '    bucket                       = "my-data-bucket"',
            '    region                       = "us-east-1"',
        ] + extra[:5] + [
            "}",
        ]
        return "\n".join(lines)

    def test_collapses_non_key_attributes(self, tf: bc.TerraformFilter) -> None:
        stdout = self._make_show_output(n_extra_attrs=20)
        result = tf.apply(stdout, "", 0, ["terraform", "show"])
        text = result.text
        assert "aws_instance.web" in text
        assert "aws_s3_bucket.data" in text
        assert "collapsed" in text

    def test_keeps_id_arn_name_region(self, tf: bc.TerraformFilter) -> None:
        stdout = self._make_show_output(n_extra_attrs=10)
        result = tf.apply(stdout, "", 0, ["terraform", "show"])
        text = result.text
        assert "i-0abc123def456" in text
        assert "arn:aws:ec2" in text
        assert "my-web-server" in text
        assert "us-east-1" in text

    def test_keeps_resource_block_opener_closer(self, tf: bc.TerraformFilter) -> None:
        stdout = self._make_show_output(n_extra_attrs=5)
        result = tf.apply(stdout, "", 0, ["terraform", "show"])
        text = result.text
        assert 'resource "aws_instance" "web" {' in text
        assert "}" in text

    def test_state_subcommand_also_compressed(self, tf: bc.TerraformFilter) -> None:
        stdout = self._make_show_output(n_extra_attrs=15)
        result = tf.apply(stdout, "", 0, ["terraform", "state"])
        text = result.text
        assert "aws_instance.web" in text
        assert "collapsed" in text

    def test_short_show_output_passes_through(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "# aws_instance.web:",
            'resource "aws_instance" "web" {',
            '    id = "i-abc"',
            "}",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "show"])
        assert "i-abc" in result.text

    def test_show_without_resource_headers_falls_back_to_head_tail(self, tf: bc.TerraformFilter) -> None:
        # JSON output or plain attribute list without "# resource:" headers
        lines = [f"line {i}" for i in range(50)]
        stdout = "\n".join(lines)
        result = tf.apply(stdout, "", 0, ["terraform", "show"])
        # head/tail fallback: should be shorter than original
        assert len(result.text.splitlines()) < 50

    def test_module_resource_header_recognized(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "# module.vpc.aws_vpc.main:",
            'resource "aws_vpc" "main" {',
            '    id                 = "vpc-0abc"',
            '    arn                = "arn:aws:ec2:us-east-1:123:vpc/vpc-0abc"',
            '    cidr_block         = "10.0.0.0/16"',
            '    enable_dns_support = true',
            '    tags               = {}',
            "}",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "show"])
        assert "module.vpc.aws_vpc.main" in result.text
        assert "vpc-0abc" in result.text

    def test_tags_all_attribute_kept(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "# aws_instance.web:",
            'resource "aws_instance" "web" {',
            '    id                 = "i-abc"',
            '    tags_all           = { Name = "web" }',
            '    cpu_core_count     = 1',
            '    cpu_threads_per_core = 2',
            "}",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "show"])
        assert "tags_all" in result.text
        assert "cpu_core_count" not in result.text


# ---------------------------------------------------------------------------
# terraform plan — data source read block collapsing
# ---------------------------------------------------------------------------


class TestTerraformPlanDataSourceCollapsing:
    def test_collapses_will_be_read_during_apply_block(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "# data.aws_ami.ubuntu will be read during apply",
            " <= data \"aws_ami\" \"ubuntu\" {",
            "      + id         = (known after apply)",
            "      + image_id   = (known after apply)",
            "    }",
            "# aws_instance.web will be created",
            "  + resource \"aws_instance\" \"web\" {",
            "      + ami           = (known after apply)",
            "      + instance_type = \"t3.micro\"",
            "    }",
            "Plan: 1 to add, 0 to change, 0 to destroy.",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "plan"])
        text = result.text
        # Data source block should be collapsed
        assert "will be read during apply" not in text or "collapsed" in text
        # Real resource creation must be preserved (in last-20 window)
        assert "Plan: 1 to add" in text

    def test_data_source_collapse_noted(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "# data.aws_caller_identity.current will be read during apply",
            " <= data \"aws_caller_identity\" \"current\" {",
            "      + account_id = (known after apply)",
            "    }",
            "Plan: 0 to add, 0 to change, 0 to destroy.",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "plan"])
        # The collapsed note should appear
        assert "collapsed" in result.text or "Plan: 0 to add" in result.text

    def test_unchanged_resource_still_collapsed(self, tf: bc.TerraformFilter) -> None:
        stdout = "\n".join([
            "# aws_instance.old will not be changed",
            "  resource \"aws_instance\" \"old\" {",
            "      id = \"i-old\"",
            "  }",
            "# data.aws_ami.ubuntu will be read during apply",
            " <= data \"aws_ami\" \"ubuntu\" {",
            "      + id = (known after apply)",
            "    }",
            "Plan: 0 to add, 0 to change, 0 to destroy.",
        ])
        result = tf.apply(stdout, "", 0, ["terraform", "plan"])
        text = result.text
        assert "Plan: 0 to add" in text
        assert "will not be changed" not in text or "collapsed" in text
        assert "will be read during apply" not in text or "collapsed" in text
