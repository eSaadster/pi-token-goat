/**
 * Direct unit tests for the `_run_output_recall_command` helper + its sub-helpers
 * — TS port of tests/test_cli_output_recall.py (DRY#5).
 *
 * These exercise the helper directly (NOT via the CLI), mirroring the Python
 * tests which call `_run_output_recall_command` with a fake cache module and
 * capture stdout via capsys. The TS helper emits through `_echo` (process.stdout),
 * so we capture via a process.stdout.write spy. `patch("token_goat.db.record_stat")`
 * → `vi.spyOn(db, "recordStat")` (the helper calls it via `import * as db`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as db from "../src/token_goat/db.js";
import {
  _GREP_MAX_DEFAULT,
  _apply_grep_cap,
  _extract_body_section,
  _run_output_recall_command,
} from "../src/token_goat/cli_history.js";
import { _compile_grep_pattern as _compileGrep } from "../src/token_goat/cli_skills.js";
import { CliExit } from "../src/token_goat/cli_common.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Capture process.stdout writes during *fn* and return the joined string. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8"));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

/** Python `str.splitlines()` (drops the trailing empty). */
function pySplitLines(s: string): string[] {
  const out = s.split(/\r\n|\r|\n/);
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** A fake cache module for the recall helper (MagicMock analogue). */
function makeCacheModule(
  body: string | null = "line1\nline2\nline3",
  meta: Record<string, unknown> | null = null,
  sidecar: Record<string, unknown> | null = null,
): {
  load_output: () => string | null;
  load_output_meta: () => Record<string, unknown> | null;
  read_sidecar: () => Record<string, unknown> | null;
} {
  return {
    load_output: () => body,
    load_output_meta: () => meta,
    read_sidecar: () => sidecar,
  };
}

/** Spy db.record_stat as a no-op (Python `patch("token_goat.db.record_stat")`). */
function mockRecordStat() {
  return vi.spyOn(db, "recordStat").mockImplementation(() => {});
}

describe("TestOutputRecallHelper", () => {
  it("plain text returns full body when below smart-default threshold", () => {
    const cache = makeCacheModule("alpha\nbeta\ngamma");
    const mockDb = mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "sess-abc-001",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
      }),
    );
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
    expect(mockDb).toHaveBeenCalledTimes(1);
    expect(mockDb.mock.calls[0]![1]).toBe("bash_output_recall");
  });

  it("grep filter filters lines", () => {
    const cache = makeCacheModule("PASS: foo\nFAIL: bar\nPASS: baz");
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: "PASS",
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
      }),
    );
    expect(out).toContain("PASS: foo");
    expect(out).toContain("PASS: baz");
    expect(out).not.toContain("FAIL");
  });

  it("json output returns valid json with expected keys", () => {
    const sidecar = { cmd_preview: "pytest tests/", exit_code: 0, truncated: false };
    const cache = makeCacheModule("line1\nline2", { bytes_stored: 12 }, sidecar);
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "out-123",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: true,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
      }),
    );
    const data = JSON.parse(out);
    expect(data.output_id).toBe("out-123");
    expect(data).toHaveProperty("numbered_lines");
    expect(data).toHaveProperty("total_lines");
    expect(data.cmd_preview).toBe("pytest tests/");
    expect(data.exit_code).toBe(0);
    expect(data.bytes_stored).toBe(12);
  });

  it("missing cache entry raises exit 1", () => {
    const cache = makeCacheModule(null);
    mockRecordStat();
    let code: number | undefined;
    try {
      _run_output_recall_command({
        output_id: "missing",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "no cached output for id: missing",
      });
    } catch (e) {
      code = (e as CliExit).code;
    }
    expect(code).toBe(1);
  });

  it("web stat kind is web_output_recall", () => {
    const sidecar = { url_preview: "https://example.com", status_code: 200, truncated: false };
    const cache = makeCacheModule("hello", null, sidecar);
    const mockDb = mockRecordStat();
    captureStdout(() =>
      _run_output_recall_command({
        output_id: "web-001",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "web_output_recall",
        not_found_msg: "not found",
      }),
    );
    expect(mockDb.mock.calls[0]![1]).toBe("web_output_recall");
  });
});

// ---------------------------------------------------------------------------
// Item 7 — --head-tail flag
// ---------------------------------------------------------------------------

