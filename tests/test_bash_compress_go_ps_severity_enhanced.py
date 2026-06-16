"""Enhanced edge-case tests for GoFilter, PsFilter, SeverityLogFilter, CodexExecFilter, TerraformFilter."""
from __future__ import annotations

import pytest

from tests.filter_test_helpers import apply_filter
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def go() -> bc.GoFilter:
    return bc.GoFilter()


@pytest.fixture()
def ps() -> bc.PsFilter:
    return bc.PsFilter()


@pytest.fixture()
def sev() -> bc.SeverityLogFilter:
    return bc.SeverityLogFilter()


@pytest.fixture()
def codex() -> bc.CodexExecFilter:
    return bc.CodexExecFilter()


@pytest.fixture()
def tf() -> bc.TerraformFilter:
    return bc.TerraformFilter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _go(f: bc.GoFilter, stdout: str, argv: list[str]) -> str:
    return apply_filter(f, stdout=stdout, argv=argv)


def _codex_session(model: str = "gpt-4o", answer: str = "The answer.", tokens: str = "1,234") -> str:
    return (
        f"OpenAI Codex v1.0.0\n"
        f"--------\n"
        f"workdir: /tmp/proj\n"
        f"model: {model}\n"
        f"provider: openai\n"
        f"approval: never\n"
        f"sandbox: read-only\n"
        f"session id: abc-123\n"
        f"--------\n"
        f"user\n"
        f"What is 2+2?\n"
        f"codex\n"
        f"{answer}\n"
        f"tokens used\n"
        f"{tokens}\n"
    )


# ---------------------------------------------------------------------------
# GoFilter — go build / go install
# ---------------------------------------------------------------------------

class TestGoFilterBuildLike:
    def test_empty_input(self, go: bc.GoFilter) -> None:
        out = _go(go, "", ["go", "build", "./..."])
        assert out == ""

    def test_package_header_lines_suppressed(self, go: bc.GoFilter) -> None:
        inp = "# github.com/org/mypkg\n# github.com/org/otherpkg\n"
        out = _go(go, inp, ["go", "build", "./..."])
        assert "# github.com/org/mypkg" not in out
        assert "suppressed" in out

    def test_error_lines_kept_after_header_drop(self, go: bc.GoFilter) -> None:
        inp = "\n".join([
            "# github.com/org/mypkg",
            "main.go:10:5: error: undefined: Foo",
            "main.go:12:1: error: undefined: Bar",
        ])
        out = _go(go, inp, ["go", "build", "."])
        assert "undefined: Foo" in out
        assert "undefined: Bar" in out

    def test_download_lines_collapsed_in_build(self, go: bc.GoFilter) -> None:
        inp = "\n".join([
            "go: downloading github.com/pkg/errors v0.9.1",
            "go: downloading golang.org/x/net v0.0.1",
            "go: extracting github.com/pkg/errors v0.9.1",
        ])
        out = _go(go, inp, ["go", "build", "."])
        assert "collapsed" in out
        assert "go: downloading github.com/pkg/errors" not in out

    def test_successful_build_no_output_stays_empty(self, go: bc.GoFilter) -> None:
        # go build succeeds silently — empty merged output
        out = _go(go, "", ["go", "build", "./..."])
        assert out == ""

    def test_go_run_subcommand_routes_to_build_like(self, go: bc.GoFilter) -> None:
        inp = "# github.com/org/cmd\nmain.go:3:1: error: syntax error"
        out = _go(go, inp, ["go", "run", "main.go"])
        assert "syntax error" in out
        assert "# github.com/org/cmd" not in out

    def test_go_install_drops_pkg_headers(self, go: bc.GoFilter) -> None:
        inp = "# github.com/org/tool\n"
        out = _go(go, inp, ["go", "install", "github.com/org/tool@latest"])
        assert "# github.com/org/tool" not in out

    def test_go_clean_empty_stays_empty(self, go: bc.GoFilter) -> None:
        out = _go(go, "", ["go", "clean", "-cache"])
        assert out == ""


# ---------------------------------------------------------------------------
# GoFilter — go vet
# ---------------------------------------------------------------------------

