"""Enhanced tests for JsonArrayFilter, GenericFilter, and WindsurfFilter."""
from __future__ import annotations

import json

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# TestJsonArrayFilter
# ---------------------------------------------------------------------------

class TestJsonArrayFilter:
    F = bc.JsonArrayFilter()

    def _compress(self, stdout: str) -> str:
        return apply_filter(self.F, stdout=stdout, argv=["gh", "api", "/repos"])

    def test_empty_input_returns_empty(self) -> None:
        out = self._compress("")
        assert out == ""

    def test_non_array_json_passthrough(self) -> None:
        # A JSON object (not array) should pass through unchanged
        obj = json.dumps({"key": "value", "count": 42})
        out = self._compress(obj)
        parsed = json.loads(out)
        assert parsed["key"] == "value"
        assert parsed["count"] == 42

    def test_invalid_json_passthrough(self) -> None:
        # Invalid JSON must pass through rather than raise
        junk = "not json at all\nsecond line"
        out = self._compress(junk)
        assert "not json at all" in out

    def test_empty_array_passthrough(self) -> None:
        out = self._compress("[]")
        assert json.loads(out) == []

    def test_single_item_array_passthrough(self) -> None:
        data = [{"id": 1, "name": "alpha"}]
        out = self._compress(json.dumps(data))
        parsed = json.loads(out)
        assert len(parsed) == 1
        assert parsed[0]["name"] == "alpha"

    def test_duplicate_objects_collapsed(self) -> None:
        data = [{"status": "ok"}, {"status": "ok"}, {"status": "ok"}]
        out = self._compress(json.dumps(data))
        assert "2 duplicate" in out

    def test_dedup_suffix_line_count(self) -> None:
        # With N-1 duplicates the suffix must mention the right count
        n = 5
        data = [{"x": 1}] * n
        stdout = json.dumps(data)
        out = self._compress(stdout)
        assert f"{n - 1} duplicate" in out
        # Filter pretty-prints; compare against the full pretty-printed equivalent
        full_pretty = json.dumps(data, indent=2)
        assert len(out) < len(full_pretty)

    def test_objects_different_key_sets_group_separately(self) -> None:
        # Objects with key {"a"} and objects with key {"b"} form separate dedup groups
        data = [
            {"a": 1},
            {"a": 2},
            {"b": 10},
            {"b": 20},
        ]
        out = self._compress(json.dumps(data))
        # Each key-set is deduplicated independently; two separate dedup messages emitted
        assert "keys {a}" in out and "keys {b}" in out

    def test_base64_value_preserves_object(self) -> None:
        # Long base64-like value has high entropy — object must not be deduped
        b64 = "dGhpcyBpcyBhIHRlc3QgYmFzZTY0IHN0cmluZyBsb25nZW5vdWdo"
        data = [
            {"id": 1, "data": "plain"},
            {"id": 2, "data": b64},
        ]
        out = self._compress(json.dumps(data))
        assert "1 duplicate" not in out
        assert b64 in out

    def test_repeated_40char_hex_value_deduped(self) -> None:
        # 40-char hex value that is IDENTICAL in both objects does NOT prevent dedup
        # (entropy guard fires only when the value differs between objects)
        sha = "a" * 40
        data = [
            {"commit": sha, "msg": "first"},
            {"commit": sha, "msg": "first"},
        ]
        out = self._compress(json.dumps(data))
        # Identical objects → deduped; first one is kept
        assert "first" in out
        assert "1 duplicate" in out

    def test_non_dict_items_preserved(self) -> None:
        # Arrays containing non-dict items (strings, ints) pass through
        data = ["alpha", "beta", "gamma"]
        out = self._compress(json.dumps(data))
        parsed = json.loads(out)
        assert "alpha" in parsed
        assert "gamma" in parsed

    def test_mixed_dict_and_scalar_items(self) -> None:
        # Scalars between dicts survive; dict dedup still applies
        data = [{"x": 1}, "sep", {"x": 1}]
        out = self._compress(json.dumps(data))
        assert "sep" in out
        # The two identical {"x": 1} objects must be deduplicated — only one copy survives
        assert "1 duplicate" in out

    def test_large_array_dedup_reduces_size(self) -> None:
        # 50 identical objects → output must be much smaller than input
        data = [{"status": "ok", "code": 200}] * 50
        inp = json.dumps(data)
        out = self._compress(inp)
        assert len(out) < len(inp) * 0.5

    def test_dedup_message_names_key_set(self) -> None:
        data = [{"alpha": 1, "beta": 2}] * 3
        out = self._compress(json.dumps(data))
        # The dedup line must mention both keys
        assert "alpha" in out and "beta" in out


