/**
 * Tests for GhFilter base64 content-field redaction.
 *
 * 1:1 port of tests/test_bash_compress_gh_base64.py. The Python test classes
 * (TestRedactGhBase64Content, TestGhFilterBase64Integration) map to describe()
 * blocks of the same name; every `def test_*` maps to an `it()` with the SAME
 * name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import GhFilter, _redact_gh_base64_content`
 *      -> named imports from the barrel "../src/token_goat/bash_compress.js".
 *  - `base64.b64encode(text.encode()).decode()` -> Buffer.from(text, "utf8")
 *    .toString("base64"); `len(raw)` (decoded byte count) -> Buffer length.
 *  - `json.dumps(payload)` (compact, default separators ", " / ": ") and
 *    `json.dumps(payload, indent=2)` (pretty) are reproduced by `_pyJsonDumps`,
 *    which mirrors CPython's serialiser for the flat/nested string-dict and
 *    list-of-dict fixtures these tests build. `json.loads(result)` -> JSON.parse.
 *  - `setup_method` (`self.flt = GhFilter()`) -> a fresh `new GhFilter()` per
 *    `it()` (a const inside each test, matching the per-method instantiation).
 *
 * Byte-exactness: the decoded-byte-count assertion compares the UTF-8 length of
 * the original bytes (Buffer length) — the helper under test computes the same
 * via Buffer.from(content, "base64").length, so the counts line up exactly.
 */
import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { GhFilter, _redact_gh_base64_content } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// CPython json.dumps emulation for the fixtures these tests build.
//
// Compact (indent=None): default separators are ", " between items and ": "
// between key and value. Pretty (indent=2): each nested level is indented by
// two spaces per level, items separated by ",\n", key/value by ": ", and the
// closing bracket de-indented to the parent level. Only the value kinds the
// fixtures use (string, number, dict, list) are handled.
// ---------------------------------------------------------------------------
function _pyJsonDumpsCompact(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => _pyJsonDumpsCompact(v)).join(", ") + "]";
  }
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj).map(
    (k) => `${JSON.stringify(k)}: ${_pyJsonDumpsCompact(obj[k])}`,
  );
  return "{" + parts.join(", ") + "}";
}

function _pyJsonDumpsPretty(value: unknown, level = 0): string {
  const pad = "  ".repeat(level + 1);
  const closePad = "  ".repeat(level);
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((v) => pad + _pyJsonDumpsPretty(v, level + 1));
    return "[\n" + items.join(",\n") + "\n" + closePad + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return "{}";
  }
  const items = keys.map((k) => pad + `${JSON.stringify(k)}: ${_pyJsonDumpsPretty(obj[k], level + 1)}`);
  return "{\n" + items.join(",\n") + "\n" + closePad + "}";
}

/** Return base64-encoded version of text with trailing newline (GitHub style). */
function _b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64") + "\n";
}

// Build a blob long enough to exceed the 200-char minimum.
const _LONG_B64 = _b64("x".repeat(300));
// Mirror the Python module-level assert len(_LONG_B64) > 200.
expect(_LONG_B64.length).toBeGreaterThan(200);