function makeBody(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("TestHeadTailFlag", () => {
  it("60-line body truncates to first 20 + marker + last 20", () => {
    const cache = makeCacheModule(makeBody(60));
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
        head_tail: true,
      }),
    );
    const lines = pySplitLines(out);
    expect(lines[0]).toBe("line 1");
    expect(lines[19]).toBe("line 20");
    const omit = lines.filter((ln) => ln.includes("lines omitted"));
    expect(omit).toHaveLength(1);
    expect(omit[0]).toContain("20");
    expect(lines[lines.length - 1]).toBe("line 60");
    expect(lines[lines.length - 20]).toBe("line 41");
    expect(lines).toHaveLength(41);
  });

  it("30-line body unchanged (no marker)", () => {
    const cache = makeCacheModule(makeBody(30));
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
        head_tail: true,
      }),
    );
    const lines = pySplitLines(out);
    expect(lines).toHaveLength(30);
    expect(lines.every((ln) => !ln.includes("lines omitted"))).toBe(true);
  });

  it("40-line body (== threshold) unchanged", () => {
    const cache = makeCacheModule(makeBody(40));
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
        head_tail: true,
      }),
    );
    const lines = pySplitLines(out);
    expect(lines).toHaveLength(40);
    expect(lines.every((ln) => !ln.includes("lines omitted"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 10 — --grep-max N flag
// ---------------------------------------------------------------------------

function makeGrepBody(matchCount: number, noiseCount = 5): string {
  const lines: string[] = [];
  for (let i = 1; i <= matchCount; i++) {
    lines.push(`MATCH line ${i}`);
    if (i <= noiseCount) lines.push(`noise ${i}`);
  }
  return lines.join("\n");
}

describe("TestGrepMaxFlag", () => {
  it("50 matches with grep-max 5 → 5 lines + header + footer", () => {
    const cache = makeCacheModule(makeGrepBody(50));
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: "MATCH",
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
        grep_max: 5,
      }),
    );
    const lines = pySplitLines(out);
    expect(lines[0]).toBe("Match count: 50");
    const matchLines = lines.slice(1).filter((ln) => ln.startsWith("MATCH"));
    expect(matchLines).toHaveLength(5);
    const footer = lines.filter((ln) => ln.includes("--grep-max 0"));
    expect(footer).toHaveLength(1);
    expect(footer[0]).toContain("50");
  });

  it("grep-max 0 returns all matches, no footer", () => {
    const cache = makeCacheModule(makeGrepBody(50));
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: "MATCH",
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
        grep_max: 0,
      }),
    );
    const lines = pySplitLines(out);
    const matchLines = lines.filter((ln) => ln.startsWith("MATCH"));
    expect(matchLines).toHaveLength(50);
    expect(lines.every((ln) => !ln.includes("--grep-max 0"))).toBe(true);
  });

  it("_GREP_MAX_DEFAULT is 20", () => {
    expect(_GREP_MAX_DEFAULT).toBe(20);
  });
});

describe("TestApplyGrepCap", () => {
  it("no truncation when matches <= grep_max", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const [result, footer] = _apply_grep_cap(lines, 20);
    expect(result).toEqual(lines);
    expect(footer).toBe("");
  });

  it("truncates and returns footer when matches > grep_max", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const [result, footer] = _apply_grep_cap(lines, 10);
    expect(result).toEqual(lines.slice(0, 10));
    expect(footer).toContain("--grep-max 0");
    expect(footer).toContain("30");
  });
});

// ---------------------------------------------------------------------------
// _extract_body_section
// ---------------------------------------------------------------------------

describe("TestExtractBodySection", () => {
  it("returns a named ATX section", () => {
    const body = "# Intro\nsome text\n## Installation\ninstall stuff\n## Usage\nuse it";
    const result = _extract_body_section(body, "Installation");
    expect(result).not.toBeNull();
    expect(result).toContain("## Installation");
    expect(result).toContain("install stuff");
    expect(result).not.toContain("## Usage");
    expect(result).not.toContain("use it");
  });

  it("matches headings case-insensitively", () => {
    const body = "## Configuration\nconfig text\n## Other\nother";
    const result = _extract_body_section(body, "configuration");
    expect(result).not.toBeNull();
    expect(result).toContain("config text");
  });

  it("returns null when heading absent", () => {
    const body = "## Intro\ntext\n## Usage\nmore text";
    expect(_extract_body_section(body, "Nonexistent")).toBeNull();
  });

  it("Heading#2 selects the second occurrence", () => {
    const body = "## Example\nfirst\n## Example\nsecond\n## Other\nthird";
    const first = _extract_body_section(body, "Example");
    const second = _extract_body_section(body, "Example#2");
    expect(first).not.toBeNull();
    expect(first).toContain("first");
    expect(second).not.toBeNull();
    expect(second).toContain("second");
    expect(second).not.toContain("first");
  });

  it("ordinal out of range returns null", () => {
    const body = "## Example\nonly one";
    expect(_extract_body_section(body, "Example#2")).toBeNull();
  });

  it("last section reaches eof", () => {
    const body = "## First\nfirst text\n## Last\nlast text";
    const result = _extract_body_section(body, "Last");
    expect(result).not.toBeNull();
    expect(result).toContain("last text");
  });

  it("subsection stops at same level", () => {
    const body = "# Top\n## Sub1\nsub one content\n### Nested\nnested content\n## Sub2\nsub two";
    const result = _extract_body_section(body, "Sub1");
    expect(result).not.toBeNull();
    expect(result).toContain("sub one content");
    expect(result).toContain("Nested");
    expect(result).not.toContain("Sub2");
  });
});