# ---------------------------------------------------------------------------
# TestGenericEntropyFilter
# ---------------------------------------------------------------------------

class TestGenericEntropyFilter:
    F = bc.GenericFilter()

    def _compress(self, stdout: str) -> str:
        return apply_filter(self.F, stdout=stdout, argv=["cmd"])

    def test_empty_input_returns_empty(self) -> None:
        out = self._compress("")
        assert out == ""

    def test_single_line_passthrough(self) -> None:
        out = self._compress("hello world")
        assert "hello world" in out

    def test_two_identical_plain_lines_deduped(self) -> None:
        out = self._compress("foo\nfoo")
        assert "×2" in out

    def test_entropy_bypass_uuid_two_lines(self) -> None:
        # Two identical UUID lines must NOT be deduped
        uid = "550e8400-e29b-41d4-a716-446655440000"
        line = f"request_id={uid}"
        out = self._compress(f"{line}\n{line}")
        assert out.count(line) == 2
        # Entropy bypass means no dedup marker was inserted
        assert "×" not in out

    def test_entropy_bypass_real_sha256(self) -> None:
        # Real SHA-256 hash has high Shannon entropy → bypasses dedup
        sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        line = f"hash={sha}"
        out = self._compress(f"{line}\n{line}")
        assert out.count(line) == 2

    def test_low_entropy_repeated_chars_still_deduped(self) -> None:
        # Repeated-char strings are long but low entropy → dedup fires normally
        token = "x" * 48
        line = f"key={token}"
        out = self._compress(f"{line}\n{line}\n{line}")
        # Low-entropy value — deduped
        assert "×3" in out

    def test_short_line_under_min_length_is_deduped(self) -> None:
        # Lines under 8 chars are not entropy-checked → normal dedup
        out = self._compress("ab\nab\nab")
        assert "×3" in out

    def test_plain_english_lines_collapsed_to_one(self) -> None:
        out = self._compress("note: file updated\n" * 4)
        assert "×4" in out
        assert out.count("note: file updated") == 1

    def test_run_of_mixed_entropy_preserves_order(self) -> None:
        # UUID lines interspersed with plain lines; plain ones collapse
        uid = "550e8400-e29b-41d4-a716-446655440000"
        plain = "processed"
        inp = "\n".join([uid, plain, uid, plain, plain])
        out = self._compress(inp)
        # UUID lines all present
        assert out.count(uid) == 2
        # plain lines collapsed — 3 occurrences of "processed", 2 are duplicates
        assert "×2" in out

    def test_dedup_run_min_two_not_single(self) -> None:
        # A single occurrence is never tagged as a duplicate
        out = self._compress("unique line here")
        assert "×" not in out

    def test_stderr_combined_in_output(self) -> None:
        # apply_filter merges stderr into output when non-empty
        out = apply_filter(self.F, stdout="out line", stderr="err line", argv=["cmd"])
        assert "out line" in out
        assert "err line" in out

    def test_savings_on_repetitive_output(self) -> None:
        # 20 identical lines → at least 50% savings
        ratio = savings_ratio(self.F, stdout="warning: deprecated\n" * 20, argv=["cmd"])
        assert ratio >= 0.50


# ---------------------------------------------------------------------------
# TestWindsurfFilterEnhanced
# ---------------------------------------------------------------------------

