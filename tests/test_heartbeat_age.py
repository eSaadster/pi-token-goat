"""Tests for worker.heartbeat_age and is_heartbeat_stale_for_nudge — direct coverage."""
from __future__ import annotations

import time

import pytest

import token_goat.worker as worker


class TestHeartbeatAge:
    """heartbeat_age() returns elapsed seconds or None for missing/unreadable file."""

    def test_missing_file_returns_none(self, tmp_path):
        """heartbeat_age returns None when the heartbeat file does not exist."""
        hb = tmp_path / "heartbeat.txt"
        assert not hb.exists()
        result = worker.heartbeat_age(hb)
        assert result is None

    def test_fresh_file_returns_small_age(self, tmp_path):
        """A just-written heartbeat file has an age near zero seconds."""
        hb = tmp_path / "heartbeat.txt"
        hb.write_text("alive", encoding="utf-8")
        result = worker.heartbeat_age(hb)
        assert result is not None
        assert 0.0 <= result < 5.0, f"expected fresh age < 5s, got {result}"

    def test_old_file_returns_large_age(self, tmp_path):
        """A heartbeat file with an old mtime returns an age matching the delay."""
        hb = tmp_path / "heartbeat.txt"
        hb.write_text("alive", encoding="utf-8")
        # Back-date the mtime by 120 seconds to simulate a stale heartbeat.
        old_mtime = time.time() - 120.0
        import os
        os.utime(hb, (old_mtime, old_mtime))
        result = worker.heartbeat_age(hb)
        assert result is not None
        assert result >= 100.0, f"expected age >= 100s for backdated file, got {result}"

    def test_default_path_used_when_none(self, tmp_data_dir):
        """heartbeat_age() with no argument resolves to the default heartbeat path."""
        # Create the canonical heartbeat file — should return a small age.
        import token_goat.paths as paths_mod
        hb = paths_mod.worker_heartbeat_path()
        hb.parent.mkdir(parents=True, exist_ok=True)
        hb.write_text("alive", encoding="utf-8")
        result = worker.heartbeat_age()
        assert result is not None
        assert 0.0 <= result < 10.0


class TestIsHeartbeatStaleForNudge:
    """is_heartbeat_stale_for_nudge() — missing, fresh, and stale file branches."""

    def test_missing_file_is_stale(self, tmp_path):
        """A missing heartbeat file is considered stale (worker never started / crashed)."""
        hb = tmp_path / "heartbeat.txt"
        assert worker.is_heartbeat_stale_for_nudge(hb) is True

    def test_fresh_file_is_not_stale(self, tmp_path):
        """A just-written heartbeat file is not stale."""
        hb = tmp_path / "heartbeat.txt"
        hb.write_text("alive", encoding="utf-8")
        assert worker.is_heartbeat_stale_for_nudge(hb) is False

    def test_old_file_beyond_threshold_is_stale(self, tmp_path):
        """A heartbeat file older than heartbeat_stale_threshold() is stale."""
        hb = tmp_path / "heartbeat.txt"
        hb.write_text("alive", encoding="utf-8")
        threshold = worker.heartbeat_stale_threshold()
        old_mtime = time.time() - (threshold + 60.0)
        import os
        os.utime(hb, (old_mtime, old_mtime))
        assert worker.is_heartbeat_stale_for_nudge(hb) is True

    def test_file_just_within_threshold_is_not_stale(self, tmp_path):
        """A heartbeat file slightly younger than the threshold is NOT stale."""
        hb = tmp_path / "heartbeat.txt"
        hb.write_text("alive", encoding="utf-8")
        threshold = worker.heartbeat_stale_threshold()
        # Set mtime to just inside the threshold — threshold/2 is safely fresh.
        recent_mtime = time.time() - (threshold / 2.0)
        import os
        os.utime(hb, (recent_mtime, recent_mtime))
        assert worker.is_heartbeat_stale_for_nudge(hb) is False

    def test_threshold_positive(self):
        """heartbeat_stale_threshold() must return a positive number of seconds."""
        t = worker.heartbeat_stale_threshold()
        assert t > 0.0

    @pytest.mark.parametrize("age_factor", [1.01, 2.0, 10.0])
    def test_ages_beyond_threshold_are_stale(self, tmp_path, age_factor):
        """Files older than threshold * factor are stale for all tested multiples."""
        hb = tmp_path / f"heartbeat_{age_factor}.txt"
        hb.write_text("alive", encoding="utf-8")
        threshold = worker.heartbeat_stale_threshold()
        old_mtime = time.time() - (threshold * age_factor)
        import os
        os.utime(hb, (old_mtime, old_mtime))
        assert worker.is_heartbeat_stale_for_nudge(hb) is True
