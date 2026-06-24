/**
 * Tests for bash command formatting in hints (_format_bash_command_for_hint).
 *
 * 1:1 port of tests/test_bash_command_formatting.py.
 *
 * Source-of-truth note (Python -> TS): the Python test imports
 *   from token_goat.hints import (_MAX_BASH_COMMAND_DISPLAY_LEN,
 *                                 _format_bash_command_for_hint)
 * Both symbols live in the hints module (Python token_goat/hints.py), and the
 * TS port keeps them there too — src/token_goat/hints.ts exports
 * `_MAX_BASH_COMMAND_DISPLAY_LEN` (= 60) and `_format_bash_command_for_hint`
 * under their exact Python names. So we import from "../src/token_goat/hints.js"
 * (mirroring the Python `from token_goat.hints import ...`), not the
 * bash_compress barrel — the barrel does not re-export these command-formatting
 * helpers; they are hint-layer helpers.
 *
 * Length note: the Python helper compares Python `len(str)` (Unicode codepoints)
 * against _MAX_BASH_COMMAND_DISPLAY_LEN, and the TS port compares String.length
 * (UTF-16 code units). Every command exercised here is ASCII apart from the
 * single trailing ellipsis "…" (U+2026, one codepoint / one UTF-16 unit), so the
 * two length notions coincide for these inputs and the assertions are
 * byte/codepoint/unit agnostic. No Buffer byte-length is needed for this file.
 *
 * Each Python `def test_*` -> one vitest `it()` with the SAME name and the same
 * assertion polarity. The single Python test class becomes a `describe`.
 */
import { describe, expect, it } from "vitest";

import {
  _MAX_BASH_COMMAND_DISPLAY_LEN,
  _format_bash_command_for_hint,
} from "../src/token_goat/hints.js";

