"""Iteration-138 coverage additions.

Focuses on untested or under-tested paths identified by audit:

1. ``is_real_int`` — TypeGuard predicate with zero direct tests.
2. ``emit_if_new_hint`` — edge cases: None cache, TypeError on
   ``has_hint_fingerprint``, ``mark_hint_seen`` AttributeError after a
   successful fingerprint check, already-seen fingerprint suppression.
3. ``BaselineRow.pct_of`` — zero-window guard (division-by-zero protection).
4. ``BaselineReport.pct`` — zero-window guard.
5. ``update_session`` — save-failure path (mutation succeeds, ``session.save``
   raises; must return False without propagating).
6. ``sanitize_surrogates`` — direct unit tests for the Windows surrogate-escape
   helper (previously only exercised transitively through bash-cache paths).
"""
from __future__ import annotations

import time

# ---------------------------------------------------------------------------
# 1.  is_real_int
# ---------------------------------------------------------------------------


class TestIsRealInt:
    """is_real_int rejects booleans even though bool subclasses int."""

    def _fn(self):
        from token_goat.hooks_common import is_real_int
        return is_real_int

    def test_plain_int_returns_true(self):
        assert self._fn()(42) is True

    def test_zero_int_returns_true(self):
        assert self._fn()(0) is True

    def test_negative_int_returns_true(self):
        assert self._fn()(-1) is True

    def test_true_returns_false(self):
        # bool subclasses int; is_real_int must NOT accept it.
        assert self._fn()(True) is False

    def test_false_returns_false(self):
        assert self._fn()(False) is False

    def test_float_returns_false(self):
        assert self._fn()(3.14) is False

    def test_string_returns_false(self):
        assert self._fn()("42") is False

    def test_none_returns_false(self):
        assert self._fn()(None) is False

    def test_list_returns_false(self):
        assert self._fn()([1, 2, 3]) is False


# ---------------------------------------------------------------------------
# 2.  emit_if_new_hint edge cases
# ---------------------------------------------------------------------------


class _MinimalCache:
    """Minimal session-cache stub with controllable dedup behaviour."""

    def __init__(self, *, already_seen: bool = False):
        self._seen: set[str] = set()
        self._already_seen = already_seen
        self.marked: list[str] = []
        self.recorded: list[str] = []

    def has_hint_fingerprint(self, fp: str) -> bool:
        return self._already_seen or fp in self._seen

    def mark_hint_seen(self, fp: str) -> None:
        self._seen.add(fp)
        self.marked.append(fp)

    def record_hint_emitted(self, stat_key: str) -> None:
        self.recorded.append(stat_key)


class _BrokenHasFpCache:
    """Cache whose has_hint_fingerprint raises TypeError."""

    def has_hint_fingerprint(self, fp: str) -> bool:
        raise TypeError("unexpected type")


class _BrokenMarkCache:
    """Cache where has_hint_fingerprint works but mark_hint_seen raises AttributeError."""

    def has_hint_fingerprint(self, fp: str) -> bool:
        return False

    def mark_hint_seen(self, fp: str) -> None:
        raise AttributeError("no method")

    def record_hint_emitted(self, stat_key: str) -> None:
        raise AttributeError("no method")