class TestGoFilterVet:
    def test_vet_progress_lines_dropped(self, go: bc.GoFilter) -> None:
        inp = "\n".join([
            "go: vet github.com/org/pkg",
            "go: vet github.com/org/other",
            "main.go:5:2: printf: wrong number of args",
        ])
        out = _go(go, inp, ["go", "vet", "./..."])
        assert "go: vet" not in out

    def test_vet_warnings_preserved(self, go: bc.GoFilter) -> None:
        inp = "\n".join([
            "go: vet github.com/org/pkg",
            "util.go:20:3: unreachable code",
        ])
        out = _go(go, inp, ["go", "vet", "./..."])
        assert "unreachable code" in out

    def test_vet_progress_drop_count_in_sentinel(self, go: bc.GoFilter) -> None:
        lines = [f"go: vet github.com/org/pkg{i}" for i in range(5)]
        inp = "\n".join(lines)
        out = _go(go, inp, ["go", "vet", "./..."])
        assert "[token-goat: dropped 5 'vet' progress lines]" in out

    def test_vet_empty_input(self, go: bc.GoFilter) -> None:
        out = _go(go, "", ["go", "vet", "./..."])
        assert out == ""


# ---------------------------------------------------------------------------
# GoFilter — go get / go mod download
# ---------------------------------------------------------------------------

class TestGoFilterGet:
    def test_go_get_download_lines_collapsed(self, go: bc.GoFilter) -> None:
        lines = [f"go: downloading example.com/pkg v0.{i}.0" for i in range(10)]
        inp = "\n".join(lines)
        out = _go(go, inp, ["go", "get", "example.com/pkg"])
        assert "collapsed" in out
        assert "go: downloading example.com/pkg v0.0.0" not in out

    def test_go_get_non_download_lines_kept(self, go: bc.GoFilter) -> None:
        inp = "\n".join([
            "go: downloading example.com/dep v1.0.0",
            "go: added example.com/dep v1.0.0",
        ])
        out = _go(go, inp, ["go", "get", "example.com/dep"])
        assert "go: added example.com/dep" in out

    def test_go_mod_download_collapses(self, go: bc.GoFilter) -> None:
        lines = ["go: downloading golang.org/x/tools v0.1.0"] * 8
        inp = "\n".join(lines)
        out = _go(go, inp, ["go", "mod", "download"])
        assert "collapsed" in out

    def test_go_mod_tidy_keeps_module_change_lines(self, go: bc.GoFilter) -> None:
        inp = "\n".join([
            "go: downloading example.com/dep v1.2.3",
            "go: added example.com/dep v1.2.3",
            "go: removed example.com/old v0.9.0",
        ])
        out = _go(go, inp, ["go", "mod", "tidy"])
        assert "go: added example.com/dep" in out
        assert "go: removed example.com/old" in out


# ---------------------------------------------------------------------------
# GoFilter — cross-compilation / matches()
# ---------------------------------------------------------------------------

class TestGoFilterMatches:
    def test_matches_go_build(self) -> None:
        f = bc.GoFilter()
        assert f.matches(["go", "build", "./..."])

    def test_matches_go_vet(self) -> None:
        f = bc.GoFilter()
        assert f.matches(["go", "vet", "./..."])

    def test_does_not_match_go_test(self) -> None:
        # GoTestFilter should win; GoFilter must not claim it
        f = bc.GoFilter()
        assert not f.matches(["go", "test", "./..."])

    def test_does_not_match_bare_go(self) -> None:
        f = bc.GoFilter()
        assert not f.matches(["go"])

    def test_does_not_match_non_go_binary(self) -> None:
        f = bc.GoFilter()
        assert not f.matches(["python", "build"])

    def test_matches_go_generate(self) -> None:
        f = bc.GoFilter()
        assert f.matches(["go", "generate", "./..."])


# ---------------------------------------------------------------------------
# PsFilter — edge cases
# ---------------------------------------------------------------------------

_PS_HEADER = "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND"

def _make_ps(extra_lines: list[str]) -> str:
    return "\n".join([_PS_HEADER] + extra_lines)