class TestWindsurfFilterEnhanced:
    F = bc.WindsurfFilter()

    def test_empty_input_returns_empty(self) -> None:
        out = apply_filter(self.F, stdout="")
        assert out == ""

    def test_dispatch_detects_windsurf_command(self) -> None:
        result = bc.detect_from_command("windsurf .")
        assert result is not None
        filt, _argv = result
        assert filt.name == "windsurf"
        assert filt.matches(["windsurf", "."])

    def test_dispatch_detects_windsurf_path(self) -> None:
        # Full path invocation must also dispatch to WindsurfFilter
        result = bc.detect_from_command("/usr/bin/windsurf --new-window")
        assert result is not None
        filt, _argv = result
        assert filt.name == "windsurf"
        assert filt.matches(["/usr/bin/windsurf", "--new-window"])

    def test_codeium_activation_lines_dropped(self) -> None:
        lines = "Codeium: Activating...\nCodeium index: loading...\nReady.\n"
        out = apply_filter(self.F, stdout=lines)
        assert "Codeium: Activating" not in out
        assert "Codeium index: loading" not in out
        assert "Ready." in out

    def test_authentication_status_dropped(self) -> None:
        lines = "Authentication status: authenticated\nModel status: ready\nDone.\n"
        out = apply_filter(self.F, stdout=lines)
        assert "Authentication status" not in out
        assert "Model status" not in out
        assert "Done." in out

    def test_telemetry_disabled_dropped(self) -> None:
        lines = "Telemetry is disabled\nResponse text here.\n"
        out = apply_filter(self.F, stdout=lines)
        assert "Telemetry is disabled" not in out
        assert "Response text here." in out

    def test_only_noise_returns_minimal(self) -> None:
        # Input with nothing but startup noise produces very short output
        noise = "\n".join([
            "Windsurf v1.4.2",
            "Codeium: Activating...",
            "Codeium index: loading...",
            "Connecting to Codeium server",
            "Authentication status: authenticated",
            "Cascade: connected",
            "Cascade: ready",
            "Thinking...",
            "Generating...",
        ])
        out = apply_filter(self.F, stdout=noise)
        # Meaningful content lines are absent; output must be much shorter than input
        assert len(out) > 0
        assert len(out) < len(noise) * 0.5

    def test_response_body_preserved_in_full(self) -> None:
        # Multi-paragraph response must survive unchanged
        body = (
            "The `process_data` function reads from S3.\n"
            "It transforms records via the ETL pipeline.\n"
            "Finally it writes to PostgreSQL.\n"
        )
        preamble = "Cascade: connected\nThinking...\n"
        out = apply_filter(self.F, stdout=preamble + body)
        assert "reads from S3" in out
        assert "ETL pipeline" in out
        assert "PostgreSQL" in out

    def test_context_meter_single_line_preserved(self) -> None:
        lines = "Context: 12345 / 200000 tokens (6%)\nResult: 42\n"
        out = apply_filter(self.F, stdout=lines)
        assert "12345" in out and "6%" in out
        assert "Result: 42" in out

    def test_multiple_context_meters_only_last_kept(self) -> None:
        # Earlier meter reads are superseded by the last one
        lines = (
            "Context: 10000 / 200000 tokens (5%)\n"
            "Context: 50000 / 200000 tokens (25%)\n"
            "Context: 80000 / 200000 tokens (40%)\n"
            "Answer text.\n"
        )
        out = apply_filter(self.F, stdout=lines)
        # Only the last meter value should appear
        assert "10000" not in out
        assert "50000" not in out
        assert "Answer text." in out

    def test_savings_on_pure_startup_noise(self) -> None:
        noise = (
            "Windsurf v1.4.2\n"
            "Codeium: Activating...\n"
            "Codeium index: loading...\n"
            "Codeium index loaded\n"
            "Connecting to Codeium server\n"
            "Authentication status: authenticated\n"
            "Model status: ready\n"
            "Cascade: connected\n"
            "Cascade: ready\n"
            "Cascade v2.1.0\n"
            "AI assistant ready\n"
            "Loading workspace...\n"
            "Indexing workspace... (100/500 files)\n"
            "Workspace loading\n"
            "Scanning files...\n"
            "File watcher started\n"
            "Thinking...\n"
            "Generating...\n"
            "Telemetry is disabled\n"
        ) * 3
        ratio = savings_ratio(self.F, stdout=noise)
        assert ratio >= 0.60

    def test_tool_calls_collapsed_to_count(self) -> None:
        lines = (
            "Cascade is reading file: src/a.py\n"
            "Cascade is reading file: src/b.py\n"
            "Cascade is reading file: src/c.py\n"
            "Cascade is writing file: src/d.py\n"
            "Cascade is running: make test\n"
            "Here is my summary.\n"
        )
        out = apply_filter(self.F, stdout=lines)
        # None of the file paths should appear verbatim
        assert "src/a.py" not in out
        assert "src/b.py" not in out
        assert "src/c.py" not in out
        assert "src/d.py" not in out
        # A collapse message with count and tool-call label must be present
        assert "collapsed" in out.lower() and "tool" in out.lower()
        assert "Here is my summary." in out

    def test_filter_name_is_windsurf(self) -> None:
        assert self.F.name == "windsurf"

    def test_pure_response_no_noise_passthrough(self) -> None:
        # Clean response with no noise patterns must survive intact
        body = "The answer is 42.\nNo noise here.\n"
        out = apply_filter(self.F, stdout=body)
        assert "The answer is 42." in out
        assert "No noise here." in out
