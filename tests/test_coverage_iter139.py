"""Tests for iter139 coverage: _edit_succeeded, _parse_local_imports, post_read memory strip."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from token_goat.hooks_edit import _edit_succeeded, _parse_local_imports
from token_goat.hooks_read import post_read

# ---------------------------------------------------------------------------
# Group 1: _edit_succeeded
# ---------------------------------------------------------------------------


class TestEditSucceeded:
    def test_no_tool_response_key_returns_true(self, tmp_path: Path) -> None:
        # Payload with no tool_response key — fail-soft, treat as success
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload: dict[str, Any] = {"tool_input": {"file_path": fp}}
        assert _edit_succeeded(payload, fp) is True

    def test_dict_is_error_true_returns_false(self, tmp_path: Path) -> None:
        # Explicit MCP wire-format error
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": {"is_error": True, "content": "write failed"}}
        assert _edit_succeeded(payload, fp) is False

    def test_dict_is_error_false_does_not_block(self, tmp_path: Path) -> None:
        # is_error present but False — should not block
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": {"is_error": False}}
        assert _edit_succeeded(payload, fp) is True

    def test_string_response_error_prefix_returns_false(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": "Error: file not found"}
        assert _edit_succeeded(payload, fp) is False

    def test_string_response_failed_prefix_returns_false(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": "Failed: permission denied"}
        assert _edit_succeeded(payload, fp) is False

    def test_string_response_permission_denied_prefix_returns_false(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": "Permission denied: /etc/shadow"}
        assert _edit_succeeded(payload, fp) is False

    def test_string_response_with_leading_whitespace_still_detected(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": "   Error: something bad"}
        assert _edit_succeeded(payload, fp) is False

    def test_string_response_ok_text_passes(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": "The file was updated successfully."}
        assert _edit_succeeded(payload, fp) is True

    def test_file_not_existing_is_conservative_true(self, tmp_path: Path) -> None:
        # Non-existent file — conservative: allow the record
        fp = str(tmp_path / "ghost.py")
        payload: dict[str, Any] = {"tool_response": None}
        assert _edit_succeeded(payload, fp) is True

    def test_fresh_file_returns_true(self, tmp_path: Path) -> None:
        # File written just now — mtime age is near zero, well within threshold
        fp = str(tmp_path / "fresh.py")
        Path(fp).write_text("content", encoding="utf-8")
        payload: dict[str, Any] = {}
        assert _edit_succeeded(payload, fp) is True

    def test_stale_file_returns_false(self, tmp_path: Path) -> None:
        # Backdate the mtime far into the past so age > _EDIT_FRESHNESS_SECS
        fp = str(tmp_path / "old.py")
        Path(fp).write_text("content", encoding="utf-8")
        import os
        old = time.time() - 3600  # 1 hour ago
        os.utime(fp, (old, old))
        payload: dict[str, Any] = {}
        assert _edit_succeeded(payload, fp) is False

    def test_oserror_on_stat_is_fail_soft_true(self, tmp_path: Path) -> None:
        # If stat raises OSError the function must return True (fail-soft)
        fp = str(tmp_path / "inaccessible.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload: dict[str, Any] = {}
        with patch("pathlib.Path.stat", side_effect=OSError("no access")):
            result = _edit_succeeded(payload, fp)
        assert result is True

    def test_non_dict_payload_treated_as_no_tool_response(self, tmp_path: Path) -> None:
        # Payload is not a dict — tool_resp extraction returns None, continues to mtime check
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        # Pass a non-dict (e.g. None); function guards with isinstance
        result = _edit_succeeded(None, fp)  # type: ignore[arg-type]
        assert result is True


# ---------------------------------------------------------------------------
# Group 2: _parse_local_imports
# ---------------------------------------------------------------------------


class TestParseLocalImports:
    def test_empty_string_returns_empty(self, tmp_path: Path) -> None:
        result = _parse_local_imports("", str(tmp_path / "mod.py"), str(tmp_path))
        assert result == []

    def test_no_import_lines_returns_empty(self, tmp_path: Path) -> None:
        source = "# just a comment\nclass Foo:\n    pass\n"
        result = _parse_local_imports(source, str(tmp_path / "mod.py"), str(tmp_path))
        assert result == []

    def test_stdlib_import_not_resolved(self, tmp_path: Path) -> None:
        # os and pathlib are stdlib — no local file will be found
        source = "import os\nfrom pathlib import Path\n"
        result = _parse_local_imports(source, str(tmp_path / "mod.py"), str(tmp_path))
        assert result == []

    def test_local_file_that_exists_is_returned(self, tmp_path: Path) -> None:
        # Create a sibling file that will be found as a local import
        sibling = tmp_path / "utils.py"
        sibling.write_text("# utils", encoding="utf-8")
        src_file = str(tmp_path / "main.py")
        source = "from .utils import helper\n"
        result = _parse_local_imports(source, src_file, str(tmp_path))
        assert str(sibling) in result

    def test_local_file_that_does_not_exist_not_returned(self, tmp_path: Path) -> None:
        # ghost.py does not exist
        src_file = str(tmp_path / "main.py")
        source = "from .ghost import something\n"
        result = _parse_local_imports(source, src_file, str(tmp_path))
        assert result == []

    def test_cap_at_predictive_snapshot_cap(self, tmp_path: Path) -> None:
        # Create 5 sibling files; result must be capped at _PREDICTIVE_SNAPSHOT_CAP (3)
        for name in ("a", "b", "c", "d", "e"):
            (tmp_path / f"{name}.py").write_text("# x", encoding="utf-8")
        src_file = str(tmp_path / "main.py")
        lines = "\n".join(f"from .{n} import X" for n in ("a", "b", "c", "d", "e"))
        result = _parse_local_imports(lines, src_file, str(tmp_path))
        from token_goat.hooks_edit import _PREDICTIVE_SNAPSHOT_CAP
        assert len(result) == _PREDICTIVE_SNAPSHOT_CAP

    def test_cwd_none_with_relative_file_path_does_not_raise(self) -> None:
        # cwd=None with a non-absolute file_path — must not crash
        source = "import os\n"
        result = _parse_local_imports(source, "relative/mod.py", None)
        assert result == []

    def test_non_import_lines_between_imports_are_skipped(self, tmp_path: Path) -> None:
        # Decorator and class definition between two import groups — both imports scanned
        sibling = tmp_path / "helpers.py"
        sibling.write_text("# helpers", encoding="utf-8")
        src_file = str(tmp_path / "main.py")
        source = "import os\n@decorator\nclass Foo:\n    pass\nfrom .helpers import fn\n"
        result = _parse_local_imports(source, src_file, str(tmp_path))
        assert str(sibling) in result

    def test_deduplicates_same_path(self, tmp_path: Path) -> None:
        # Importing the same module twice must not duplicate the resolved path
        sibling = tmp_path / "utils.py"
        sibling.write_text("# u", encoding="utf-8")
        src_file = str(tmp_path / "main.py")
        source = "from .utils import A\nfrom .utils import B\n"
        result = _parse_local_imports(source, src_file, str(tmp_path))
        assert result.count(str(sibling)) == 1


# ---------------------------------------------------------------------------
# Group 3: post_read memory-file frontmatter stripping
# ---------------------------------------------------------------------------

_SID = "test-session-iter139"
_CWD = "/projects/token-goat"
_MEM_PATH = "/home/user/.claude/projects/myproj/memory/feedback_wsl.md"
_INDEX_PATH = "/home/user/.claude/projects/myproj/memory/MEMORY.md"
_PLAIN_PATH = "/home/user/projects/src/module.py"

_FM_CONTENT = "---\nname: test\ndescription: demo\n---\n\nBody line one.\nBody line two.\n"
_BODY_ONLY = "Body line one.\nBody line two.\n"


def _make_payload(file_path: str, content: str) -> dict[str, Any]:
    return {
        "session_id": _SID,
        "cwd": _CWD,
        "tool_name": "Read",
        "tool_input": {"file_path": file_path},
        "tool_response": content,
    }


def _fresh_cache():
    from token_goat.session import SessionCache
    now = time.time()
    return SessionCache(session_id=_SID, started_ts=now, last_activity_ts=now)


def _call_post_read(payload: dict[str, Any]) -> dict[str, Any]:
    cache = _fresh_cache()
    mock_session = MagicMock()
    mock_session.mark_file_read = MagicMock()
    mock_session.save = MagicMock()
    with (
        patch("token_goat.hooks_read.get_hook_context", return_value=(_SID, _CWD)),
        patch("token_goat.hooks_read._get_session", return_value=mock_session),
        patch("token_goat.hooks_read.load_session_safe", return_value=cache),
        patch("token_goat.hooks_read._check_ignored_hint"),
        patch("token_goat.hooks_read._read_is_windowed", return_value=True),
        patch("token_goat.hooks_read._try_snapshot"),
    ):
        return post_read(payload)  # type: ignore[arg-type]


class TestPostReadMemoryStrip:
    def test_memory_file_with_frontmatter_has_system_message(self) -> None:
        result = _call_post_read(_make_payload(_MEM_PATH, _FM_CONTENT))
        assert result.get("continue") is True
        sys_msg = result.get("systemMessage", "")
        assert "[token-goat] memory file:" in sys_msg
        assert "frontmatter lines stripped" in sys_msg

    def test_memory_file_system_message_contains_body(self) -> None:
        result = _call_post_read(_make_payload(_MEM_PATH, _FM_CONTENT))
        sys_msg = result.get("systemMessage", "")
        assert "Body line one." in sys_msg

    def test_memory_file_system_message_excludes_frontmatter_keys(self) -> None:
        result = _call_post_read(_make_payload(_MEM_PATH, _FM_CONTENT))
        sys_msg = result.get("systemMessage", "")
        assert "name: test" not in sys_msg
        assert "description: demo" not in sys_msg

    def test_memory_file_no_frontmatter_no_strip_annotation(self) -> None:
        # Content without frontmatter — stripping should not fire
        content = "Just plain body text.\n"
        result = _call_post_read(_make_payload(_MEM_PATH, content))
        assert result.get("continue") is True
        sys_msg = result.get("systemMessage", "")
        assert "frontmatter lines stripped" not in sys_msg

    def test_memory_index_is_not_stripped(self) -> None:
        # MEMORY.md is the index file and must never be modified by this path
        result = _call_post_read(_make_payload(_INDEX_PATH, _FM_CONTENT))
        assert result.get("continue") is True
        sys_msg = result.get("systemMessage", "")
        assert "frontmatter lines stripped" not in sys_msg

    def test_non_memory_file_returns_continue_no_system_message_injection(self) -> None:
        # Regular source file — hook should not inject a frontmatter systemMessage
        result = _call_post_read(_make_payload(_PLAIN_PATH, _FM_CONTENT))
        assert result.get("continue") is True
        sys_msg = result.get("systemMessage", "")
        assert "frontmatter lines stripped" not in sys_msg

    def test_no_session_id_returns_continue(self) -> None:
        payload = _make_payload(_MEM_PATH, _FM_CONTENT)
        with patch("token_goat.hooks_read.get_hook_context", return_value=(None, _CWD)):
            result = post_read(payload)  # type: ignore[arg-type]
        assert result.get("continue") is True

    def test_no_session_cache_returns_continue(self) -> None:
        payload = _make_payload(_MEM_PATH, _FM_CONTENT)
        mock_session = MagicMock()
        with (
            patch("token_goat.hooks_read.get_hook_context", return_value=(_SID, _CWD)),
            patch("token_goat.hooks_read._get_session", return_value=mock_session),
            patch("token_goat.hooks_read.load_session_safe", return_value=None),
        ):
            result = post_read(payload)  # type: ignore[arg-type]
        assert result.get("continue") is True
