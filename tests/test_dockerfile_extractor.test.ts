/**
 * Tests for the Dockerfile language extractor + basename dispatch.
 *
 * 1:1 port of tests/test_dockerfile_extractor.py. Strict NodeNext ESM.
 *
 * Port notes
 * -----------
 *  - TestDockerfileExtractor: pure dockerfile_idx.extract unit tests.
 *  - TestBasenameDispatch: Python used `tmp_data_dir` + `tmp_path` fixtures,
 *    `canonicalize(tmp_path)`, and `parser.index_file`. The TS port uses a per-
 *    test realpath'd mkdtemp dir, builds a `Project` object literal from
 *    `canonicalize` + `project_hash` (the Python `Project(root=..., hash=...,
 *    marker=".git")` ctor is a plain dataclass -> TS interface), creates a
 *    `.git` marker dir, and calls the async `index_file` (TS get_extractor uses
 *    a dynamic adapter import, so index_file is async).
 */
import { beforeEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as dockerfile_idx from "../src/token_goat/languages/dockerfile_idx.js";
import * as parser from "../src/token_goat/parser.js";
import { canonicalize, project_hash, type Project } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// Shared per-test tmp dir (Python's tmp_path fixture analogue).
// ---------------------------------------------------------------------------

let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-docker-")));
});

/** Build a Project rooted at the (canonicalized) tmp dir with a .git marker. */
function makeProject(): { root: string; proj: Project } {
  fs.mkdirSync(path.join(tmpPath, ".git"), { recursive: true });
  const root = canonicalize(tmpPath);
  const proj: Project = { root, hash: project_hash(root), marker: ".git" };
  return { root, proj };
}

// ===========================================================================
// TestDockerfileExtractor
// ===========================================================================

describe("TestDockerfileExtractor", () => {
  it("test_named_stages", () => {
    const src = Buffer.from(
      "FROM python:3.11 AS builder\nRUN pip install build\nCOPY . /app\n\nFROM python:3.11-slim AS runtime\nCOPY --from=builder /app /app\nCMD [\"python\", \"main.py\"]\n",
    );
    const [symbols, refs, imps, sections] = dockerfile_idx.extract(
      src,
      "Dockerfile",
    );
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    const headings = sections.map((s) => s.heading);
    expect(headings).toEqual(["builder", "runtime"]);
    const builder = sections.find((s) => s.heading === "builder")!;
    const runtime = sections.find((s) => s.heading === "runtime")!;
    expect(builder.line).toBe(1);
    expect(runtime.line).toBeGreaterThan(builder.line);
    expect(builder.end_line).not.toBeNull();
    expect(builder.end_line!).toBeLessThan(runtime.line);
  });

  it("test_unnamed_stage_uses_image_ref", () => {
    const src = Buffer.from("FROM alpine:3.18\nRUN apk add curl\n");
    const sections = dockerfile_idx.extract(src, "Dockerfile")[3];
    expect(sections.map((s) => s.heading)).toEqual(["alpine:3.18"]);
  });

  it("test_case_insensitive_keyword", () => {
    // `from` and `FROM` and `From` are all recognised.
    const src = Buffer.from("from node:20\n");
    const sections = dockerfile_idx.extract(src, "Dockerfile")[3];
    expect(sections.map((s) => s.heading)).toEqual(["node:20"]);
  });

  it("test_comments_after_from", () => {
    const src = Buffer.from("FROM python:3.11 AS builder  # build stage\n");
    const sections = dockerfile_idx.extract(src, "Dockerfile")[3];
    expect(sections.map((s) => s.heading)).toEqual(["builder"]);
  });

  it("test_no_from_yields_empty", () => {
    const src = Buffer.from("# nothing here\nRUN echo hi\n");
    const sections = dockerfile_idx.extract(src, "Dockerfile")[3];
    expect(sections).toEqual([]);
  });
});

// ===========================================================================
// TestBasenameDispatch
//
// Verify Dockerfile-family files dispatch through the basename table. The file
// path passed to index_file is built off canonicalize(tmp_path) rather than the
// raw tmp_path so the drive-letter case matches the project root on Windows.
// Without this, Path.relative_to on Windows raises ValueError when the cases
// differ (it is case-sensitive even though the FS is not), which would make
// index_file return None and the test fail with an unhelpful "result is None"
// assertion.
// ===========================================================================

describe("TestBasenameDispatch", () => {
  it("test_dockerfile_resolves_via_basename", async () => {
    const { root, proj } = makeProject();
    const df = path.join(root, "Dockerfile");
    fs.writeFileSync(
      df,
      "FROM python:3.11 AS builder\nRUN pip install build\n",
      "utf-8",
    );
    const result = await parser.index_file(proj, df);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("dockerfile");
    expect(result!.sections.map((s) => s.heading)).toEqual(["builder"]);
  });

  it("test_containerfile_resolves_via_basename", async () => {
    const { root, proj } = makeProject();
    const cf = path.join(root, "Containerfile");
    fs.writeFileSync(cf, "FROM alpine\n", "utf-8");
    const result = await parser.index_file(proj, cf);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("dockerfile");
  });

  it("test_dockerfile_suffix_resolves", async () => {
    const { root, proj } = makeProject();
    const df = path.join(root, "service.dockerfile");
    fs.writeFileSync(df, "FROM busybox\n", "utf-8");
    const result = await parser.index_file(proj, df);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("dockerfile");
  });
});
