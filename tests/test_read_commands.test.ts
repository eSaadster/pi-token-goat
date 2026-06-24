/**
 * 1:1 port of tests/test_read_commands.py.
 *
 * Covers Item 15 (--no-header / TTY auto-detection in `_emit_text_result`),
 * `_run_read_like_command` header/footer/no-color wiring, `_apply_context_gutter`,
 * `_context_bounds`, `read_symbol` core_start/end_line, and `stub_view`.
 *
 * Port model (see tests/test_repomap.test.ts for the established idioms):
 *  - pytest `capsys.readouterr().out` → spy `process.stdout.write` with the
 *    captureStdout pattern; `process.stderr.write` is captured separately when a
 *    test needs to distinguish stderr (`_echo(..., {err:true})`).
 *  - `patch.object(sys.stdout, "isatty", return_value=…)` → set
 *    `process.stdout.isTTY` (the property `_isatty()` reads), restored in finally.
 *  - kwargs → a trailing `opts` object (same snake_case names). All command fns
 *    are sync and emit via the cli_common `_echo` seam to the process streams.
 *  - `monkeypatch.setattr / patch("token_goat.X.y")` → `vi.spyOn(X, "y")`; the
 *    module calls helpers through a static `import * as self`, so the spy is
 *    observed at the boundary.
 *  - functions that hit `_emit_json` / error paths throw `CliExit`; the tests
 *    here that exercise the normal/return paths do NOT throw (verified against
 *    read_commands.ts), so no CliExit wrapping is required for them.
 *  - pytest `tmp_path` / `make_project` / `index_project` fixtures → inline tmp
 *    dirs + `make_project_at` + `await index_project(...)` (async). setup.ts
 *    isolates the data dir per `it()`, so each test builds + indexes fresh.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as read_commands from "../src/token_goat/read_commands.js";
import * as read_replacement from "../src/token_goat/read_replacement.js";
import * as session from "../src/token_goat/session.js";
import * as db from "../src/token_goat/db.js";
import { index_project } from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import type { Project } from "../src/token_goat/project.js";

const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "tests", "fixtures");

// ANSI escapes for dim/reset — module-private in read_commands.ts (the Python
// test imports `_ANSI_DIM` / `_ANSI_RESET` from the module; here they are not
// exported, so the byte-identical constants are inlined for the assertions).
const _ANSI_DIM = "\u001b[2m";
const _ANSI_RESET = "\u001b[0m";

// ---------------------------------------------------------------------------
// stdout / stderr capture + tty toggling helpers
// ---------------------------------------------------------------------------

interface Captured {
  read(): string; // stdout chunks joined
  readErr(): string; // stderr chunks joined
  restore(): void;
}

/** Spy stdout (and stderr) so `_echo` is captured like pytest's capsys. */
function captureStdout(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  });
  return {
    read: () => out.join(""),
    readErr: () => err.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

/** Force `process.stdout.isTTY` for the duration of `fn`, then restore. */
function withTty<T>(value: boolean, fn: () => T): T {
  const prev = process.stdout.isTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = value;
  try {
    return fn();
  } finally {
    (process.stdout as { isTTY?: boolean }).isTTY = prev;
  }
}

/** Python `str.splitlines()` analogue (drops a single trailing empty). */
function splitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// tmp project helpers
// ---------------------------------------------------------------------------

const _tmpRoots: string[] = [];

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-readcmd-${process.pid}-${_tmpRoots.length}-`));
  _tmpRoots.push(dir);
  return dir;
}

function makeProjectAtRoot(root: string): Project {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return make_project_at(root);
}

/** Copy ts_sample → tmp dir, index it; return (proj_root, proj). */
async function indexedTsProject(): Promise<[string, Project]> {
  const base = tmpPath();
  const projRoot = path.join(base, "ts_sample");
  fs.cpSync(path.join(FIXTURE_DIR, "ts_sample"), projRoot, { recursive: true });
  const proj = makeProjectAtRoot(projRoot);
  await index_project(proj, { full: true });
  return [projRoot, proj];
}

afterEach(() => {
  vi.restoreAllMocks();
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// Mock result/file-target builders (mirror the Python MagicMock helpers)
// ---------------------------------------------------------------------------

function makeMockResult(
  args: { text?: string; bytes_total?: number; bytes_extracted?: number } = {},
): Record<string, unknown> {
  const text = args.text ?? "result text";
  const bytes_total = args.bytes_total ?? 1000;
  const bytes_extracted = args.bytes_extracted ?? 50;
  return {
    text,
    start_line: 1,
    end_line: 5,
    bytes_total,
    bytes_extracted,
    bytes_saved: bytes_total - bytes_extracted,
  };
}

function makeMockResultWithSymbol(
  args: { symbol?: string; text?: string; bytes_total?: number; bytes_extracted?: number } = {},
): Record<string, unknown> {
  const symbol = args.symbol ?? "my_func";
  const text = args.text ?? "def my_func(): pass";
  const bytes_total = args.bytes_total ?? 1000;
  const bytes_extracted = args.bytes_extracted ?? 50;
  return {
    symbol,
    text,
    start_line: 1,
    end_line: 5,
    core_start_line: 1,
    core_end_line: 5,
    bytes_total,
    bytes_extracted,
    bytes_saved: bytes_total - bytes_extracted,
  };
}

/** Build a fake _FileTarget (project.hash / project.root are inert here). */
function makeFileTarget(rel_path = "src/foo.py"): read_commands._FileTarget {
  const proj = { hash: "abc123", root: "/tmp/fake-root" } as unknown as Project;
  return { project: proj, rel_path, current_project: proj };
}

// ---------------------------------------------------------------------------
// Item 15 — _emit_text_result header suppression
// ---------------------------------------------------------------------------

describe("_emit_text_result header suppression", () => {
  it("test_emit_no_header_flag_suppresses", () => {
    const cap = captureStdout();
    try {
      withTty(true, () => {
        read_commands._emit_text_result("body text", "src/foo.py", "my_func", "symbol", true);
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain("##");
    expect(out).toContain("body text");
  });

  it("test_emit_tty_shows_header", () => {
    const cap = captureStdout();
    try {
      withTty(true, () => {
        read_commands._emit_text_result("body text", "src/foo.py", "my_func", "symbol", false);
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    const lines = splitlines(out);
    expect(lines[0]).toBe("## src/foo.py — symbol: my_func");
    expect(out).toContain("body text");
  });

  it("test_emit_non_tty_suppresses_header_by_default", () => {
    const cap = captureStdout();
    try {
      withTty(false, () => {
        read_commands._emit_text_result("body text", "src/foo.py", "my_func", "symbol", false);
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain("##");
    expect(out).toContain("body text");
  });

  it("test_emit_section_header_label", () => {
    const cap = captureStdout();
    try {
      withTty(true, () => {
        read_commands._emit_text_result("section body", "README.md", "Install", "heading", false);
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).toContain("## README.md — heading: Install");
  });
});

// ---------------------------------------------------------------------------
// Integration: _run_read_like_command passes no_header correctly
// ---------------------------------------------------------------------------

describe("_run_read_like_command no_header wiring", () => {
  it("test_run_read_like_command_no_header_non_tty", () => {
    const mockResult = makeMockResult();
    const mockReader = vi.fn().mockReturnValue(mockResult);
    const fileTarget = makeFileTarget();

    vi.spyOn(read_commands, "_resolve_file_target").mockReturnValue(fileTarget);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});
    vi.spyOn(session, "mark_file_read").mockImplementation((() => undefined) as never);

    const cap = captureStdout();
    try {
      withTty(false, () => {
        read_commands._run_read_like_command({
          target: "src/foo.py::my_func",
          session_id: null,
          json_output: false,
          context_lines: 0,
          separator_label: "symbol",
          missing_label: "Symbol",
          stat_kind: "read_replacement",
          reader: mockReader as never,
          no_header: true,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain("##");
    expect(out).toContain("result text");
  });

  it("test_run_read_like_command_with_header_tty", () => {
    const mockResult = makeMockResult();
    const mockReader = vi.fn().mockReturnValue(mockResult);
    const fileTarget = makeFileTarget();

    vi.spyOn(read_commands, "_resolve_file_target").mockReturnValue(fileTarget);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});
    vi.spyOn(session, "mark_file_read").mockImplementation((() => undefined) as never);

    const cap = captureStdout();
    try {
      withTty(true, () => {
        read_commands._run_read_like_command({
          target: "src/foo.py::my_func",
          session_id: null,
          json_output: false,
          context_lines: 0,
          separator_label: "symbol",
          missing_label: "Symbol",
          stat_kind: "read_replacement",
          reader: mockReader as never,
          no_header: false,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    const lines = splitlines(out);
    expect(lines[0]).toBe("## src/foo.py — symbol: my_func");
    expect(out).toContain("result text");
  });
});

// ---------------------------------------------------------------------------
// _apply_context_gutter — context line visual distinction
// ---------------------------------------------------------------------------

describe("_apply_context_gutter", () => {
  it("test_apply_context_gutter_no_context", () => {
    const text = "line1\nline2\nline3";
    const result = read_commands._apply_context_gutter(text, 0, 0, { no_color: false });
    expect(result).toBe(text);
  });

  it("test_apply_context_gutter_no_color_passthrough", () => {
    const text = "ctx1\nbody1\nbody2\nctx2";
    const result = read_commands._apply_context_gutter(text, 1, 1, { no_color: true });
    expect(result).toBe(text);
  });

  it("test_apply_context_gutter_dims_before_and_after", () => {
    const text = "ctx_before\nbody_line\nctx_after";
    const result = read_commands._apply_context_gutter(text, 1, 1, { no_color: false });
    const lines = result.split("\n");
    expect(lines[0]).toContain(_ANSI_DIM);
    expect(lines[0]).toContain("ctx_before");
    expect(lines[0]).toContain(_ANSI_RESET);
    expect(lines[1]).not.toContain(_ANSI_DIM);
    expect(lines[1]).toContain("body_line");
    expect(lines[2]).toContain(_ANSI_DIM);
    expect(lines[2]).toContain("ctx_after");
    expect(lines[2]).toContain(_ANSI_RESET);
  });

  it("test_apply_context_gutter_only_before", () => {
    const text = "ctx1\nctx2\nbody";
    const result = read_commands._apply_context_gutter(text, 2, 0, { no_color: false });
    const lines = result.split("\n");
    expect(lines[0]).toContain(_ANSI_DIM);
    expect(lines[1]).toContain(_ANSI_DIM);
    expect(lines[2]).not.toContain(_ANSI_DIM);
  });

  it("test_apply_context_gutter_only_after", () => {
    const text = "body\nctx1\nctx2";
    const result = read_commands._apply_context_gutter(text, 0, 2, { no_color: false });
    const lines = result.split("\n");
    expect(lines[0]).not.toContain(_ANSI_DIM);
    expect(lines[1]).toContain(_ANSI_DIM);
    expect(lines[2]).toContain(_ANSI_DIM);
  });

  it("test_emit_text_result_context_gutter_on_tty", () => {
    const cap = captureStdout();
    try {
      withTty(true, () => {
        read_commands._emit_text_result("before\nbody\nafter", "src/foo.py", "my_func", "symbol", true, {
          context_before: 1,
          context_after: 1,
          no_color: false,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).toContain(_ANSI_DIM);
    expect(out).toContain("before");
    expect(out).toContain("body");
    expect(out).toContain("after");
  });

  it("test_emit_text_result_no_color_suppresses_ansi", () => {
    const cap = captureStdout();
    try {
      withTty(true, () => {
        read_commands._emit_text_result("before\nbody\nafter", "src/foo.py", "my_func", "symbol", true, {
          context_before: 1,
          context_after: 1,
          no_color: true,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain(_ANSI_DIM);
    expect(out).toContain("before\nbody\nafter");
  });

  it("test_emit_text_result_non_tty_no_ansi", () => {
    const cap = captureStdout();
    try {
      withTty(false, () => {
        read_commands._emit_text_result("before\nbody\nafter", "src/foo.py", "my_func", "symbol", true, {
          context_before: 1,
          context_after: 1,
          no_color: false,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain(_ANSI_DIM);
  });
});

// ---------------------------------------------------------------------------
// _context_bounds — derive context_before / context_after from result dict
// ---------------------------------------------------------------------------

describe("_context_bounds", () => {
  it("test_context_bounds_no_context", () => {
    const result = { start_line: 5, end_line: 10, core_start_line: 5, core_end_line: 10 };
    expect(read_commands._context_bounds(result)).toEqual([0, 0]);
  });

  it("test_context_bounds_with_context", () => {
    const result = { start_line: 3, end_line: 12, core_start_line: 5, core_end_line: 10 };
    expect(read_commands._context_bounds(result)).toEqual([2, 2]);
  });

  it("test_context_bounds_missing_core_fields", () => {
    const result = { start_line: 5, end_line: 10 };
    expect(read_commands._context_bounds(result)).toEqual([0, 0]);
  });

  it("test_context_bounds_asymmetric", () => {
    const result = { start_line: 1, end_line: 15, core_start_line: 4, core_end_line: 12 };
    expect(read_commands._context_bounds(result)).toEqual([3, 3]);
  });
});

// ---------------------------------------------------------------------------
// read_symbol — core_start_line / core_end_line in SymbolResult
// ---------------------------------------------------------------------------

describe("read_symbol core lines", () => {
  it("test_read_symbol_core_lines_no_context", async () => {
    const [, proj] = await indexedTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "greet", { context_lines: 0 }) as
      | Record<string, unknown>
      | null;
    expect(result).not.toBeNull();
    expect(result!["core_start_line"]).toBe(result!["start_line"]);
    expect(result!["core_end_line"]).toBe(result!["end_line"]);
  });

  it("test_read_symbol_core_lines_with_context", async () => {
    const [, proj] = await indexedTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "greet", { context_lines: 2 }) as
      | Record<string, unknown>
      | null;
    expect(result).not.toBeNull();
    expect(Number(result!["core_start_line"])).toBeGreaterThanOrEqual(Number(result!["start_line"]));
    expect(Number(result!["core_end_line"])).toBeLessThanOrEqual(Number(result!["end_line"]));
    expect(Number(result!["core_start_line"])).toBeLessThanOrEqual(Number(result!["core_end_line"]));
  });
});

// ---------------------------------------------------------------------------
// _run_read_like_command --no-color
// ---------------------------------------------------------------------------

describe("_run_read_like_command no_color", () => {
  it("test_run_read_like_command_no_color_flag", () => {
    const mockResult = {
      text: "before\nbody\nafter",
      start_line: 3,
      end_line: 7,
      core_start_line: 4,
      core_end_line: 6,
      bytes_total: 1000,
      bytes_extracted: 50,
      bytes_saved: 950,
    };
    const mockReader = vi.fn().mockReturnValue(mockResult);
    const fileTarget = makeFileTarget();

    vi.spyOn(read_commands, "_resolve_file_target").mockReturnValue(fileTarget);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});
    vi.spyOn(session, "mark_file_read").mockImplementation((() => undefined) as never);

    const cap = captureStdout();
    try {
      withTty(true, () => {
        read_commands._run_read_like_command({
          target: "src/foo.py::my_func",
          session_id: null,
          json_output: false,
          context_lines: 1,
          separator_label: "symbol",
          missing_label: "Symbol",
          stat_kind: "read_replacement",
          reader: mockReader as never,
          no_header: true,
          no_color: true,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain(_ANSI_DIM);
    expect(out).toContain("before\nbody\nafter");
  });
});

// ---------------------------------------------------------------------------
// stub_view — regression for start_line vs line column name
// ---------------------------------------------------------------------------

describe("stub_view", () => {
  it("test_stub_view_returns_symbols", async () => {
    const [projRoot, proj] = await indexedTsProject();

    // Pick the first file that has at least one indexed symbol.
    const row = db.openProjectReadonly(proj.hash, (conn) => {
      return conn
        .prepare("SELECT file_rel FROM symbols WHERE end_line IS NOT NULL LIMIT 1")
        .get() as { file_rel?: string } | undefined;
    });
    expect(row).not.toBeUndefined();
    const fileRel = String(row!.file_rel);

    // stub_view resolves via find_project(process.cwd()); chdir into the project
    // so resolution finds it (mirrors the Python monkeypatch.chdir).
    const prevCwd = process.cwd();
    process.chdir(projRoot);
    const cap = captureStdout();
    try {
      read_commands.stub_view(path.join(projRoot, fileRel), { json_output: false });
    } finally {
      cap.restore();
      process.chdir(prevCwd);
    }
    const out = cap.read();
    expect(out).not.toContain("No indexed symbols found");
    expect(out).toContain("Skeleton:");
  });
});

// ---------------------------------------------------------------------------
// Cross-reference footer wiring in _run_read_like_command
// ---------------------------------------------------------------------------

describe("callers footer wiring", () => {
  it("test_callers_footer_appended_in_text_mode", () => {
    const mockResult = makeMockResultWithSymbol();
    const mockReader = vi.fn().mockReturnValue(mockResult);
    const fileTarget = makeFileTarget();

    vi.spyOn(read_commands, "_resolve_file_target").mockReturnValue(fileTarget);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});
    vi.spyOn(session, "mark_file_read").mockImplementation((() => undefined) as never);
    vi.spyOn(read_replacement, "format_callers_footer").mockReturnValue("Refs: bar.py:42");

    const cap = captureStdout();
    try {
      withTty(false, () => {
        read_commands._run_read_like_command({
          target: "src/foo.py::my_func",
          session_id: null,
          json_output: false,
          context_lines: 0,
          separator_label: "symbol",
          missing_label: "Symbol",
          stat_kind: "read_replacement",
          reader: mockReader as never,
          no_header: true,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).toContain("Refs: bar.py:42");
    expect(out).toContain("my_func");
  });

  it("test_callers_footer_absent_in_json_mode", () => {
    const mockResult = makeMockResultWithSymbol();
    const mockReader = vi.fn().mockReturnValue(mockResult);
    const fileTarget = makeFileTarget();

    vi.spyOn(read_commands, "_resolve_file_target").mockReturnValue(fileTarget);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});
    vi.spyOn(session, "mark_file_read").mockImplementation((() => undefined) as never);
    vi.spyOn(read_replacement, "format_callers_footer").mockReturnValue("Refs: bar.py:42");

    const cap = captureStdout();
    try {
      withTty(false, () => {
        read_commands._run_read_like_command({
          target: "src/foo.py::my_func",
          session_id: null,
          json_output: true,
          context_lines: 0,
          separator_label: "symbol",
          missing_label: "Symbol",
          stat_kind: "read_replacement",
          reader: mockReader as never,
          no_header: true,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    const data = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(String(data["text"] ?? "")).not.toContain("Refs:");
    expect(out).not.toContain("Refs:");
  });

  it("test_callers_footer_absent_when_no_callers", () => {
    const mockResult = makeMockResultWithSymbol();
    const mockReader = vi.fn().mockReturnValue(mockResult);
    const fileTarget = makeFileTarget();

    vi.spyOn(read_commands, "_resolve_file_target").mockReturnValue(fileTarget);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});
    vi.spyOn(session, "mark_file_read").mockImplementation((() => undefined) as never);
    vi.spyOn(read_replacement, "format_callers_footer").mockReturnValue("");

    const cap = captureStdout();
    try {
      withTty(false, () => {
        read_commands._run_read_like_command({
          target: "src/foo.py::my_func",
          session_id: null,
          json_output: false,
          context_lines: 0,
          separator_label: "symbol",
          missing_label: "Symbol",
          stat_kind: "read_replacement",
          reader: mockReader as never,
          no_header: true,
        });
      });
    } finally {
      cap.restore();
    }
    const out = cap.read();
    expect(out).not.toContain("Refs:");
    expect(out).toContain("my_func");
  });

  it("test_callers_footer_not_called_for_section", () => {
    const mockResult = makeMockResultWithSymbol({ text: "section body" });
    const mockReader = vi.fn().mockReturnValue(mockResult);
    const fileTarget = makeFileTarget();
    const mockFooter = vi.fn().mockReturnValue("Refs: bar.py:1");

    vi.spyOn(read_commands, "_resolve_file_target").mockReturnValue(fileTarget);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});
    vi.spyOn(session, "mark_file_read").mockImplementation((() => undefined) as never);
    vi.spyOn(read_replacement, "format_callers_footer").mockImplementation(mockFooter as never);

    const cap = captureStdout();
    try {
      withTty(false, () => {
        read_commands._run_read_like_command({
          target: "README.md::Install",
          session_id: null,
          json_output: false,
          context_lines: 0,
          separator_label: "heading",
          missing_label: "Section",
          stat_kind: "section_replacement",
          reader: mockReader as never,
          no_header: true,
        });
      });
    } finally {
      cap.restore();
    }
    expect(mockFooter).not.toHaveBeenCalled();
    const out = cap.read();
    expect(out).not.toContain("Refs:");
  });
});
