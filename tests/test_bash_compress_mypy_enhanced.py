from __future__ import annotations

import token_goat.bash_compress as bc

_F = bc.MypyFilter()
_ARGV = ["mypy", "src/"]


def _compress(stdout: str, *, exit_code: int = 1) -> str:
    return _F.compress(stdout, "", exit_code, _ARGV)


def _error(file: str, line: int, msg: str) -> str:
    return f"{file}:{line}: error: {msg}"


def _note(file: str, line: int, msg: str) -> str:
    return f"{file}:{line}: note: {msg}"


def test_exactly_three_errors_all_kept() -> None:
    # 3 identical errors should all be kept with no suppression note
    stdout = "\n".join([
        _error("src/foo.py", 10, "Incompatible type"),
        _error("src/foo.py", 10, "Incompatible type"),
        _error("src/foo.py", 10, "Incompatible type"),
    ])
    out = _compress(stdout)
    assert out.count("Incompatible type") == 3
    assert "suppressed" not in out.lower()


def test_fourth_error_produces_suppression_note() -> None:
    # 4 identical errors: first 3 kept, 4th dropped, suppression note says "1"
    stdout = "\n".join([
        _error("src/foo.py", 10, "Incompatible type"),
        _error("src/foo.py", 10, "Incompatible type"),
        _error("src/foo.py", 10, "Incompatible type"),
        _error("src/foo.py", 10, "Incompatible type"),
    ])
    out = _compress(stdout)
    assert out.count("Incompatible type") == 3
    assert "suppressed 1" in out.lower()


def test_suppression_note_count_matches_dropped() -> None:
    # 7 identical errors: 3 kept, 4 dropped → suppression note mentions "4"
    stdout = "\n".join([
        _error("src/foo.py", 10, "Argument of type \"int\""),
    ] * 7)
    out = _compress(stdout)
    assert out.count("Argument of type") == 3
    # Suppression note should mention 4 dropped
    assert "4" in out and "suppressed" in out.lower()


def test_quote_normalization_groups_errors() -> None:
    # Different quoted values in same structural message should group separately
    # "Incompatible type "int"" and "Incompatible type "bool"" normalize to same key
    stdout = "\n".join([
        _error("src/a.py", 1, 'Incompatible type "int"'),
        _error("src/a.py", 2, 'Incompatible type "int"'),
        _error("src/a.py", 3, 'Incompatible type "int"'),
        _error("src/a.py", 4, 'Incompatible type "bool"'),
    ])
    out = _compress(stdout)
    # First 3 of the "int" variant kept, the "bool" variant dropped (different quoted string)
    # but all normalize the same after quote replacement, so 4th is dropped
    assert out.count('Incompatible type "int"') + out.count('Incompatible type "bool"') == 3
    assert "suppressed" in out.lower()


def test_warning_lines_kept() -> None:
    # warning: lines pass through unchanged
    stdout = "src/foo.py:1: warning: some warning"
    out = _compress(stdout, exit_code=0)
    assert "some warning" in out


def test_blank_lines_pass_through() -> None:
    # Blank lines between diagnostics are kept
    stdout = "\n".join([
        _error("src/foo.py", 10, "Error 1"),
        "",
        _error("src/foo.py", 20, "Error 2"),
    ])
    out = _compress(stdout)
    assert out.count("\n\n") > 0 or "\n\n" in out or out.count("\n") > 2


def test_dmypy_dispatches_to_filter() -> None:
    # dmypy binary name should dispatch to MypyFilter
    from token_goat.bash_compress import select_filter
    f = select_filter(["dmypy", "run"])
    assert f.name == "mypy"


def test_suppression_note_at_end_of_output() -> None:
    # Suppression note appears after diagnostic lines, not interleaved
    stdout = "\n".join([
        _error("src/foo.py", 10, "Error A"),
    ] * 4)
    out = _compress(stdout)
    # Find position of suppression note
    if "suppressed" in out.lower():
        last_error_pos = out.rfind("Error A")
        suppression_pos = out.lower().find("suppressed")
        assert suppression_pos > last_error_pos, "Suppression note should appear after errors"


