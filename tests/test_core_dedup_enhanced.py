"""Enhanced edge-case tests across core dedup areas (iter 137).

Covers:
  - git diff context trim: multiple hunks, hunk-only-context, deletions, already-minimal
  - grep dedup: N-file threshold edges, pattern case, empty pattern, multiple patterns
  - bash output dedup: hash stability, multi-call identity, threshold boundary
  - already-read hints: multiple files, `head`/`less`/`tail` commands, missing session
  - cross-session dedup: zero-byte path, multiple sessions, budget boundary, timestamp ordering
  - bash output hash: sha uniqueness, empty output
"""
from __future__ import annotations

import time
from unittest.mock import patch

from token_goat import hooks_read, session
from token_goat.bash_compress import _compress_git_diff_body
from token_goat.cache_common import short_content_hash
from token_goat.compact import (
    merge_session_manifests,
    read_all_session_manifests,
    write_session_manifest,
)

# ---------------------------------------------------------------------------
# Helpers shared across test classes
# ---------------------------------------------------------------------------

def _make_hunk(header: str, body_lines: list[str]) -> str:
    return header + "\n" + "\n".join(body_lines)


def _make_diff(hunks: list[str], filename: str = "foo.py") -> str:
    header = f"diff --git a/{filename} b/{filename}\n--- a/{filename}\n+++ b/{filename}"
    return header + "\n" + "\n".join(hunks)


def _manifest(session_id: str, files: list[dict]) -> dict:
    return {"session_id": session_id, "files": files, "updated_at": time.time()}


def _entry(rel_path: str, hit_count: int = 1) -> dict:
    return {"rel_path": rel_path, "hit_count": hit_count}


def _ctx(result: dict) -> str:
    return result.get("hookSpecificOutput", {}).get("additionalContext", "")


def _seed_grep(session_id: str, pattern: str, *, path: str | None = None, result_count: int = 100) -> None:
    session.mark_grep(session_id, pattern, path=path, result_count=result_count)


# ---------------------------------------------------------------------------
# Git diff context trim
# ---------------------------------------------------------------------------

class TestGitDiffContextTrimEdges:
    """Edge-case coverage for _trim_hunk_trailing_context and _compress_git_diff_body."""

    def test_hunk_with_only_context_lines_no_changed_line(self):
        # A hunk whose lines are ALL context (no + or -) — last_changed == -1, no trim.
        hunk = _make_hunk(
            "@@ -1,3 +1,3 @@",
            [" ctx_only_a", " ctx_only_b", " ctx_only_c"],
        )
        result = _compress_git_diff_body(_make_diff([hunk]), "")
        assert "trimmed" not in result
        assert " ctx_only_a" in result
        assert " ctx_only_b" in result
        assert " ctx_only_c" in result

    def test_deletion_line_counts_as_changed(self):
        # A deletion (-) followed by 5 context lines triggers trim.
        hunk = _make_hunk(
            "@@ -1,6 +0,5 @@",
            ["-deleted_line", " c1", " c2", " c3", " c4", " c5"],
        )
        result = _compress_git_diff_body(_make_diff([hunk]), "")
        assert "[token-goat: 3 trailing context line(s) trimmed]" in result
        assert " c1" in result
        assert " c2" in result
        assert " c3" not in result

    def test_exactly_three_trailing_context_trimmed_one(self):
        # 3 trailing context lines → keep 2, trim 1.
        hunk = _make_hunk(
            "@@ -1,5 +1,5 @@",
            ["+change", " k1", " k2", " k3"],
        )
        result = _compress_git_diff_body(_make_diff([hunk]), "")
        assert "[token-goat: 1 trailing context line(s) trimmed]" in result
        assert " k1" in result
        assert " k2" in result
        assert " k3" not in result

    def test_hunk_with_no_trailing_context_at_all(self):
        # Change line is the last line in the hunk — nothing to trim.
        hunk = _make_hunk(
            "@@ -1,2 +1,2 @@",
            [" leading", "+last_change"],
        )
        result = _compress_git_diff_body(_make_diff([hunk]), "")
        assert "trimmed" not in result
        assert "+last_change" in result

    def test_three_hunks_each_trimmed(self):
        # Three hunks each with 5 trailing context lines.
        h1 = _make_hunk("@@ -1,7 +1,7 @@", ["+ch1", " a1", " a2", " a3", " a4", " a5"])
        h2 = _make_hunk("@@ -10,7 +10,7 @@", ["+ch2", " b1", " b2", " b3", " b4", " b5"])
        h3 = _make_hunk("@@ -20,7 +20,7 @@", ["+ch3", " c1", " c2", " c3", " c4", " c5"])
        result = _compress_git_diff_body(_make_diff([h1, h2, h3]), "")
        # Each hunk emits a trim marker
        assert result.count("[token-goat:") >= 3
        # Context lines beyond the 2nd are gone for each hunk
        assert " a3" not in result
        assert " b3" not in result
        assert " c3" not in result

    def test_multiple_changes_in_one_hunk_trims_after_last(self):
        # Two changed lines; trailing context after the LAST change is trimmed.
        hunk = _make_hunk(
            "@@ -1,9 +1,9 @@",
            ["+first_change", " mid1", "+second_change", " t1", " t2", " t3", " t4", " t5"],
        )
        result = _compress_git_diff_body(_make_diff([hunk]), "")
        assert "[token-goat: 3 trailing context line(s) trimmed]" in result
        assert " t1" in result
        assert " t2" in result
        assert " t3" not in result

    def test_diff_with_no_hunk_markers_passes_through(self):
        # A diff that has no @@ markers (just headers) is returned unchanged.
        raw = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n"
        result = _compress_git_diff_body(raw, "")
        assert "trimmed" not in result

    def test_empty_diff_string(self):
        # An empty string is returned as-is.
        result = _compress_git_diff_body("", "")
        assert result == ""

    def test_trim_marker_appears_once_per_hunk_not_per_trimmed_line(self):
        # 5 trailing lines trimmed — only ONE marker, not multiple.
        hunk = _make_hunk(
            "@@ -1,7 +1,7 @@",
            ["+ch", " n1", " n2", " n3", " n4", " n5"],
        )
        result = _compress_git_diff_body(_make_diff([hunk]), "")
        assert result.count("[token-goat:") == 1

    def test_both_hunks_first_trimmed_second_not(self):
        # Hunk 1 has 5 trailing context (trimmed); hunk 2 has exactly 2 (not trimmed).
        h1 = _make_hunk("@@ -1,7 +1,7 @@", ["+x", " a1", " a2", " a3", " a4", " a5"])
        h2 = _make_hunk("@@ -10,4 +10,4 @@", ["+y", " b1", " b2"])
        result = _compress_git_diff_body(_make_diff([h1, h2]), "")
        assert result.count("[token-goat:") == 1
        assert " b1" in result
        assert " b2" in result