class TestPsFilterEdgeCases:
    def test_empty_input(self, ps: bc.PsFilter) -> None:
        out = apply_filter(ps, stdout="")
        assert out == ""

    def test_short_output_passthrough(self, ps: bc.PsFilter) -> None:
        # <= 20 lines → no filtering
        lines = [_PS_HEADER] + [
            f"root       {i}  0.0  0.0  1000  500 ?  S  00:00  0:00 kworker/{i}" for i in range(5)
        ]
        inp = "\n".join(lines)
        out = apply_filter(ps, stdout=inp)
        assert out == inp

    def test_header_always_kept(self, ps: bc.PsFilter) -> None:
        daemon_lines = [
            f"root       {i}  0.0  0.0  1000  500 ?  S  00:00  0:00 kworker/{i}"
            for i in range(25)
        ]
        inp = _make_ps(daemon_lines)
        out = apply_filter(ps, stdout=inp)
        assert _PS_HEADER in out

    def test_sentinel_appended_when_suppressed(self, ps: bc.PsFilter) -> None:
        daemon_lines = [
            f"root       {i}  0.0  0.0  1000  500 ?  S  00:00  0:00 kworker/{i}"
            for i in range(25)
        ]
        inp = _make_ps(daemon_lines)
        out = apply_filter(ps, stdout=inp)
        assert "suppressed" in out
        assert "system processes" in out

    def test_no_sentinel_when_nothing_suppressed(self, ps: bc.PsFilter) -> None:
        # All lines are dev-relevant (python)
        dev_lines = [
            f"user1    {i}  0.0  0.1  50000 2000 ?  S  00:00  0:00 python worker.py"
            for i in range(25)
        ]
        inp = _make_ps(dev_lines)
        out = apply_filter(ps, stdout=inp)
        assert "suppressed" not in out

    def test_high_cpu_process_kept(self, ps: bc.PsFilter) -> None:
        high_cpu = "root       999 99.0  1.0 100000 5000 ?  R  00:00  5:00 crunch"
        daemon_lines = [
            f"root       {i}  0.0  0.0  1000  500 ?  S  00:00  0:00 kworker/{i}"
            for i in range(25)
        ]
        inp = _make_ps([high_cpu] + daemon_lines)
        out = apply_filter(ps, stdout=inp)
        assert "crunch" in out

    def test_high_mem_process_kept(self, ps: bc.PsFilter) -> None:
        high_mem = "root       777  0.1 10.5 200000 8000 ?  S  00:00  0:10 memoryhog"
        daemon_lines = [
            f"root       {i}  0.0  0.0  1000  500 ?  S  00:00  0:00 kworker/{i}"
            for i in range(25)
        ]
        inp = _make_ps([high_mem] + daemon_lines)
        out = apply_filter(ps, stdout=inp)
        assert "memoryhog" in out

    def test_dev_process_node_kept(self, ps: bc.PsFilter) -> None:
        dev_line = "user1   1234  0.5  1.2  80000 4000 ?  S  10:00  0:05 node server.js"
        daemon_lines = [
            f"root       {i}  0.0  0.0  1000  500 ?  S  00:00  0:00 kworker/{i}"
            for i in range(25)
        ]
        inp = _make_ps([dev_line] + daemon_lines)
        out = apply_filter(ps, stdout=inp)
        assert "node server.js" in out

    def test_suppressed_count_in_sentinel(self, ps: bc.PsFilter) -> None:
        daemon_count = 30
        daemon_lines = [
            f"root       {i}  0.0  0.0  1000  500 ?  S  00:00  0:00 kworker/{i}"
            for i in range(daemon_count)
        ]
        inp = _make_ps(daemon_lines)
        out = apply_filter(ps, stdout=inp)
        assert "[suppressed 30 system processes]" in out

    def test_detect_true_for_ps_aux_header(self, ps: bc.PsFilter) -> None:
        assert ps.detect(_PS_HEADER + "\nroot 1 0.0 0.0 0 0 ? S 00:00 0:00 init\n" * 5)

    def test_detect_false_for_plain_text(self, ps: bc.PsFilter) -> None:
        plain = "This is just some random text\nwith no process table structure\nat all.\n"
        assert not ps.detect(plain)