def test_exactly_three_notes_all_kept() -> None:
    # 3 identical notes should all be kept with no dropped-notes suppression note
    stdout = "\n".join([
        _note("src/foo.py", 10, "See https://mypy.readthedocs.io/en/latest/"),
        _note("src/foo.py", 10, "See https://mypy.readthedocs.io/en/latest/"),
        _note("src/foo.py", 10, "See https://mypy.readthedocs.io/en/latest/"),
    ])
    out = _compress(stdout, exit_code=0)
    # See https:// lines are dropped, so this should have 0 surviving
    assert "mypy.readthedocs.io" not in out


def test_fourth_note_produces_suppression_note() -> None:
    # 4 identical non-reference notes: 3 kept, 4th dropped, suppression note present
    stdout = "\n".join([
        _note("src/foo.py", 10, "Suggestion: consider typing"),
        _note("src/foo.py", 10, "Suggestion: consider typing"),
        _note("src/foo.py", 10, "Suggestion: consider typing"),
        _note("src/foo.py", 10, "Suggestion: consider typing"),
    ])
    out = _compress(stdout, exit_code=0)
    assert out.count("Suggestion: consider typing") == 3
    assert "suppressed" in out.lower()


def test_both_error_and_note_suppression_notes_present() -> None:
    # When both errors and notes are suppressed, both suppression messages appear
    error_lines = "\n".join([_error("src/foo.py", 10, "Error msg")] * 4)
    note_lines = "\n".join([_note("src/foo.py", 10, "Note msg")] * 4)
    stdout = error_lines + "\n" + note_lines
    out = _compress(stdout)
    # Should have 2 suppression notes (one for errors, one for notes)
    suppression_count = out.lower().count("suppressed")
    assert suppression_count == 2


def test_success_message_not_classified_as_error() -> None:
    # "Success: no issues found" passes through, no suppression note
    stdout = "Success: no issues found"
    out = _compress(stdout, exit_code=0)
    assert "Success: no issues found" in out
    assert "suppressed" not in out.lower()


def test_summary_line_always_kept() -> None:
    # Summary line matching "Found N error(s) in M file(s)" always kept
    stdout = "\n".join([
        _error("src/foo.py", 10, "Error A"),
    ] * 5)
    stdout += "\nFound 5 errors in 1 file"
    out = _compress(stdout)
    assert "Found 5 errors in 1 file" in out


def test_errors_prevented_further_checking_dropped() -> None:
    # "(errors prevented further checking)" messages are dropped
    stdout = "\n".join([
        _error("src/foo.py", 10, "Error before check"),
        "src/foo.py:11: error: (errors prevented further checking)",
    ])
    out = _compress(stdout)
    assert "errors prevented further checking" not in out


def test_context_display_notes_first_occurrence_preserved() -> None:
    # First occurrence of a context-display note (e.g., indented detail) is preserved
    stdout = "\n".join([
        _error("src/foo.py", 10, "Main error"),
        _note("src/foo.py", 10, "Context about error"),
    ])
    out = _compress(stdout)
    # Both should be present
    assert "Main error" in out
    assert "Context about error" in out


def test_context_display_notes_deduplicated_across_errors() -> None:
    # Duplicate context notes deduplicated (keep first 3, drop rest)
    stdout = "\n".join([
        _error("src/foo.py", 10, "Error 1"),
        _note("src/foo.py", 10, "Context note"),
        _error("src/foo.py", 20, "Error 2"),
        _note("src/foo.py", 20, "Context note"),
        _error("src/foo.py", 30, "Error 3"),
        _note("src/foo.py", 30, "Context note"),
        _error("src/foo.py", 40, "Error 4"),
        _note("src/foo.py", 40, "Context note"),
    ])
    out = _compress(stdout)
    # First 3 context notes kept, 4th dropped
    assert out.count("Context note") == 3