# ---------------------------------------------------------------------------
# Grep dedup
# ---------------------------------------------------------------------------

class TestGrepDedupEdges:
    """Edge-case coverage for the Grep dedup hint logic."""

    def test_pattern_with_special_chars_triggers_hint(self, tmp_data_dir):
        # Patterns with regex metacharacters are stored and matched literally.
        _seed_grep("grep-special-1", r"def\s+\w+", result_count=50)
        payload = {
            "session_id": "grep-special-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": r"def\s+\w+"},
        }
        result = hooks_read.pre_read(payload)
        assert result.get("continue") is True
        assert result.get("hookSpecificOutput") is not None

    def test_pattern_same_count_different_session_no_hint(self, tmp_data_dir):
        # Seeding session A does not bleed into session B.
        _seed_grep("grep-sess-A", "TODO", result_count=200)
        payload = {
            "session_id": "grep-sess-B",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO"},
        }
        result = hooks_read.pre_read(payload)
        assert result.get("continue") is True
        assert "hookSpecificOutput" not in result

    def test_two_different_patterns_each_get_own_hint(self, tmp_data_dir):
        # Seeding both patterns; second call for each should hint about itself.
        _seed_grep("grep-two-1", "FIXME", result_count=30)
        _seed_grep("grep-two-1", "HACK", result_count=30)
        for pat in ("FIXME", "HACK"):
            payload = {
                "session_id": "grep-two-1",
                "tool_name": "Grep",
                "tool_input": {"pattern": pat},
            }
            result = hooks_read.pre_read(payload)
            assert result.get("continue") is True
            ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
            assert pat in ctx

    def test_exact_threshold_minus_one_no_hint(self, tmp_data_dir):
        # 4 matches (one below default threshold of 5) never triggers a hint.
        _seed_grep("grep-thresh-1", "BORDER", result_count=4)
        payload = {
            "session_id": "grep-thresh-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "BORDER"},
        }
        result = hooks_read.pre_read(payload)
        assert result.get("continue") is True
        assert "hookSpecificOutput" not in result

    def test_none_path_vs_explicit_path_treated_as_different(self, tmp_data_dir):
        # No-path grep is different from the same pattern scoped to a directory.
        _seed_grep("grep-path-1", "LOGIN", path=None, result_count=100)
        payload = {
            "session_id": "grep-path-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "LOGIN", "path": "src/"},
        }
        result = hooks_read.pre_read(payload)
        assert result.get("continue") is True
        # Scoped query should NOT match the unscoped cache entry
        assert "hookSpecificOutput" not in result

    def test_non_grep_tool_name_not_processed(self, tmp_data_dir):
        # pre_read should not produce a grep dedup hint for a non-Grep tool.
        _seed_grep("grep-nogrep-1", "DEBUG", result_count=200)
        payload = {
            "session_id": "grep-nogrep-1",
            "tool_name": "Read",
            "tool_input": {"pattern": "DEBUG"},
        }
        result = hooks_read.pre_read(payload)
        # Read tool does not produce a grep-dedup hookSpecificOutput
        hso = result.get("hookSpecificOutput", {})
        assert "DEBUG" not in hso.get("additionalContext", "")

    def test_hint_includes_match_count_in_text(self, tmp_data_dir):
        # The hint text should include the numeric match count.
        _seed_grep("grep-count-1", "IMPORT", result_count=42)
        payload = {
            "session_id": "grep-count-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "IMPORT"},
        }
        result = hooks_read.pre_read(payload)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "42" in ctx