# ---------------------------------------------------------------------------
# SeverityLogFilter — level handling and edge cases
# ---------------------------------------------------------------------------

def _make_log(lines: list[str]) -> str:
    return "\n".join(lines)


class TestSeverityLogFilterLevels:
    def test_empty_input(self, sev: bc.SeverityLogFilter) -> None:
        out = apply_filter(sev, stdout="")
        assert out == ""

    def test_pure_info_debug_suppressed(self, sev: bc.SeverityLogFilter) -> None:
        lines = [f"2024-01-01 INFO  doing thing {i}" for i in range(10)]
        inp = _make_log(lines)
        out = apply_filter(sev, stdout=inp)
        assert "suppressed" in out

    def test_error_line_always_kept(self, sev: bc.SeverityLogFilter) -> None:
        lines = (
            [f"2024-01-01 INFO  step {i}" for i in range(10)]
            + ["2024-01-01 ERROR something broke"]
            + [f"2024-01-01 INFO  after {i}" for i in range(10)]
        )
        inp = _make_log(lines)
        out = apply_filter(sev, stdout=inp)
        assert "ERROR something broke" in out

    def test_warn_line_kept_at_default_threshold(self, sev: bc.SeverityLogFilter) -> None:
        lines = (
            [f"2024-01-01 INFO  msg {i}" for i in range(10)]
            + ["2024-01-01 WARN  disk is almost full"]
        )
        inp = _make_log(lines)
        out = apply_filter(sev, stdout=inp)
        assert "disk is almost full" in out

    def test_suppression_sentinel_count_nonzero(self, sev: bc.SeverityLogFilter) -> None:
        lines = [f"2024-01-01 INFO  noise {i}" for i in range(20)]
        lines.append("2024-01-01 ERROR critical failure")
        inp = _make_log(lines)
        out = apply_filter(sev, stdout=inp)
        # Should have a [suppressed N lines] sentinel with a positive count
        import re
        m = re.search(r"\[suppressed (\d+) lines\]", out)
        assert m is not None
        assert int(m.group(1)) > 0

    def test_stack_trace_after_error_kept(self, sev: bc.SeverityLogFilter) -> None:
        lines = (
            [f"2024-01-01 INFO  step {i}" for i in range(8)]
            + [
                "2024-01-01 ERROR NullPointerException",
                "    at com.example.Foo.bar(Foo.java:42)",
                "    at com.example.Main.main(Main.java:10)",
            ]
        )
        inp = _make_log(lines)
        out = apply_filter(sev, stdout=inp)
        assert "at com.example.Foo.bar" in out

    def test_trace_closed_by_blank_line(self, sev: bc.SeverityLogFilter) -> None:
        lines = (
            [f"2024-01-01 INFO  step {i}" for i in range(8)]
            + [
                "2024-01-01 ERROR boom",
                "    at Trace.line(T.java:1)",
                "",  # blank closes trace window
            ]
            + [f"2024-01-01 DEBUG noise {i}" for i in range(8)]
        )
        inp = _make_log(lines)
        out = apply_filter(sev, stdout=inp)
        # The blank line closes the trace so debug lines after it are suppressed
        assert "suppressed" in out

    def test_detect_requires_five_lines(self, sev: bc.SeverityLogFilter) -> None:
        four_lines = "\n".join([f"INFO msg{i}" for i in range(4)])
        assert not sev.detect(four_lines)

    def test_detect_requires_keyword_ratio(self, sev: bc.SeverityLogFilter) -> None:
        # Only 1 keyword in 10 lines → ratio 0.1 < 0.3 → should not detect
        lines = ["regular text"] * 9 + ["2024-01-01 ERROR boom"]
        inp = _make_log(lines)
        assert not sev.detect(inp)

    def test_json_structured_logs_detected(self, sev: bc.SeverityLogFilter) -> None:
        lines = [
            '{"time":"2024-01-01","level":"INFO","msg":"started"}',
            '{"time":"2024-01-01","level":"INFO","msg":"running"}',
            '{"time":"2024-01-01","level":"WARN","msg":"slow"}',
            '{"time":"2024-01-01","level":"ERROR","msg":"failed"}',
            '{"time":"2024-01-01","level":"INFO","msg":"done"}',
        ]
        inp = _make_log(lines)
        assert sev.detect(inp)

    def test_context_lines_included_around_error(self, sev: bc.SeverityLogFilter) -> None:
        # With default context_lines=2, the 2 INFO lines before/after ERROR are kept
        lines = (
            [f"2024-01-01 INFO  before{i}" for i in range(5)]
            + ["2024-01-01 ERROR critical"]
            + [f"2024-01-01 INFO  after{i}" for i in range(5)]
        )
        inp = _make_log(lines)
        out = apply_filter(sev, stdout=inp)
        # At least one of the INFO lines nearest to the ERROR must appear
        assert "before4" in out or "after0" in out


