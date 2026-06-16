"""Integration tests: pre-Bash dedup hint via the pre_read hook.

These tests use ``which``/``where`` commands as sentinels because those
binaries are listed in ``_BASH_FAST_PATH_EXCLUDE`` in ``hooks_read.py``,
which exempts them from the early-return fast-path so they always reach the
dedup handler.  Commands like ``du``, ``df``, ``echo`` are no longer viable
sentinels: the fast-path now returns CONTINUE for them immediately, before
the dedup handler fires.
"""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import bash_cache, hooks_read, session


def _seed_history(session_id: str, command: str, *, output_bytes: int = 10_000) -> None:
    """Helper: emulate a prior post_bash invocation to populate history."""
    big_out = "X" * output_bytes
    payload = {
        "session_id": session_id,
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "tool_response": {"stdout": big_out, "stderr": "", "exit_code": 0},
    }
    hooks_read.post_bash(payload)


class TestBashDedupHintFiresOnRepeat:
    def test_repeat_command_triggers_hint(self, tmp_data_dir):
        _seed_history("dedup-1", "which node")
        # Pre-read fires for the same command in the same session.
        payload = {
            "session_id": "dedup-1",
            "tool_name": "Bash",
            "tool_input": {"command": "which node"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "token-goat bash-output" in ctx
        assert "which node" in ctx

    def test_distinct_command_no_hint(self, tmp_data_dir):
        _seed_history("dedup-2", "du -sh /srv")
        payload = {
            "session_id": "dedup-2",
            "tool_name": "Bash",
            "tool_input": {"command": "du -sh /opt"},  # different command
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_tiny_prior_output_no_hint(self, tmp_data_dir):
        """A small previous output is not worth deduplicating."""
        _seed_history("dedup-3", "echo hi", output_bytes=20)
        payload = {
            "session_id": "dedup-3",
            "tool_name": "Bash",
            "tool_input": {"command": "echo hi"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        # No history entry was even recorded (output below cache threshold),
        # so no hint can fire.
        assert "hookSpecificOutput" not in result

    def test_run_count_increments_on_repeat(self, tmp_data_dir):
        """run_count advances each time the same command is recorded."""
        from token_goat import bash_cache

        cmd = "du -sh /data"
        _seed_history("rc-1", cmd)
        sha = bash_cache.command_hash(cmd)
        entry = session.lookup_bash_entry("rc-1", sha)
        assert entry is not None
        assert entry.run_count == 1

        # Record the same command again (second run).
        _seed_history("rc-1", cmd)
        entry2 = session.lookup_bash_entry("rc-1", sha)
        assert entry2 is not None
        assert entry2.run_count == 2

        # A third run.
        _seed_history("rc-1", cmd)
        entry3 = session.lookup_bash_entry("rc-1", sha)
        assert entry3 is not None
        assert entry3.run_count == 3

    def test_hint_text_run_count_2(self, tmp_data_dir):
        """At run_count==2 the hint says '2x' indicating repeated run."""
        cmd = "which python"
        _seed_history("rc-2a", cmd)
        _seed_history("rc-2a", cmd)  # second run → run_count=2
        payload = {
            "session_id": "rc-2a",
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "×2x" in ctx  # terse form of "ran 2x" (ran→×)
        assert "WARNING" not in ctx
        assert "token-goat bash-output" in ctx

    def test_hint_text_run_count_3(self, tmp_data_dir):
        """At run_count>=3 the hint flags a loop with a leading alert glyph."""
        cmd = "which git"
        _seed_history("rc-3a", cmd)
        _seed_history("rc-3a", cmd)
        _seed_history("rc-3a", cmd)  # third run → run_count=3
        payload = {
            "session_id": "rc-3a",
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        # The verbose "WARNING:" prefix was tightened to a "⚠" glyph for token
        # savings; assert the actionable concept (loop detection) which still
        # appears in the hint body.
        assert "loop" in ctx
        assert "3x" in ctx
        assert "token-goat bash-output" in ctx

    def test_hint_text_run_count_5(self, tmp_data_dir):
        """run_count>3 still uses the loop-detection path with the correct count."""
        cmd = "which go"
        for _ in range(5):
            _seed_history("rc-5a", cmd)
        payload = {
            "session_id": "rc-5a",
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        # See test_hint_text_run_count_3 for why "WARNING" → loop-concept check.
        assert "loop" in ctx
        assert "5x" in ctx

    def test_single_run_hint_unchanged(self, tmp_data_dir):
        """First-time dedup hint (run_count==1) carries an age suffix and a 'cached' marker."""
        import re as _re
        cmd = "which cargo"
        _seed_history("rc-single", cmd)
        payload = {
            "session_id": "rc-single",
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        # Assert the age-suffix concept (Ns inside parens after the command),
        # not the exact "(age ~Ns)" wording — that prefix was trimmed for
        # token savings. Accepts either '(Ns,' (light format) or '(Ns):' (full).
        assert _re.search(r"\(\d+s[,):]", ctx), (
            f"expected '(Ns)' or '(Ns,' age suffix in hint: {ctx!r}"
        )
        assert "⌘" in ctx  # terse form of "cached"
        assert "WARNING" not in ctx
        assert "2x" not in ctx

    def test_old_history_entry_suppressed(self, tmp_data_dir, monkeypatch):
        """A prior run older than the stale-age threshold is suppressed."""
        from token_goat import hints

        # Temporarily add ``df`` to the fast-path exclude set so this
        # non-compressible command bypasses the early return and reaches the
        # dedup handler where the stale-age check lives.  ``which``/``where``
        # can't be used here because they trigger the env-probe handler (which
        # serves cached output regardless of staleness) before dedup fires.
        monkeypatch.setattr(
            hooks_read,
            "_BASH_FAST_PATH_EXCLUDE",
            frozenset({"which", "where", "df"}),
        )
        _seed_history("dedup-4", "df -h")
        sha = bash_cache.command_hash("df -h")
        entry = session.lookup_bash_entry("dedup-4", sha)
        assert entry is not None

        # Push the timestamp far into the past so the staleness check fires.
        cache = session.load("dedup-4")
        cache.bash_history[sha].ts -= hints.STALE_READ_AGE_SECONDS + 100
        session.save(cache)

        payload = {
            "session_id": "dedup-4",
            "tool_name": "Bash",
            "tool_input": {"command": "df -h"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        # Stale entry → no dedup hint, even though command matches.
        assert "hookSpecificOutput" not in result