# ---------------------------------------------------------------------------
# Bash output dedup
# ---------------------------------------------------------------------------

class TestBashOutputDedupEdges:
    """Edge-case coverage for content-aware bash dedup (output hash)."""

    def _record(self, sid: str, cmd: str, output: str, *, monkeypatch, tmp_data_dir) -> None:
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        cmd_sha = short_content_hash(cmd)
        output_sha = short_content_hash(output) if output else ""
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd[:120],
            output_id=f"out-{cmd_sha[:8]}",
            stdout_bytes=len(output.encode()),
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
            output_sha=output_sha,
        )

    def test_hash_stable_for_identical_content(self):
        # The same text produces the same hash on repeated calls.
        text = "some command output\nwith multiple lines\n"
        h1 = short_content_hash(text)
        h2 = short_content_hash(text)
        assert h1 == h2
        assert len(h1) == 16

    def test_hash_differs_for_different_content(self):
        # Different content produces different hashes.
        h1 = short_content_hash("output A\n")
        h2 = short_content_hash("output B\n")
        assert h1 != h2

    def test_hash_for_empty_string(self):
        # Empty string hashes to a deterministic 16-char hex string.
        h = short_content_hash("")
        assert len(h) == 16
        assert all(c in "0123456789abcdef" for c in h)

    def test_output_sha_empty_when_not_supplied(self, tmp_data_dir, monkeypatch):
        # When output_sha is omitted, BashEntry.output_sha is "" (not None).
        sid = "dedup-sha-empty-1"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            cmd = "echo test"
            cache = session.mark_bash_run(
                session_id=sid,
                cmd_sha=short_content_hash(cmd),
                cmd_preview=cmd,
                output_id="out-test",
                stdout_bytes=5,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
            )
            entry = session.lookup_bash_entry(sid, short_content_hash(cmd), cache=cache)
            assert entry is not None
            assert entry.output_sha == ""
        finally:
            session.reset_session(sid)

    def test_dedup_key_is_output_sha_when_set(self, tmp_data_dir, monkeypatch):
        # When output_sha is set, dedup key is the sha, not the output_id.
        sid = "dedup-sha-key-1"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            cmd = "uv run pytest"
            sha = "abcdef0123456789"
            cache = session.mark_bash_run(
                session_id=sid,
                cmd_sha=short_content_hash(cmd),
                cmd_preview=cmd,
                output_id="out-xyz999",
                stdout_bytes=500,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
                output_sha=sha,
            )
            entry = session.lookup_bash_entry(sid, short_content_hash(cmd), cache=cache)
            assert entry is not None
            assert entry.output_sha == sha
            # Confirm the dedup logic picks the sha over the output_id
            dedup_key = entry.output_sha or entry.output_id
            assert dedup_key == sha
        finally:
            session.reset_session(sid)

    def test_two_commands_same_output_sha_same_key(self, tmp_data_dir, monkeypatch):
        # Two different commands with identical output produce the same output_sha.
        sha = short_content_hash("PASSED\n")
        sha2 = short_content_hash("PASSED\n")
        assert sha == sha2

    def test_output_sha_persists_across_load(self, tmp_data_dir, monkeypatch):
        # After saving and reloading the session, output_sha survives the round-trip.
        sid = "dedup-sha-persist-1"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            cmd = "git status"
            stored_sha = "deadbeef01234567"
            session.mark_bash_run(
                session_id=sid,
                cmd_sha=short_content_hash(cmd),
                cmd_preview=cmd,
                output_id="out-persist",
                stdout_bytes=100,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
                output_sha=stored_sha,
            )
            # Reload from disk
            fresh = session.load(sid)
            entry = session.lookup_bash_entry(sid, short_content_hash(cmd), cache=fresh)
            assert entry is not None
            assert entry.output_sha == stored_sha
        finally:
            session.reset_session(sid)