// ---------------------------------------------------------------------------
// _compile_grep_pattern (regex support) — lives in cli_skills
// ---------------------------------------------------------------------------

describe("TestCompileGrepPattern", () => {
  it("compiles valid regex", () => {
    const pat = _compileGrep("def \\w+", false);
    expect(pat.test("def my_function:")).toBe(true);
    expect(pat.test("class MyClass:")).toBe(false);
  });

  it("invalid regex falls back to literal", () => {
    const pat = _compileGrep("[unclosed", true);
    expect(pat.test("[unclosed bracket here")).toBe(true);
    expect(pat.test("something else")).toBe(false);
  });

  it("case-insensitive matches any case", () => {
    const pat = _compileGrep("TODO", false);
    expect(pat.test("todo: fix this")).toBe(true);
    expect(pat.test("TODO: fix this")).toBe(true);
    expect(pat.test("Todo: fix this")).toBe(true);
  });

  it("case-sensitive is exact", () => {
    const pat = _compileGrep("TODO", true);
    expect(pat.test("TODO: fix this")).toBe(true);
    expect(pat.test("todo: fix this")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --grep regex support in _run_output_recall_command
// ---------------------------------------------------------------------------

describe("TestGrepRegex", () => {
  it("real regex pattern filters by regex", () => {
    const body =
      "def my_func():\n    pass\nclass MyClass:\n    def method(self):\n        pass\n";
    const cache = makeCacheModule(body);
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: "def \\w+",
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
      }),
    );
    expect(out).toContain("def my_func");
    expect(out).toContain("def method");
    expect(out).not.toContain("class MyClass");
  });

  it("invalid regex treated as literal", () => {
    const body = "line with [special chars\nnormal line\nanother [special chars line\n";
    const cache = makeCacheModule(body);
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: "[special chars",
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "bash_output_recall",
        not_found_msg: "not found",
      }),
    );
    expect(out).toContain("line with [special chars");
    expect(out).toContain("another [special chars line");
    expect(out).not.toContain("normal line");
  });
});

// ---------------------------------------------------------------------------
// --section in _run_output_recall_command
// ---------------------------------------------------------------------------

describe("TestSection", () => {
  it("extracts the named section", () => {
    const body = "# Root\nroot content\n## Installation\nrun pip install\n## Usage\nrun it\n";
    const cache = makeCacheModule(body);
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "web_output_recall",
        not_found_msg: "not found",
        section: "Installation",
      }),
    );
    expect(out).toContain("run pip install");
    expect(out).toContain("## Installation");
    expect(out).not.toContain("## Usage");
    expect(out).not.toContain("root content");
  });

  it("missing heading exits with error", () => {
    const body = "## Intro\nsome text\n";
    const cache = makeCacheModule(body);
    mockRecordStat();
    let code: number | undefined;
    try {
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "web_output_recall",
        not_found_msg: "not found",
        section: "Nonexistent",
      });
    } catch (e) {
      code = (e as CliExit).code;
    }
    expect(code).toBe(1);
  });

  it("section + grep combined (section first, then grep)", () => {
    const body =
      "## Installation\n" +
      "run: pip install foo\n" +
      "run: pip install bar\n" +
      "note: you also need baz\n" +
      "## Usage\n" +
      "run: foo --help\n";
    const cache = makeCacheModule(body);
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: "pip install",
        full: false,
        json_output: false,
        cache_module: cache,
        stat_kind: "web_output_recall",
        not_found_msg: "not found",
        section: "Installation",
      }),
    );
    expect(out).toContain("pip install foo");
    expect(out).toContain("pip install bar");
    expect(out).not.toContain("note: you also need baz");
    expect(out).not.toContain("foo --help");
  });

  it("json output includes a section field", () => {
    const body = "## API\napi content\n## Other\nother content\n";
    const cache = makeCacheModule(body);
    mockRecordStat();
    const out = captureStdout(() =>
      _run_output_recall_command({
        output_id: "x",
        head: 0,
        tail: 0,
        grep: null,
        full: false,
        json_output: true,
        cache_module: cache,
        stat_kind: "web_output_recall",
        not_found_msg: "not found",
        section: "API",
      }),
    );
    const payload = JSON.parse(out);
    expect(payload.section).toBe("API");
    expect(payload.text).toContain("api content");
  });
});
