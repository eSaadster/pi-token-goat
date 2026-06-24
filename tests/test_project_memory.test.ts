/**
 * Unit tests for token_goat/project_memory.
 *
 * There is NO dedicated test_project_memory.py upstream. The cases below are a
 * 1:1 port of TestProjectMemory in tests/test_new_features.py — the only Python
 * suite that exercises this module — so coverage tracks the original exactly.
 *
 * Test-seam mapping (Python -> TS):
 *  - `with patch.object(paths, "data_dir", return_value=tmp_path):`
 *      -> nothing. tests/setup.ts already calls setDataDirOverride(tmpDir) in
 *         beforeEach, giving every test an isolated data dir; project_memory's
 *         memoryPath() resolves under paths.dataDir() (the same seam Python
 *         patched), so the calls land in the per-test dir automatically. The
 *         Python pattern of patching paths.data_dir is therefore implicit here.
 *  - `pytest.raises(ValueError)` -> expect(() => ...).toThrow().
 *  - `from token_goat.project_memory import _MAX_TOTAL_CHARS`
 *      -> imported directly (exported snake_case for parity).
 *  - Python `result is None` -> `toBeNull()` (build_injection returns null).
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity.
 */
import { describe, expect, it } from "vitest";

import {
  _MAX_TOTAL_CHARS,
  build_injection,
  clear_all,
  load_entries,
  set_entry,
  unset_entry,
} from "../src/token_goat/project_memory.js";

describe("TestProjectMemory", () => {
  it("test_set_and_load", () => {
    set_entry("abc123", "owner", "alice");
    const entries = load_entries("abc123");
    expect(entries["owner"]).toBe("alice");
  });

  it("test_unset_removes_key", () => {
    set_entry("abc123", "k", "v");
    unset_entry("abc123", "k");
    const entries = load_entries("abc123");
    expect("k" in entries).toBe(false);
  });

  it("test_unset_nonexistent_is_noop", () => {
    unset_entry("abc123", "ghost");
  });

  it("test_clear_all", () => {
    set_entry("abc123", "a", "1");
    set_entry("abc123", "b", "2");
    clear_all("abc123");
    expect(load_entries("abc123")).toEqual({});
  });

  it("test_invalid_key_raises", () => {
    expect(() => set_entry("abc123", "bad key!", "v")).toThrow();
  });

  it("test_build_injection_returns_none_when_empty", () => {
    const result = build_injection("abc123");
    expect(result).toBeNull();
  });

  it("test_build_injection_returns_markdown", () => {
    set_entry("abc123", "stack", "Python/FastAPI");
    const result = build_injection("abc123");
    expect(result).not.toBeNull();
    expect(result).toContain("stack");
    expect(result).toContain("Python/FastAPI");
    expect(result!.startsWith("## Project Memory")).toBe(true);
  });

  it("test_value_truncated_in_injection", () => {
    const longVal = "x".repeat(400);
    set_entry("abc123", "big", longVal);
    const result = build_injection("abc123");
    expect(result).not.toBeNull();
    expect(result).toContain("…");
  });

  it("test_newline_in_value_survives_roundtrip", () => {
    set_entry("abc123", "note", "line1\nline2");
    const entries = load_entries("abc123");
    expect(entries["note"]).toBe("line1\nline2");
  });

  it("test_carriage_return_in_value_survives_roundtrip", () => {
    set_entry("abc123", "crlf", "line1\r\nline2");
    const entries = load_entries("abc123");
    expect(entries["crlf"]).toBe("line1\r\nline2");
  });

  it("test_total_size_budget_enforced", () => {
    // Each value is 350 chars; 20 entries × ~370 chars/line >> _MAX_TOTAL_CHARS
    for (let i = 0; i < 20; i++) {
      const key = `key${String(i).padStart(2, "0")}`;
      set_entry("abc123", key, "v".repeat(350));
    }
    const result = build_injection("abc123");
    expect(result).not.toBeNull();
    // omission line may push slightly past; len() = code-point count
    expect([...result!].length).toBeLessThanOrEqual(_MAX_TOTAL_CHARS + 200);
    expect(result).toContain("omitted");
  });

  it("test_normal_memory_not_truncated_by_total_budget", () => {
    set_entry("abc123", "stack", "Python/FastAPI");
    set_entry("abc123", "owner", "alice");
    const result = build_injection("abc123");
    expect(result).not.toBeNull();
    expect(result).not.toContain("omitted");
    expect(result).toContain("stack");
    expect(result).toContain("owner");
  });
});