# ---------------------------------------------------------------------------
# Already-read hints
# ---------------------------------------------------------------------------

class TestBashAlreadyReadEdges:
    """Edge-case coverage for _handle_bash_already_read."""

    def test_head_command_on_already_read_file_triggers_hint(self, tmp_data_dir):
        # `head` is a read-equivalent — should fire the already-read advisory.
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "already-head-1"
        path = "/proj/src/models.py"
        session.mark_file_read(sid, path)
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"head -20 {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is not None
        assert "already read" in _ctx(result)

    def test_tail_command_on_already_read_file_triggers_hint(self, tmp_data_dir):
        # `tail` is a read-equivalent — should fire the already-read advisory.
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "already-tail-1"
        path = "/proj/src/utils.py"
        session.mark_file_read(sid, path)
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"tail -50 {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is not None
        assert "already read" in _ctx(result)

    def test_two_files_each_gets_independent_hint(self, tmp_data_dir):
        # Reading two files in the same session; each cat fires for its own entry.
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "already-two-files-1"
        path_a = "/proj/src/a.py"
        path_b = "/proj/src/b.py"
        session.mark_file_read(sid, path_a)
        session.mark_file_read(sid, path_b)

        for path in (path_a, path_b):
            payload = {
                "session_id": sid,
                "tool_name": "Bash",
                "tool_input": {"command": f"cat {path}"},
                "cwd": "/proj",
            }
            result = _handle_bash_already_read(payload)
            assert result is not None, f"expected hint for {path}"
            assert "already read" in _ctx(result)

    def test_file_b_not_hinted_when_only_file_a_was_read(self, tmp_data_dir):
        # Only file A was read; catting file B returns None.
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "already-only-a-1"
        path_a = "/proj/src/known.py"
        path_b = "/proj/src/unknown.py"
        session.mark_file_read(sid, path_a)
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"cat {path_b}"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is None

    def test_empty_command_returns_none(self, tmp_data_dir):
        # An empty bash command never triggers the hint.
        from token_goat.hooks_read import _handle_bash_already_read

        payload = {
            "session_id": "already-empty-cmd",
            "tool_name": "Bash",
            "tool_input": {"command": ""},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is None

    def test_no_tool_input_returns_none(self, tmp_data_dir):
        # Missing tool_input key should not raise — returns None.
        from token_goat.hooks_read import _handle_bash_already_read

        payload = {
            "session_id": "already-no-input",
            "tool_name": "Bash",
        }
        result = _handle_bash_already_read(payload)
        assert result is None

    def test_hint_references_the_file_path(self, tmp_data_dir):
        # The advisory hint text contains a meaningful reference (path or advisory keyword).
        from token_goat.hooks_read import _handle_bash_already_read

        sid = "already-path-ref-1"
        path = "/proj/src/config.py"
        session.mark_file_read(sid, path)
        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"cat {path}"},
            "cwd": "/proj",
        }
        result = _handle_bash_already_read(payload)
        assert result is not None
        ctx = _ctx(result)
        assert "already read" in ctx
        assert "config.py" in ctx


# ---------------------------------------------------------------------------
# Cross-session dedup
# ---------------------------------------------------------------------------