class TestEmitIfNewHint:
    def _fn(self):
        from token_goat.hooks_common import emit_if_new_hint
        return emit_if_new_hint

    def test_none_cache_returns_false(self):
        parts: list[str] = []
        result = self._fn()(None, "fp1", "hint text", "stat", parts)
        assert result is False
        assert parts == []

    def test_new_fingerprint_appends_hint_and_returns_true(self):
        cache = _MinimalCache(already_seen=False)
        parts: list[str] = []
        result = self._fn()(cache, "fp1", "my hint", "stat_kind", parts)
        assert result is True
        assert parts == ["my hint"]
        assert "fp1" in cache.marked
        assert "stat_kind" in cache.recorded

    def test_already_seen_fingerprint_suppresses_hint(self):
        cache = _MinimalCache(already_seen=True)
        parts: list[str] = []
        result = self._fn()(cache, "fp1", "my hint", "stat_kind", parts)
        assert result is False
        assert parts == []

    def test_broken_has_fp_raises_type_error_returns_false(self):
        """TypeError from has_hint_fingerprint must be caught; hint suppressed."""
        cache = _BrokenHasFpCache()
        parts: list[str] = []
        result = self._fn()(cache, "fp1", "my hint", "stat_kind", parts)
        assert result is False
        assert parts == []

    def test_broken_mark_hint_seen_does_not_raise(self):
        """AttributeError from mark_hint_seen must not propagate; hint is still emitted."""
        cache = _BrokenMarkCache()
        parts: list[str] = []
        result = self._fn()(cache, "fp1", "my hint", "stat_kind", parts)
        # The hint IS appended (fingerprint check passed); the broken mark just silently fails.
        assert result is True
        assert parts == ["my hint"]

    def test_second_call_with_same_fingerprint_suppresses(self):
        """Fingerprint marked on first call must suppress on second call."""
        cache = _MinimalCache()
        parts: list[str] = []
        self._fn()(cache, "fp-unique", "hint A", "stat", parts)
        parts2: list[str] = []
        result2 = self._fn()(cache, "fp-unique", "hint A", "stat", parts2)
        assert result2 is False
        assert parts2 == []

    def test_different_fingerprints_both_emitted(self):
        """Two different fingerprints must both pass through."""
        cache = _MinimalCache()
        parts: list[str] = []
        r1 = self._fn()(cache, "fp-a", "hint A", "stat", parts)
        r2 = self._fn()(cache, "fp-b", "hint B", "stat", parts)
        assert r1 is True
        assert r2 is True
        assert parts == ["hint A", "hint B"]


# ---------------------------------------------------------------------------
# 3.  BaselineRow.pct_of — zero-window guard
# ---------------------------------------------------------------------------