# ---------------------------------------------------------------------------
# CodexExecFilter — edge cases
# ---------------------------------------------------------------------------

class TestCodexFilterEdgeCases:
    def test_empty_input(self, codex: bc.CodexExecFilter) -> None:
        out = apply_filter(codex, stdout="")
        assert out == ""

    def test_model_extracted_in_summary(self, codex: bc.CodexExecFilter) -> None:
        inp = _codex_session(model="o4-mini")
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "o4-mini" in out

    def test_tokens_extracted_in_summary(self, codex: bc.CodexExecFilter) -> None:
        inp = _codex_session(tokens="42,000")
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "42,000" in out

    def test_config_block_stripped(self, codex: bc.CodexExecFilter) -> None:
        inp = _codex_session()
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "workdir:" not in out
        assert "sandbox:" not in out
        assert "session id:" not in out

    def test_version_banner_stripped(self, codex: bc.CodexExecFilter) -> None:
        inp = _codex_session()
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "OpenAI Codex v1.0.0" not in out

    def test_answer_body_kept(self, codex: bc.CodexExecFilter) -> None:
        inp = _codex_session(answer="Use async/await for concurrency.")
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "async/await for concurrency" in out

    def test_tokens_used_footer_stripped(self, codex: bc.CodexExecFilter) -> None:
        inp = _codex_session(tokens="5,678")
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "tokens used" not in out

    def test_multi_turn_only_last_answer_kept(self, codex: bc.CodexExecFilter) -> None:
        inp = (
            "OpenAI Codex v1.0.0\n"
            "--------\n"
            "workdir: /tmp\nmodel: gpt-4o\nprovider: openai\n"
            "approval: never\nsandbox: read-only\nsession id: x\n"
            "--------\n"
            "user\nFirst question?\n"
            "codex\nFirst answer content.\n"
            "user\nSecond question?\n"
            "codex\nSecond answer content.\n"
            "tokens used\n999\n"
        )
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "Second answer content." in out
        assert "First answer content." not in out

    def test_unknown_format_passthrough(self, codex: bc.CodexExecFilter) -> None:
        inp = "Some random text without codex headers.\nJust output.\n"
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "Some random text" in out

    def test_summary_line_present(self, codex: bc.CodexExecFilter) -> None:
        inp = _codex_session(model="gpt-5", tokens="1,000")
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert out.splitlines()[0].startswith("[codex: model=")

    def test_code_block_in_answer_preserved(self, codex: bc.CodexExecFilter) -> None:
        answer = "Here is the code:\n```python\ndef hello():\n    print('hi')\n```"
        inp = _codex_session(answer=answer)
        out = apply_filter(codex, stdout=inp, argv=["codex"])
        assert "def hello():" in out
        assert "print('hi')" in out


# ---------------------------------------------------------------------------
# TerraformFilter — plan, apply, destroy edge cases
# ---------------------------------------------------------------------------