describe("TestFormatBashCommandForHint", () => {
  // _format_bash_command_for_hint should intelligently truncate long commands.

  it("test_short_command_unchanged", () => {
    // Commands shorter than max length are returned as-is.
    const cmd = "ls -la";
    const result = _format_bash_command_for_hint(cmd);
    expect(result).toBe(cmd);
  });

  it("test_command_at_max_length", () => {
    // Commands exactly at max length are returned as-is.
    const cmd = "a".repeat(_MAX_BASH_COMMAND_DISPLAY_LEN);
    const result = _format_bash_command_for_hint(cmd);
    expect(result).toBe(cmd);
  });

  it("test_long_command_truncated_with_ellipsis", () => {
    // Commands exceeding max length are truncated with ellipsis.
    const cmd = "pytest " + "a".repeat(100) + "::test_name";
    const result = _format_bash_command_for_hint(cmd);
    expect(result.endsWith("…")).toBe(true); // truncated command should end with ellipsis
    expect(result.length).toBeLessThanOrEqual(_MAX_BASH_COMMAND_DISPLAY_LEN + 1); // +1 for ellipsis
  });

  it("test_extracts_main_command_and_first_arg", () => {
    // Long commands are truncated to keep main command and first meaningful arg.
    const cmd = "pytest tests/very/long/path/to/test_file.py::test_name -v --tb=short";
    const result = _format_bash_command_for_hint(cmd);
    // Should keep "pytest" and "tests/very/long/..." but truncate trailing args
    expect(result.startsWith("pytest")).toBe(true); // should preserve the main command
    expect(result.includes("…") || result === cmd).toBe(true); // should have ellipsis if truncated
  });

  it("test_multiword_command_preserved", () => {
    // Multi-word commands like 'uv run' are preserved.
    const cmd = "uv run pytest tests/auth/test_login.py::test_password_validation -v -x";
    const result = _format_bash_command_for_hint(cmd);
    // Should keep "uv run pytest" and possibly first arg
    expect(result.startsWith("uv")).toBe(true); // should start with first part of multi-word command
    if (result !== cmd) {
      expect(result.endsWith("…")).toBe(true); // truncated version should end with ellipsis
    }
  });

  it("test_sanitizes_newlines", () => {
    // Newlines in commands are escaped for safety.
    const cmd = "echo hello\necho injected";
    const result = _format_bash_command_for_hint(cmd);
    expect(result.includes("\n")).toBe(false); // newlines must be escaped
    // The sanitize function replaces \n with literal \\n
    expect(result.includes("\\n") || result.includes("echo hello")).toBe(true);
  });

  it("test_sanitizes_carriage_returns", () => {
    // Carriage returns in commands are escaped.
    const cmd = "echo test\rinjected";
    const result = _format_bash_command_for_hint(cmd);
    expect(result.includes("\r")).toBe(false); // carriage returns must be escaped
  });

  it("test_simple_long_pytest_command", () => {
    // Realistic pytest command with long path.
    const cmd =
      "pytest tests/unit/auth/login/test_password_validation.py::TestPasswordValidator::test_requires_special_char -v";
    const result = _format_bash_command_for_hint(cmd);
    // Should show "pytest tests/unit/auth/..." but not the full path
    expect(result.includes("pytest")).toBe(true);
    if (cmd.length > _MAX_BASH_COMMAND_DISPLAY_LEN) {
      expect(result.includes("…")).toBe(true);
    }
  });

  it("test_uv_lock_update_command", () => {
    // Realistic uv lock command.
    const cmd = "uv lock --upgrade package_name --with-extra-features";
    const result = _format_bash_command_for_hint(cmd);
    expect(result.includes("uv")).toBe(true);
    // If this command is short enough, it should be unchanged
    if (cmd.length <= _MAX_BASH_COMMAND_DISPLAY_LEN) {
      expect(result).toBe(cmd);
    }
  });

  it("test_find_command_with_many_predicates", () => {
    // Long find command with many predicates should be intelligently truncated.
    const cmd = "find /srv/data -name '*.log' -type f -mtime +30 -size +1M -exec rm {} +";
    const result = _format_bash_command_for_hint(cmd);
    expect(result.startsWith("find")).toBe(true); // should keep the find command
    if (result !== cmd) {
      expect(result.includes("…")).toBe(true);
    }
  });

  it("test_ruff_check_with_fix", () => {
    // Ruff command with --fix and path.
    const cmd = "uv run ruff check --fix src/token_goat/";
    const result = _format_bash_command_for_hint(cmd);
    expect(result.includes("uv")).toBe(true);
    expect(result.includes("ruff") || cmd === result).toBe(true); // Should preserve main command parts
  });

  it("test_empty_command", () => {
    // Empty command is handled gracefully.
    const cmd = "";
    const result = _format_bash_command_for_hint(cmd);
    expect(result).toBe(cmd); // Should return empty
  });

  it("test_whitespace_only_command", () => {
    // Whitespace-only command is handled.
    const cmd = "   ";
    const result = _format_bash_command_for_hint(cmd);
    // After split, there are no parts, so should return original sanitized
    expect(typeof result).toBe("string");
  });

  it("test_command_without_args", () => {
    // Single-word command without args.
    const cmd = "pytest";
    const result = _format_bash_command_for_hint(cmd);
    expect(result).toBe(cmd);
  });

  it("test_python_m_command", () => {
    // Python -m commands should preserve both parts.
    const cmd =
      "python -m pytest tests/very/long/path/test_module.py::TestClass::test_method -v -s";
    const result = _format_bash_command_for_hint(cmd);
    // Should keep "python -m pytest" minimum
    if (cmd.length > _MAX_BASH_COMMAND_DISPLAY_LEN) {
      expect(result.includes("…")).toBe(true);
      expect(
        (result.includes("python") && result.includes("pytest")) || result.includes("…"),
      ).toBe(true);
    }
  });

  it("test_length_strictly_respected", () => {
    // Result length (excluding ellipsis) must be <= MAX_BASH_COMMAND_DISPLAY_LEN.
    for (const test_cmd of [
      "pytest " + "a".repeat(200),
      "find /very/long/path -name pattern -type f -mtime +30",
      "uv run " + "x".repeat(300),
    ]) {
      const result = _format_bash_command_for_hint(test_cmd);
      // Measure length without the ellipsis char. Python's str.rstrip("…")
      // strips ALL trailing "…" chars; replace(/…+$/, "") is the faithful TS
      // equivalent (there is at most one here, appended by the helper).
      const result_without_ellipsis = result.replace(/…+$/, "");
      expect(
        result_without_ellipsis.length,
        `Result '${result}' is too long: ${result_without_ellipsis.length} > ${_MAX_BASH_COMMAND_DISPLAY_LEN}`,
      ).toBeLessThanOrEqual(_MAX_BASH_COMMAND_DISPLAY_LEN);
    }
  });
});
