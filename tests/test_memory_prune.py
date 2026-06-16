"""Tests for token_goat.memory_prune."""
from __future__ import annotations

from pathlib import Path

from token_goat.memory_prune import (
    audit_claude_md,
    find_content_duplicates,
    parse_index,
    prune_index,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_memory_dir(tmp_path: Path, entries: list[tuple[str, str | None]], *, extra_header: str = "") -> Path:
    """Create a memory directory with MEMORY.md and optional sibling files.

    *entries* is a list of (filename, body_or_None).  When body is None the
    file is NOT created on disk (simulates a dead link).
    """
    mem_dir = tmp_path / "memory"
    mem_dir.mkdir()

    lines: list[str] = ["# Memory — test\n", "\n"]
    for fname, body in entries:
        lines.append(f"- [{fname}]({fname}) — hook text for {fname}\n")
        if body is not None:
            (mem_dir / fname).write_text(
                f"---\nname: {fname}\ndescription: desc\nmetadata:\n  type: feedback\n---\n{body}\n",
                encoding="utf-8",
            )

    if extra_header:
        lines.insert(0, extra_header + "\n")

    (mem_dir / "MEMORY.md").write_text("".join(lines), encoding="utf-8")
    return mem_dir


# ---------------------------------------------------------------------------
# parse_index
# ---------------------------------------------------------------------------


class TestParseIndex:
    def test_parses_entries(self) -> None:
        text = "# Header\n\n- [Title](foo.md) — hook\n- [Other](bar.md) — hook2\n"
        passthrough, entries = parse_index(text)
        assert len(entries) == 2
        assert entries[0].target == "foo.md"
        assert entries[0].title == "Title"
        assert entries[1].target == "bar.md"

    def test_passthrough_preserves_non_entries(self) -> None:
        text = "# Header\n\nsome note\n- [X](x.md) — hook\n"
        passthrough, entries = parse_index(text)
        pt_lines = [line for _, line in passthrough]
        assert "# Header\n" in pt_lines
        assert "some note\n" in pt_lines
        assert len(entries) == 1

    def test_empty_file(self) -> None:
        passthrough, entries = parse_index("")
        assert entries == []

    def test_no_entries(self) -> None:
        text = "# Just a header\n\nSome prose.\n"
        passthrough, entries = parse_index(text)
        assert entries == []
        assert len(passthrough) == 3


# ---------------------------------------------------------------------------
# prune_index — dead links
# ---------------------------------------------------------------------------


class TestPruneIndexDeadLinks:
    def test_removes_dead_link(self, tmp_path: Path) -> None:
        mem_dir = _make_memory_dir(
            tmp_path,
            [("alive.md", "body"), ("dead.md", None)],
        )
        result = prune_index(mem_dir)
        assert result.changed is True
        assert len(result.removed_dead) == 1
        assert result.removed_dead[0].target == "dead.md"
        assert result.kept == 1

        remaining = (mem_dir / "MEMORY.md").read_text(encoding="utf-8")
        assert "alive.md" in remaining
        assert "dead.md" not in remaining

    def test_no_op_when_all_alive(self, tmp_path: Path) -> None:
        mem_dir = _make_memory_dir(tmp_path, [("a.md", "body"), ("b.md", "body")])
        result = prune_index(mem_dir)
        assert result.changed is False
        assert result.removed_dead == []

    def test_missing_memory_md_returns_no_op(self, tmp_path: Path) -> None:
        empty_dir = tmp_path / "memory"
        empty_dir.mkdir()
        result = prune_index(empty_dir)
        assert result.changed is False

    def test_dry_run_does_not_write(self, tmp_path: Path) -> None:
        mem_dir = _make_memory_dir(tmp_path, [("alive.md", "body"), ("gone.md", None)])
        original = (mem_dir / "MEMORY.md").read_text(encoding="utf-8")
        result = prune_index(mem_dir, dry_run=True)
        assert result.changed is True
        assert len(result.removed_dead) == 1
        assert (mem_dir / "MEMORY.md").read_text(encoding="utf-8") == original


# ---------------------------------------------------------------------------
# prune_index — exact-duplicate targets
# ---------------------------------------------------------------------------


class TestPruneIndexDuplicates:
    def test_removes_exact_dup_target(self, tmp_path: Path) -> None:
        mem_dir = tmp_path / "memory"
        mem_dir.mkdir()
        (mem_dir / "real.md").write_text("body", encoding="utf-8")
        # Two index lines pointing to the same file.
        text = "# Header\n\n- [First](real.md) — hook\n- [Second](real.md) — hook2\n"
        (mem_dir / "MEMORY.md").write_text(text, encoding="utf-8")

        result = prune_index(mem_dir)
        assert result.changed is True
        assert len(result.removed_dup) == 1
        assert result.kept == 1

        remaining = (mem_dir / "MEMORY.md").read_text(encoding="utf-8")
        assert remaining.count("real.md") == 1

    def test_keeps_first_of_duplicates(self, tmp_path: Path) -> None:
        mem_dir = tmp_path / "memory"
        mem_dir.mkdir()
        (mem_dir / "f.md").write_text("body", encoding="utf-8")
        text = "# H\n\n- [First](f.md) — keep\n- [Second](f.md) — drop\n"
        (mem_dir / "MEMORY.md").write_text(text, encoding="utf-8")

        prune_index(mem_dir)
        remaining = (mem_dir / "MEMORY.md").read_text(encoding="utf-8")
        assert "keep" in remaining
        assert "drop" not in remaining


# ---------------------------------------------------------------------------
# prune_index — header + freeform line preservation
# ---------------------------------------------------------------------------


class TestPruneIndexPreservesStructure:
    def test_preserves_header_and_blank_lines(self, tmp_path: Path) -> None:
        mem_dir = _make_memory_dir(tmp_path, [("a.md", "body"), ("dead.md", None)])
        result = prune_index(mem_dir)
        assert result.changed is True
        remaining = (mem_dir / "MEMORY.md").read_text(encoding="utf-8")
        assert remaining.startswith("# Memory")

    def test_preserves_freeform_note(self, tmp_path: Path) -> None:
        mem_dir = tmp_path / "memory"
        mem_dir.mkdir()
        (mem_dir / "a.md").write_text("body", encoding="utf-8")
        text = "# H\n\nsome note line\n- [A](a.md) — hook\n- [Dead](dead.md) — hook\n"
        (mem_dir / "MEMORY.md").write_text(text, encoding="utf-8")

        result = prune_index(mem_dir)
        assert result.changed is True
        remaining = (mem_dir / "MEMORY.md").read_text(encoding="utf-8")
        assert "some note line" in remaining


# ---------------------------------------------------------------------------
# prune_index — tokens_saved
# ---------------------------------------------------------------------------


class TestPruneIndexTokensSaved:
    def test_tokens_saved_positive_when_changed(self, tmp_path: Path) -> None:
        mem_dir = _make_memory_dir(tmp_path, [("a.md", "body"), ("gone.md", None)])
        result = prune_index(mem_dir)
        assert result.changed is True
        assert result.tokens_saved > 0


# ---------------------------------------------------------------------------
# audit_claude_md
# ---------------------------------------------------------------------------


class TestAuditClaudeMd:
    def test_detects_exact_dup_lines(self, tmp_path: Path) -> None:
        p = tmp_path / "CLAUDE.md"
        p.write_text("# Title\n\nDuplicated line.\nOther line.\nDuplicated line.\n", encoding="utf-8")
        reports = audit_claude_md([p])
        assert len(reports) == 1
        assert any("Duplicated line." in t for _, _, t in reports[0].exact_dup_lines)

    def test_detects_dup_sections(self, tmp_path: Path) -> None:
        p = tmp_path / "CLAUDE.md"
        p.write_text("## Rules\n\nsome text\n\n## Rules\n\nmore text\n", encoding="utf-8")
        reports = audit_claude_md([p])
        assert any(h == "## Rules" for h, _ in reports[0].dup_sections)

    def test_detects_cross_file_overlap(self, tmp_path: Path) -> None:
        p1 = tmp_path / "global.md"
        p2 = tmp_path / "project.md"
        shared = "Always run tests before committing."
        p1.write_text(f"# G\n\n{shared}\n", encoding="utf-8")
        p2.write_text(f"# P\n\n{shared}\nOther stuff.\n", encoding="utf-8")
        reports = audit_claude_md([p1, p2])
        overlaps = [r.cross_file_overlaps for r in reports]
        assert any(overlaps)

    def test_missing_file_skipped(self, tmp_path: Path) -> None:
        missing = tmp_path / "nonexistent.md"
        reports = audit_claude_md([missing])
        assert reports == []

    def test_no_issues_returns_clean_report(self, tmp_path: Path) -> None:
        p = tmp_path / "CLAUDE.md"
        p.write_text("# Title\n\nUnique line A.\nUnique line B.\n", encoding="utf-8")
        reports = audit_claude_md([p])
        assert len(reports) == 1
        assert reports[0].exact_dup_lines == []
        assert reports[0].dup_sections == []


# ---------------------------------------------------------------------------
# find_content_duplicates (Jaccard fallback, no fastembed required)
# ---------------------------------------------------------------------------


class TestFindContentDuplicates:
    def test_no_clusters_for_distinct_content(self, tmp_path: Path) -> None:
        mem_dir = tmp_path / "memory"
        mem_dir.mkdir()
        for i, body in enumerate(["alpha beta gamma delta", "one two three four five six seven eight"]):
            p = mem_dir / f"mem_{i}.md"
            p.write_text(f"---\nname: m{i}\ndescription: desc{i}\nmetadata:\n  type: feedback\n---\n{body}\n", encoding="utf-8")
        clusters = find_content_duplicates(mem_dir)
        # Distinct content → no clusters (Jaccard well below 0.60).
        assert clusters == []

    def test_detects_near_identical(self, tmp_path: Path) -> None:
        mem_dir = tmp_path / "memory"
        mem_dir.mkdir()
        body = "use haiku for simple tasks and sonnet for complex implementations always"
        for i in range(2):
            p = mem_dir / f"mem_{i}.md"
            p.write_text(f"---\nname: m{i}\ndescription: model selection\nmetadata:\n  type: feedback\n---\n{body}\n", encoding="utf-8")
        clusters = find_content_duplicates(mem_dir)
        assert len(clusters) >= 1
        assert clusters[0].similarity >= 0.60

    def test_single_file_returns_empty(self, tmp_path: Path) -> None:
        mem_dir = tmp_path / "memory"
        mem_dir.mkdir()
        (mem_dir / "only.md").write_text("body", encoding="utf-8")
        clusters = find_content_duplicates(mem_dir)
        assert clusters == []