class TestBaselineRowPctOf:
    def _make_row(self, tokens: int = 500):
        from token_goat.baseline import BaselineRow
        return BaselineRow(
            source="test-row",
            n_bytes=tokens * 4,
            tokens=tokens,
            owner="you",
            fix="none",
            kind="fixed",
        )

    def test_normal_window_returns_correct_fraction(self):
        row = self._make_row(tokens=100)
        pct = row.pct_of(1000)
        assert abs(pct - 0.1) < 1e-9

    def test_zero_window_returns_zero_not_error(self):
        """Division by zero must be guarded; must return 0.0, not raise."""
        row = self._make_row(tokens=500)
        assert row.pct_of(0) == 0.0

    def test_negative_window_returns_zero(self):
        """Negative window is treated as non-positive; must return 0.0."""
        row = self._make_row(tokens=100)
        assert row.pct_of(-1) == 0.0

    def test_as_dict_with_zero_window_does_not_raise(self):
        """as_dict calls pct_of internally; must not raise on zero window."""
        row = self._make_row(tokens=200)
        d = row.as_dict(0)
        assert d["pct_of_window"] == 0.0

    def test_tokens_equal_window_returns_one(self):
        row = self._make_row(tokens=200)
        assert abs(row.pct_of(200) - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# 4.  BaselineReport.pct — zero-window guard
# ---------------------------------------------------------------------------


class TestBaselineReportPct:
    def _make_report(self, window_tokens: int, row_tokens: int = 100):
        from token_goat.baseline import BaselineReport, BaselineRow
        rows = [
            BaselineRow(
                source="r",
                n_bytes=row_tokens * 4,
                tokens=row_tokens,
                owner="you",
                fix="none",
                kind="fixed",
            )
        ]
        return BaselineReport(
            rows=rows,
            window_tokens=window_tokens,
            session_id="test-session",
            tool_results_available=False,
        )

    def test_zero_window_returns_zero(self):
        report = self._make_report(window_tokens=0, row_tokens=200)
        assert report.pct(200) == 0.0

    def test_negative_window_returns_zero(self):
        report = self._make_report(window_tokens=-100, row_tokens=50)
        assert report.pct(50) == 0.0

    def test_normal_window_correct_fraction(self):
        report = self._make_report(window_tokens=1000, row_tokens=250)
        assert abs(report.pct(250) - 0.25) < 1e-9

    def test_total_tokens_property(self):
        report = self._make_report(window_tokens=2000, row_tokens=300)
        assert report.total_tokens == 300

    def test_fixed_tokens_property(self):
        report = self._make_report(window_tokens=2000, row_tokens=400)
        assert report.fixed_tokens == 400

    def test_as_dict_with_zero_window_does_not_raise(self):
        """as_dict calls pct() internally; must not raise on zero window."""
        report = self._make_report(window_tokens=0, row_tokens=100)
        d = report.as_dict()
        assert d["total_pct_of_window"] == 0.0
        assert d["fixed_pct_of_window"] == 0.0


# ---------------------------------------------------------------------------
# 5.  update_session — save-failure path
# ---------------------------------------------------------------------------


class TestUpdateSessionSaveFailure:
    """update_session must return False when session.save() raises, not propagate."""

    def test_save_failure_returns_false(self, tmp_data_dir):
        from token_goat import session
        from token_goat.hooks_common import update_session

        sid = "iter138-save-fail"
        now = time.time()
        initial = session.SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        session.save(initial)

        called = []

        def mutate(cache: session.SessionCache) -> None:
            called.append(True)
            # Mutate is fine; save will fail below.

        import token_goat.session as session_mod

        def bad_save(c):
            raise OSError("disk full")

        import unittest.mock as mock
        with mock.patch.object(session_mod, "save", bad_save):
            result = update_session(sid, mutate)

        assert result is False
        assert called == [True], "mutation fn should have been called exactly once before save failed"

    def test_save_success_returns_true(self, tmp_data_dir):
        from token_goat import session
        from token_goat.hooks_common import update_session

        sid = "iter138-save-ok"
        now = time.time()
        initial = session.SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        session.save(initial)

        result = update_session(sid, lambda c: c.edited_files.update({"foo.py": 1}))
        assert result is True

        reloaded = session.load(sid)
        assert reloaded is not None
        assert "foo.py" in reloaded.edited_files


# ---------------------------------------------------------------------------
# 6.  sanitize_surrogates — direct unit tests
# ---------------------------------------------------------------------------


class TestSanitizeSurrogates:
    """sanitize_surrogates replaces lone surrogates, leaves valid text intact."""

    def _fn(self):
        from token_goat.util import sanitize_surrogates
        return sanitize_surrogates

    def test_plain_ascii_unchanged(self):
        assert self._fn()("hello world") == "hello world"

    def test_empty_string_unchanged(self):
        assert self._fn()("") == ""

    def test_unicode_unchanged(self):
        assert self._fn()("café 日本語") == "café 日本語"

    def test_emoji_unchanged(self):
        assert self._fn()("🐐 token-goat") == "🐐 token-goat"

    def test_lone_surrogate_replaced(self):
        # Construct a string with a lone surrogate (Windows surrogate-escape).
        lone_surrogate = "\udcff"  # noqa: RUF001 – intentional surrogate
        result = self._fn()(lone_surrogate)
        # Must not contain the lone surrogate.
        assert "\udcff" not in result
        # Must be a valid (non-empty) string — the surrogate was replaced.
        assert len(result) >= 1

    def test_idempotent_on_clean_string(self):
        s = "no surrogates here"
        assert self._fn()(self._fn()(s)) == s

    def test_return_type_is_str(self):
        result = self._fn()("test")
        assert result == "test"  # clean string passes through unchanged