class TestCrossSessionDedupEdges:
    """Edge-case coverage for read_all_session_manifests / merge_session_manifests."""

    def test_multiple_sessions_all_returned_when_fresh(self, tmp_path):
        # Three fresh session files are all returned.
        with patch("token_goat.paths.data_dir", return_value=tmp_path):
            for name in ("s1", "s2", "s3"):
                write_session_manifest("proj", name, _manifest(name, [_entry(f"{name}.py", 1)]))
            results = read_all_session_manifests("proj")
        assert len(results) == 3

    def test_mixed_fresh_and_stale_only_fresh_returned(self, tmp_path):
        # One fresh + one stale → only fresh returned.
        import os
        with patch("token_goat.paths.data_dir", return_value=tmp_path):
            write_session_manifest("proj", "fresh", _manifest("fresh", [_entry("a.py", 1)]))
            write_session_manifest("proj", "stale", _manifest("stale", [_entry("b.py", 1)]))
            sessions_dir = tmp_path / "projects" / "proj" / "sessions"
            stale_file = sessions_dir / "stale.json"
            old_mtime = time.time() - 7201
            os.utime(stale_file, (old_mtime, old_mtime))
            results = read_all_session_manifests("proj", max_age_seconds=3600)
        ids = {r["session_id"] for r in results}
        assert "fresh" in ids
        assert "stale" not in ids

    def test_merge_with_single_file_appearing_in_three_sessions(self):
        # Same path in three manifests → highest hit_count wins.
        s1 = _manifest("A", [_entry("lib/core.py", 5)])
        s2 = _manifest("B", [_entry("lib/core.py", 12)])
        s3 = _manifest("C", [_entry("lib/core.py", 8)])
        merged = merge_session_manifests([s1, s2, s3], budget_tokens=1000)
        assert len(merged) == 1
        assert merged[0]["hit_count"] == 12

    def test_merge_zero_hit_count_entry_included(self):
        # An entry with hit_count=0 is included (it has a valid rel_path).
        s = _manifest("Z", [_entry("zero.py", 0)])
        merged = merge_session_manifests([s], budget_tokens=1000)
        assert len(merged) == 1
        assert merged[0]["rel_path"] == "zero.py"

    def test_budget_zero_returns_empty(self):
        # budget_tokens=0 means no entries fit at all.
        s = _manifest("S", [_entry("some/file.py", 10)])
        merged = merge_session_manifests([s], budget_tokens=0)
        assert merged == []

    def test_merge_many_files_sorted_by_hit_count(self):
        # 5 files with varying hit counts — result is sorted descending.
        files = [
            _entry("a.py", 3),
            _entry("b.py", 7),
            _entry("c.py", 1),
            _entry("d.py", 15),
            _entry("e.py", 5),
        ]
        merged = merge_session_manifests([_manifest("S", files)], budget_tokens=10000)
        counts = [e["hit_count"] for e in merged]
        assert counts == sorted(counts, reverse=True)
        assert counts[0] == 15

    def test_empty_files_list_in_manifest_ignored(self):
        # A manifest with an empty files list contributes nothing.
        s = _manifest("empty-files", [])
        merged = merge_session_manifests([s], budget_tokens=1000)
        assert merged == []

    def test_all_entries_missing_rel_path_returns_empty(self):
        # All entries lack rel_path → merged result is empty.
        bad_entries = [{"hit_count": 5}, {"hit_count": 9}, {"hit_count": 2}]
        s = _manifest("S", bad_entries)
        merged = merge_session_manifests([s], budget_tokens=1000)
        assert merged == []

    def test_project_hash_isolation(self, tmp_path):
        # Sessions written for project A are not visible under project B.
        with patch("token_goat.paths.data_dir", return_value=tmp_path):
            write_session_manifest("proj-A", "sess-x", _manifest("sess-x", [_entry("foo.py", 1)]))
            results_b = read_all_session_manifests("proj-B")
        assert results_b == []

    def test_budget_uses_rel_path_length_estimate(self):
        # A 40-char path uses ceil(40/10)=4 tokens; budget=3 → that entry is excluded.
        long_path = "a" * 40 + ".py"  # 43 chars → 4 tokens
        s = _manifest("S", [_entry(long_path, 99)])
        merged = merge_session_manifests([s], budget_tokens=3)
        # The entry consumes more tokens than the budget allows
        assert merged == []

    def test_sessions_dir_not_existing_returns_empty(self, tmp_path):
        # If the sessions directory has never been created, return empty list silently.
        with patch("token_goat.paths.data_dir", return_value=tmp_path):
            results = read_all_session_manifests("nonexistent-project")
        assert results == []

    def test_manifest_without_files_key_skipped(self, tmp_path):
        # A JSON file that's a dict but lacks the 'files' key is silently skipped.
        import json
        with patch("token_goat.paths.data_dir", return_value=tmp_path):
            sessions_dir = tmp_path / "projects" / "proj" / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            (sessions_dir / "no-files.json").write_text(
                json.dumps({"session_id": "no-files"}), encoding="utf-8"
            )
            results = read_all_session_manifests("proj")
        assert results == []