describe("TestRedactGhBase64Content", () => {
  it("test_single_object_content_replaced", () => {
    const payload = { name: "README.md", content: _LONG_B64, sha: "abc123" };
    const stdout = _pyJsonDumpsPretty(payload);
    const result = _redact_gh_base64_content(stdout);
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("README.md");
    expect(parsed.sha).toBe("abc123");
    expect(parsed.content).toContain("<base64 content:");
    expect(parsed.content).toContain("bytes decoded");
  });

  it("test_decoded_byte_count_accurate", () => {
    const raw = Buffer.from("Hello, World! ".repeat(30), "utf8"); // ensure > 200 chars b64-encoded
    const encoded = raw.toString("base64") + "\n";
    const payload = { content: encoded };
    const result = _redact_gh_base64_content(_pyJsonDumpsCompact(payload));
    const parsed = JSON.parse(result);
    expect(parsed.content).toContain(`${raw.length} bytes decoded`);
  });

  it("test_array_elements_redacted", () => {
    const items = [
      { name: "file1.py", content: _LONG_B64 },
      { name: "file2.py", content: _LONG_B64 },
    ];
    const stdout = _pyJsonDumpsPretty(items);
    const result = _redact_gh_base64_content(stdout);
    const parsed = JSON.parse(result);
    expect(parsed.length).toBe(2);
    for (const item of parsed) {
      expect(item.content).toContain("<base64 content:");
    }
  });

  it("test_array_mixed_elements_passthrough", () => {
    const items = [{ name: "file1.py", content: _LONG_B64 }, "just a string"];
    const stdout = _pyJsonDumpsCompact(items);
    const result = _redact_gh_base64_content(stdout);
    const parsed = JSON.parse(result);
    expect(parsed[0].content).toContain("<base64 content:");
    expect(parsed[1]).toBe("just a string");
  });

  it("test_short_content_not_redacted", () => {
    const payload = { content: "c2hvcnQ=" }; // base64 for "short" — under 200 chars
    const stdout = _pyJsonDumpsCompact(payload);
    const result = _redact_gh_base64_content(stdout);
    expect(result).toBe(stdout);
  });

  it("test_non_base64_content_not_redacted", () => {
    const long_val = "this is not base64: " + "hello world ".repeat(20);
    const payload = { content: long_val };
    const stdout = _pyJsonDumpsCompact(payload);
    const result = _redact_gh_base64_content(stdout);
    expect(result).toBe(stdout);
  });

  it("test_malformed_json_passthrough", () => {
    const not_json = "not json at all { content: broken";
    const result = _redact_gh_base64_content(not_json);
    expect(result).toBe(not_json);
  });

  it("test_empty_stdout_passthrough", () => {
    expect(_redact_gh_base64_content("")).toBe("");
    expect(_redact_gh_base64_content("   ")).toBe("   ");
  });

  it("test_non_json_object_passthrough", () => {
    const plain = "just a plain string";
    expect(_redact_gh_base64_content(plain)).toBe(plain);
  });

  it("test_object_without_content_field_unchanged", () => {
    const payload = { name: "README.md", sha: "abc123", size: 42 };
    const stdout = _pyJsonDumpsCompact(payload);
    const result = _redact_gh_base64_content(stdout);
    expect(result).toBe(stdout);
  });

  it("test_pretty_printed_output_stays_pretty", () => {
    const payload = { content: _LONG_B64, sha: "def456" };
    const stdout = _pyJsonDumpsPretty(payload);
    const result = _redact_gh_base64_content(stdout);
    expect(result).toContain("\n"); // re-serialized with indent=2
  });

  it("test_compact_output_stays_compact", () => {
    const payload = { content: _LONG_B64, sha: "def456" };
    const stdout = _pyJsonDumpsCompact(payload); // no indent → compact
    const result = _redact_gh_base64_content(stdout);
    expect(result).not.toContain("\n"); // no newlines in compact form
  });
});

describe("TestGhFilterBase64Integration", () => {
  it("test_gh_api_contents_redacted", () => {
    const flt = new GhFilter();
    const payload = { name: "main.py", content: _LONG_B64, sha: "abc" };
    const stdout = _pyJsonDumpsPretty(payload);
    const result = flt.compress(stdout, "", 0, ["gh", "api", "repos/o/r/contents/main.py"]);
    expect(result).toContain("<base64 content:");
  });

  it("test_gh_api_non_contents_passthrough", () => {
    const flt = new GhFilter();
    const stdout = _pyJsonDumpsCompact({ id: 1, name: "my-repo" });
    const result = flt.compress(stdout, "", 0, ["gh", "api", "repos/o/r"]);
    expect(result).toContain("my-repo");
    expect(result).not.toContain("<base64");
  });
});
