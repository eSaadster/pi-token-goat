/**
 * Tests for the INI / CFG / .env language extractor.
 *
 * 1:1 port of tests/test_ini_extractor.py. Strict NodeNext ESM.
 *
 * Port notes
 * -----------
 *  - TestIniSections / TestEnvExtractor: pure ini_idx.extract / extract_env
 *    unit tests — straight port, Buffer inputs, destructured 4-tuples.
 *  - TestBasenameDispatch: Python used `tmp_data_dir` + `tmp_path` fixtures and
 *    `parser.index_file`. The TS port uses a per-test realpath'd mkdtemp dir and
 *    constructs a `Project` object literal (`{ root, hash, marker }`) from
 *    `canonicalize` + `project_hash`, then calls the async `index_file`
 *    (the TS `index_file` is async because get_extractor uses a dynamic import).
 *    A `.git` dir is created under the tmp root so the project resolves cleanly.
 *  - The Python tests passed the raw `tmp_path` to `canonicalize`; the TS port
 *    passes the realpath'd tmp dir (macOS /var -> /private/var parity), which is
 *    the equivalent canonical root.
 */
import { beforeEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as ini_idx from "../src/token_goat/languages/ini_idx.js";
import * as parser from "../src/token_goat/parser.js";
import { canonicalize, project_hash, type Project } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// Shared per-test tmp dir (Python's tmp_path fixture analogue).
// ---------------------------------------------------------------------------

let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-ini-")));
});

/** Build a Project rooted at the (canonicalized) tmp dir with a .git marker. */
async function makeProject(): Promise<{ root: string; proj: Project }> {
  fs.mkdirSync(path.join(tmpPath, ".git"), { recursive: true });
  const root = canonicalize(tmpPath);
  const proj: Project = { root, hash: project_hash(root), marker: ".git" };
  return { root, proj };
}

// ===========================================================================
// TestIniSections
// ===========================================================================

describe("TestIniSections", () => {
  it("test_simple_sections", () => {
    const src = Buffer.from(
      "\n[install]\nprefix = /usr/local\n\n[uninstall]\nyes = true\n",
    );
    const [symbols, refs, imps, sections] = ini_idx.extract(src, "setup.cfg");
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("install");
    expect(headings).toContain("uninstall");
    // Section start lines are 1-based.
    const installSec = sections.find((s) => s.heading === "install")!;
    expect(installSec.line).toBe(2);
    expect(installSec.end_line).not.toBeNull();
    expect(installSec.end_line!).toBeLessThan(sections[1]!.line);
  });

  it("test_dotted_and_colon_names", () => {
    const src = Buffer.from(
      "[tool.black]\nline-length = 100\n\n[mysqld:replica]\nport = 3307\n",
    );
    const sections = ini_idx.extract(src, "x.ini")[3];
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("tool.black");
    expect(headings).toContain("mysqld:replica");
  });

  it("test_comment_after_header_tolerated", () => {
    const src = Buffer.from("[main]  ; production block\nport = 80\n");
    const sections = ini_idx.extract(src, "x.ini")[3];
    expect(sections.map((s) => s.heading)).toEqual(["main"]);
  });

  it("test_malformed_header_skipped", () => {
    const src = Buffer.from("[unclosed\nport = 80\n[ok]\nfoo = bar\n");
    const sections = ini_idx.extract(src, "x.ini")[3];
    expect(sections.map((s) => s.heading)).toEqual(["ok"]);
  });

  it("test_empty_file_yields_nothing", () => {
    const sections = ini_idx.extract(Buffer.from(""), "x.ini")[3];
    expect(sections).toEqual([]);
  });
});

// ===========================================================================
// TestEnvExtractor
// ===========================================================================

describe("TestEnvExtractor", () => {
  it("test_top_level_keys", () => {
    const src = Buffer.from(
      "DATABASE_URL=postgres://localhost/db\nDEBUG=1\nAPI_KEY: secret\n",
    );
    const [symbols, refs, imps, sections] = ini_idx.extract_env(src, ".env");
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    expect(sections).toEqual([]);
    const names = symbols.map((s) => s.name);
    expect(names).toEqual(["DATABASE_URL", "DEBUG", "API_KEY"]);
  });

  it("test_comments_and_blank_lines_skipped", () => {
    const src = Buffer.from("# leading comment\n\nFOO=1\n; second style\nBAR=2\n");
    const symbols = ini_idx.extract_env(src, ".env")[0];
    expect(symbols.map((s) => s.name)).toEqual(["FOO", "BAR"]);
  });

  it("test_indented_lines_skipped", () => {
    // Indented lines are continuation/heredoc bodies, never new keys.
    const src = Buffer.from("VAR=hello\n  CONTINUATION\nNEXT=world\n");
    const symbols = ini_idx.extract_env(src, ".env")[0];
    expect(symbols.map((s) => s.name)).toEqual(["VAR", "NEXT"]);
  });

  it("test_line_numbers_are_one_based", () => {
    const src = Buffer.from("# header\nFOO=1\nBAR=2\n");
    const symbols = ini_idx.extract_env(src, ".env")[0];
    const foo = symbols.find((s) => s.name === "FOO")!;
    const bar = symbols.find((s) => s.name === "BAR")!;
    expect(foo.line).toBe(2);
    expect(bar.line).toBe(3);
  });
});

// ===========================================================================
// TestBasenameDispatch
// ===========================================================================

describe("TestBasenameDispatch", () => {
  it("test_env_dotfile_resolves_to_env_language", async () => {
    // `.env` has no Path.suffix; it must dispatch via basename lookup.
    const { proj } = await makeProject();
    const envPath = path.join(tmpPath, ".env");
    fs.writeFileSync(envPath, "DATABASE_URL=x\nDEBUG=1\n", "utf-8");
    const result = await parser.index_file(proj, envPath);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("env");
    expect(result!.symbols.map((s) => s.name)).toEqual([
      "DATABASE_URL",
      "DEBUG",
    ]);
  });

  it("test_setup_cfg_resolves_to_ini_language", async () => {
    const { proj } = await makeProject();
    const p = path.join(tmpPath, "setup.cfg");
    fs.writeFileSync(
      p,
      "[metadata]\nname = pkg\n\n[options]\npackages = find\n",
      "utf-8",
    );
    const result = await parser.index_file(proj, p);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("ini");
    const headings = new Set(result!.sections.map((s) => s.heading));
    expect(headings.has("metadata")).toBe(true);
    expect(headings.has("options")).toBe(true);
  });
});