class TestTerraformFilterPlan:
    def test_empty_input(self, tf: bc.TerraformFilter) -> None:
        out = apply_filter(tf, stdout="", argv=["terraform", "plan"])
        assert out == ""

    def test_refresh_lines_dropped(self, tf: bc.TerraformFilter) -> None:
        inp = "\n".join([
            "aws_instance.web: Refreshing state... [id=i-1234]",
            "aws_s3_bucket.data: Refreshing state... [id=my-bucket]",
            "Plan: 1 to add, 0 to change, 0 to destroy.",
        ])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "plan"])
        assert "Refreshing state" not in out

    def test_plan_summary_kept(self, tf: bc.TerraformFilter) -> None:
        inp = "\n".join([
            "aws_instance.web: Refreshing state... [id=i-1234]",
            "Plan: 2 to add, 1 to change, 0 to destroy.",
        ])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "plan"])
        assert "Plan: 2 to add" in out

    def test_no_changes_line_kept(self, tf: bc.TerraformFilter) -> None:
        inp = "\n".join([
            "aws_instance.web: Refreshing state... [id=i-1234]",
            "No changes. Infrastructure is up-to-date.",
        ])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "plan"])
        assert "No changes" in out

    def test_refresh_lines_drop_counted_in_notes(self, tf: bc.TerraformFilter) -> None:
        refresh_lines = [
            f"aws_instance.r{i}: Refreshing state... [id=i-{i}]"
            for i in range(20)
        ]
        inp = "\n".join(refresh_lines + ["Plan: 0 to add, 0 to change, 0 to destroy."])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "plan"])
        assert "[token-goat: dropped 20 terraform refresh/read lines]" in out


class TestTerraformFilterApply:
    def test_still_creating_collapsed(self, tf: bc.TerraformFilter) -> None:
        inp = "\n".join([
            "aws_instance.web: Still creating... [10s elapsed]",
            "aws_instance.web: Still creating... [20s elapsed]",
            "aws_instance.web: Still creating... [30s elapsed]",
            "aws_instance.web: Creation complete after 35s [id=i-abc]",
            "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
        ])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "apply"])
        # Should not emit all three "Still creating" lines; collapse or keep only last
        still_count = sum(1 for ln in out.splitlines() if "Still creating" in ln)
        assert still_count <= 1

    def test_apply_complete_summary_kept(self, tf: bc.TerraformFilter) -> None:
        inp = "\n".join([
            "aws_instance.web: Creating...",
            "aws_instance.web: Creation complete after 10s [id=i-xyz]",
            "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
        ])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "apply"])
        assert "Apply complete!" in out

    def test_creation_complete_kept(self, tf: bc.TerraformFilter) -> None:
        inp = "\n".join([
            "aws_instance.web: Still creating... [10s elapsed]",
            "aws_instance.web: Creation complete after 15s [id=i-abc]",
            "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
        ])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "apply"])
        assert "Creation complete" in out

    def test_error_block_preserved(self, tf: bc.TerraformFilter) -> None:
        inp = "\n".join([
            "aws_instance.web: Still creating... [10s elapsed]",
            "Error: Error launching instance: InvalidKeyPair.NotFound",
            "",
            "  with aws_instance.web,",
            "  on main.tf line 5, in resource \"aws_instance\" \"web\":",
        ])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "apply"])
        assert "Error: Error launching instance" in out


class TestTerraformFilterInit:
    def test_empty_init_passthrough(self, tf: bc.TerraformFilter) -> None:
        out = apply_filter(tf, stdout="", argv=["terraform", "init"])
        assert out == ""

    def test_init_downloading_collapsed(self, tf: bc.TerraformFilter) -> None:
        lines = [f"- Downloading hashicorp/aws {i}.0.0 for linux_amd64..." for i in range(10)]
        inp = "\n".join(lines + ["Terraform has been successfully initialized!"])
        out = apply_filter(tf, stdout=inp, argv=["terraform", "init"])
        assert "successfully initialized" in out

    def test_tofu_binary_also_matched(self) -> None:
        f = bc.TerraformFilter()
        assert f.matches(["tofu", "plan"])

    def test_terragrunt_binary_also_matched(self) -> None:
        f = bc.TerraformFilter()
        assert f.matches(["terragrunt", "apply"])
