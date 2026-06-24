/**
 * Tests for compact-hint CLI enhancements: --diff, --sections, --score, --auto,
 * --watch — TS port of tests/test_compact_hint_cli.py.
 *
 * setup.ts isolates the data dir per test, so `_makeSession` (the TS analogue of
 * conftest's `_make_session` factory) writes real session JSON under <tmp>/
 * sessions/. CLI assertions go through the in-process CliRunner (`invoke`); the
 * lib-level tests call compact/paths directly; the --watch tests call
 * `cliSessions._compact_hint_watch` directly with `compact.build_manifest` and
 * the module's `sleep` boundary spied (the analogue of Python's
 * `mock.patch.object(compact, "build_manifest")` + `mock.patch("...cli.time.sleep")`).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { invoke } from "./_cli_runner.js";
import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import * as bash_cache from "../src/token_goat/bash_cache.js";
import * as paths from "../src/token_goat/paths.js";
import * as cliSessions from "../src/token_goat/cli_sessions.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers — TS port of conftest._make_session.
// ---------------------------------------------------------------------------

interface MakeSessionOpts {
  age_seconds?: number;
  files_read?: number;
  greps?: number;
  edits?: number;
  web_fetches?: Record<string, number> | null;
  bash_runs?: Record<string, [number, number]> | null;
}

function _makeSession(
  session_id: string,
  o: MakeSessionOpts = {},
): session.SessionCache {
  const {
    age_seconds = 0,
    files_read = 0,
    greps = 0,
    edits = 0,
    web_fetches = null,
    bash_runs = null,
  } = o;

  const cache = session.load(session_id);

  if (age_seconds > 0) {
    cache.created_ts = Date.now() / 1000 - age_seconds;
    session.save(cache);
  }

  for (let i = 0; i < files_read; i++) {
    session.mark_file_read(session_id, `/proj/src/file${i}.py`, 0, 100);
  }
  for (let i = 0; i < greps; i++) {
    session.mark_grep(session_id, `pattern${i}`, "/proj/src");
  }
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(session_id, `/proj/src/edited${i}.py`);
  }
  if (web_fetches) {
    for (const [url, body_bytes] of Object.entries(web_fetches)) {
      const url_sha = createHash("sha256").update(url).digest("hex").slice(0, 12);
      session.mark_web_fetch(session_id, url_sha, url.slice(0, 200), `web-${url_sha}`, body_bytes, 200, false);
    }
  }
  if (bash_runs) {
    for (const [cmd, [output_bytes, exit_code]] of Object.entries(bash_runs)) {
      const cmd_sha = bash_cache.command_hash(cmd);
      session.mark_bash_run(session_id, cmd_sha, cmd, `out-${cmd_sha}`, output_bytes, 0, exit_code, false);
    }
  }

  return session.load(session_id);
}

/** Capture process.stdout writes while running `fn` (capsys analogue). */
async function captureOut(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown): boolean => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8"));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// find_latest_session_id
// ---------------------------------------------------------------------------

describe("TestFindLatestSessionId", () => {
  it("test_returns_none_when_no_sessions", () => {
    expect(compact.find_latest_session_id()).toBeNull();
  });

  it("test_returns_latest_session", () => {
    const sid1 = "find-latest-alpha";
    const sid2 = "find-latest-beta";

    session.mark_file_read(sid1, "/proj/a.py", 0, 10);
    session.mark_file_read(sid2, "/proj/b.py", 0, 10);

    // Force distinct mtimes without sleeping: stamp sid2's file 1 s ahead.
    const sessionsDir = paths.sessionsDir();
    const f2 = path.join(sessionsDir, `${sid2}.json`);
    const f1 = path.join(sessionsDir, `${sid1}.json`);
    const t1 = fs.statSync(f1).mtimeMs / 1000;
    fs.utimesSync(f2, t1 + 1.0, t1 + 1.0);

    expect(compact.find_latest_session_id()).toBe(sid2);
  });

  it("test_returns_only_session_when_one_exists", () => {
    const sid = "find-latest-only";
    session.mark_file_read(sid, "/proj/c.py", 0, 10);
    expect(compact.find_latest_session_id()).toBe(sid);
  });

  it("test_returns_none_when_sessions_dir_missing", () => {
    // Sessions dir doesn't exist yet (empty tmp dir)
    expect(compact.find_latest_session_id()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// --session-id auto / --auto flag
// ---------------------------------------------------------------------------

describe("TestAutoSessionDetection", () => {
  it("test_auto_flag_detects_session", async () => {
    _makeSession("auto-detect-session-xyz", { files_read: 2, edits: 1 });
    const r = await invoke(["compact-hint", "--auto"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("auto-detected session");
  });

  it("test_session_id_auto_keyword_detects_session", async () => {
    _makeSession("auto-keyword-session-xyz", { files_read: 2, edits: 1 });
    const r = await invoke(["compact-hint", "--session-id", "auto"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("auto-detected session");
  });

  it("test_auto_fails_gracefully_when_no_sessions", async () => {
    const r = await invoke(["compact-hint", "--auto"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("No session files found");
  });

  it("test_explicit_session_id_still_works", async () => {
    const sid = "explicit-session-id-xyz";
    _makeSession(sid, { files_read: 2, edits: 1 });
    const r = await invoke(["compact-hint", "--session-id", sid]);
    expect(r.exit_code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _parse_manifest_sections
// ---------------------------------------------------------------------------

describe("TestParseManifestSections", () => {
  it("test_empty_manifest_returns_empty_list", () => {
    expect(compact._parse_manifest_sections("")).toEqual([]);
  });

  it("test_parses_hash_headings", () => {
    const manifest = "### Files Edited\n- file.py\n\n### Commands\n- pytest\n";
    const sections = compact._parse_manifest_sections(manifest);
    const names = sections.map((s) => s[0]);
    expect(names).toContain("Files Edited");
    expect(names).toContain("Commands");
  });

  it("test_non_empty_section_not_flagged_empty", () => {
    const manifest = "### Files Edited\n- file.py\n";
    const sections = compact._parse_manifest_sections(manifest);
    for (const [name, , is_empty] of sections) {
      if (name.includes("Files Edited")) {
        expect(is_empty).toBe(false);
        break;
      }
    }
  });

  it("test_empty_section_flagged", () => {
    const manifest = "### Empty Section\n\n### Non Empty\n- content\n";
    const sections = compact._parse_manifest_sections(manifest);
    for (const [name, , is_empty] of sections) {
      if (name.includes("Empty Section")) {
        expect(is_empty).toBe(true);
        break;
      }
    }
  });

  it("test_token_counts_are_positive", () => {
    const manifest = "### Section One\n- a line with some content here\n";
    const sections = compact._parse_manifest_sections(manifest);
    for (const [, tokens] of sections) {
      expect(tokens).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// _score_manifest_breakdown
// ---------------------------------------------------------------------------

describe("TestScoreManifestBreakdown", () => {
  it("test_empty_returns_empty_dict", () => {
    expect(compact._score_manifest_breakdown([])).toEqual({});
  });

  it("test_edited_section_contributes_points", () => {
    const section = "**Edited**:\n- file.py\n- other.py\n";
    const breakdown = compact._score_manifest_breakdown([section]);
    expect(breakdown).toHaveProperty("**Edited**");
    expect(breakdown["**Edited**"]).toBeGreaterThan(0);
  });

  it("test_bash_section_contributes_points", () => {
    const section = "**Bash**:\n- pytest tests/\n";
    const breakdown = compact._score_manifest_breakdown([section]);
    expect(breakdown).toHaveProperty("**Bash**");
    expect(breakdown["**Bash**"]).toBeGreaterThan(0);
  });

  it("test_sum_matches_score_manifest", () => {
    const sections = [
      "**Edited**:\n- a.py\n- b.py\n",
      "**Bash**:\n- pytest\n",
      "**Symbols**:\n- MyClass\n",
    ];
    const total_from_score = compact._score_manifest(sections);
    const breakdown = compact._score_manifest_breakdown(sections);
    const total_from_breakdown = Object.values(breakdown).reduce((a, b) => a + b, 0);
    expect(total_from_score).toBe(total_from_breakdown);
  });

  it("test_no_double_counting_across_sections", () => {
    // Symbols in edited section should score as edited (10), not also symbols (2)
    const section = "**Edited**:\n- file.py\n";
    const breakdown = compact._score_manifest_breakdown([section]);
    expect(breakdown).toHaveProperty("**Edited**");
    expect(breakdown["**Symbols**"] ?? 0).toBe(0);
  });

  it("test_failure_line_scores_once_not_twice", () => {
    const section = "**Bash**:\n- ✗ pytest tests/  (exit 1)\n";
    const score = compact._score_manifest([section]);
    // +3 for Bash line, +5 for ✗ marker = 8
    expect(score).toBe(8);
  });

  it("test_score_manifest_breakdown_failure_line", () => {
    const section = "**Bash**:\n- ✗ pytest tests/  (exit 1)\n- run.sh\n";
    const total_score = compact._score_manifest([section]);
    const breakdown = compact._score_manifest_breakdown([section]);
    const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBe(total_score);
  });
});

// ---------------------------------------------------------------------------
// compact-hint --sections flag
// ---------------------------------------------------------------------------

describe("TestCompactHintSections", () => {
  it("test_sections_flag_shows_section_names", async () => {
    const sid = "sections-test-session-abc";
    _makeSession(sid, { files_read: 3, edits: 2, greps: 1 });

    const r = await invoke(["compact-hint", "--session-id", sid, "--sections"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("tokens");
  });

  it("test_sections_flag_no_manifest", async () => {
    const r = await invoke([
      "compact-hint",
      "--session-id",
      "no-activity-session-abc",
      "--sections",
    ]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("no manifest");
  });

  it("test_sections_includes_empty_flag_annotation", async () => {
    const sid = "sections-empty-test-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const r = await invoke(["compact-hint", "--session-id", sid, "--sections"]);
    expect(r.exit_code).toBe(0);
    const lines = r.output.split("\n");
    const token_lines = lines.filter((ln) => ln.toLowerCase().includes("token"));
    expect(token_lines.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// compact-hint --score flag
// ---------------------------------------------------------------------------

describe("TestCompactHintScore", () => {
  it("test_score_flag_shows_quality_score", async () => {
    const sid = "score-test-session-abc";
    _makeSession(sid, { files_read: 3, edits: 2, greps: 1 });

    const r = await invoke(["compact-hint", "--session-id", sid, "--score"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("Quality score");
  });

  it("test_score_shows_noop_status", async () => {
    const sid = "score-noop-test-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const r = await invoke(["compact-hint", "--session-id", sid, "--score"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("Noop fast-path");
  });

  it("test_score_shows_activity_floor", async () => {
    const sid = "score-floor-test-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const r = await invoke(["compact-hint", "--session-id", sid, "--score"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("floor=");
  });

  it("test_score_empty_session_shows_zero", async () => {
    const r = await invoke([
      "compact-hint",
      "--session-id",
      "no-activity-session-xyz",
      "--score",
    ]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("0");
  });
});

// ---------------------------------------------------------------------------
// compact-hint --diff flag
// ---------------------------------------------------------------------------

describe("TestCompactHintDiff", () => {
  it("test_diff_no_prior_sidecar", async () => {
    const sid = "diff-no-prior-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const r = await invoke(["compact-hint", "--session-id", sid, "--diff"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("No previous manifest");
  });

  it("test_diff_unchanged_shows_no_changes", async () => {
    const sid = "diff-unchanged-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    // Write the text sidecar manually to simulate a prior emit
    const manifest_text = compact.build_manifest(sid);
    if (manifest_text) {
      const text_sidecar = paths.manifestTextSidecarPath(sid);
      paths.ensureDir(path.dirname(text_sidecar));
      paths.atomicWriteText(text_sidecar, manifest_text);

      const r = await invoke(["compact-hint", "--session-id", sid, "--diff"]);
      expect(r.exit_code).toBe(0);
      const lower = r.output.toLowerCase();
      expect(lower.includes("unchanged") || lower.includes("no diff")).toBe(true);
    }
  });

  it("test_diff_shows_additions_with_plus_prefix", async () => {
    const sid = "diff-additions-abc";
    _makeSession(sid, { files_read: 3, edits: 2 });

    // Write a short synthetic "prior" manifest so it differs from the current one
    const prior_text =
      "## Token-Goat Session Manifest\nSession: prior\n- prior line only\n";
    const text_sidecar = paths.manifestTextSidecarPath(sid);
    paths.ensureDir(path.dirname(text_sidecar));
    paths.atomicWriteText(text_sidecar, prior_text);

    const r = await invoke(["compact-hint", "--session-id", sid, "--diff"]);
    expect(r.exit_code).toBe(0);
    const output_lines = r.output.split("\n");
    const has_diff_lines = output_lines.some(
      (ln) => ln.startsWith("+") || ln.startsWith("-"),
    );
    expect(has_diff_lines).toBe(true);
  });

  it("test_diff_text_sidecar_written_by_build_manifest", () => {
    const sid = "diff-sidecar-written-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const manifest_text = compact.build_manifest(sid);
    const text_sidecar = paths.manifestTextSidecarPath(sid);
    if (manifest_text) {
      expect(fs.existsSync(text_sidecar)).toBe(true);
      const stored = fs.readFileSync(text_sidecar, "utf-8");
      expect(stored).toBe(manifest_text);
    }
  });
});

// ---------------------------------------------------------------------------
// manifest_text_sidecar_path in paths.py
// ---------------------------------------------------------------------------

describe("TestManifestTextSidecarPath", () => {
  it("test_path_is_under_sentinels", () => {
    const p = paths.manifestTextSidecarPath("my-session-id");
    expect(p).toContain("sentinels");
    expect(path.basename(p)).toContain("manifest_text_");
  });

  it("test_path_ends_with_txt", () => {
    const p = paths.manifestTextSidecarPath("my-session-id");
    expect(path.extname(p)).toBe(".txt");
  });

  it("test_different_sessions_get_different_paths", () => {
    const p1 = paths.manifestTextSidecarPath("session-one");
    const p2 = paths.manifestTextSidecarPath("session-two");
    expect(p1).not.toBe(p2);
  });

  it("test_null_byte_rejected", () => {
    // Construct the NUL byte at runtime — never write a raw NUL into the source.
    const withNul = "abc" + String.fromCharCode(0) + "def";
    expect(() => paths.manifestTextSidecarPath(withNul)).toThrow(/null byte/);
  });
});

// ---------------------------------------------------------------------------
// --watch flag
// ---------------------------------------------------------------------------

describe("TestCompactHintWatch", () => {
  it("test_watch_flag_exists — flag wires through to _compact_hint_watch", async () => {
    const sid = "watch-flag-exists-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    let callCount = 0;
    vi.spyOn(cliSessions, "_compact_hint_watch").mockImplementation(async () => {
      callCount += 1;
    });

    const r = await invoke(["compact-hint", "--session-id", sid, "--watch"]);
    expect(r.exit_code).toBe(0);
    expect(callCount).toBe(1);
  });

  it("test_watch_shows_full_manifest_on_first_cycle", async () => {
    const sid = "watch-first-cycle-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const manifests = ["## Token-Goat Manifest\n### Files Edited\n- edited0.py\n"];
    let callIndex = 0;
    vi.spyOn(compact, "build_manifest").mockImplementation(() => {
      const idx = Math.min(callIndex, manifests.length - 1);
      callIndex += 1;
      return manifests[idx]!;
    });

    const sleep_calls: number[] = [];
    vi.spyOn(cliSessions, "sleep").mockImplementation((secs: number) => {
      sleep_calls.push(secs);
      throw new cliSessions.KeyboardInterrupt();
    });

    await captureOut(() =>
      cliSessions._compact_hint_watch({
        session_id: sid,
        auto: false,
        max_tokens: 0,
        trigger: "manual",
        interval: 60,
      }),
    );

    // sleep must be called once (after the first manifest render) before the interrupt.
    expect(sleep_calls.length).toBe(1);
  });

  it("test_watch_diff_shows_additions", async () => {
    const sid = "watch-diff-additions-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const manifests = [
      "## Manifest\n### Files Edited\n- edited0.py\n",
      "## Manifest\n### Files Edited\n- edited0.py\n- new_file.py\n",
    ];
    let callIndex = 0;
    vi.spyOn(compact, "build_manifest").mockImplementation(() => {
      const idx = Math.min(callIndex, manifests.length - 1);
      callIndex += 1;
      return manifests[idx]!;
    });

    let sleep_count = 0;
    vi.spyOn(cliSessions, "sleep").mockImplementation(async () => {
      sleep_count += 1;
      if (sleep_count >= 2) throw new cliSessions.KeyboardInterrupt();
    });

    const out = await captureOut(() =>
      cliSessions._compact_hint_watch({
        session_id: sid,
        auto: false,
        max_tokens: 0,
        trigger: "manual",
        interval: 60,
      }),
    );

    const matched = out
      .split("\n")
      .some((ln) => ln.startsWith("+") && ln.includes("new_file.py"));
    expect(matched).toBe(true);
  });

  it("test_watch_diff_shows_removals", async () => {
    const sid = "watch-diff-removals-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const manifests = [
      "## Manifest\n### Files Edited\n- edited0.py\n- removed_file.py\n",
      "## Manifest\n### Files Edited\n- edited0.py\n",
    ];
    let callIndex = 0;
    vi.spyOn(compact, "build_manifest").mockImplementation(() => {
      const idx = Math.min(callIndex, manifests.length - 1);
      callIndex += 1;
      return manifests[idx]!;
    });

    let sleep_count = 0;
    vi.spyOn(cliSessions, "sleep").mockImplementation(async () => {
      sleep_count += 1;
      if (sleep_count >= 2) throw new cliSessions.KeyboardInterrupt();
    });

    const out = await captureOut(() =>
      cliSessions._compact_hint_watch({
        session_id: sid,
        auto: false,
        max_tokens: 0,
        trigger: "manual",
        interval: 60,
      }),
    );

    const matched = out
      .split("\n")
      .some((ln) => ln.startsWith("-") && ln.includes("removed_file.py"));
    expect(matched).toBe(true);
  });

  it("test_watch_no_change_shows_no_changes_message", async () => {
    const sid = "watch-no-change-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    const same_manifest = "## Manifest\n### Files Edited\n- edited0.py\n";
    vi.spyOn(compact, "build_manifest").mockImplementation(() => same_manifest);

    let sleep_count = 0;
    vi.spyOn(cliSessions, "sleep").mockImplementation(async () => {
      sleep_count += 1;
      if (sleep_count >= 2) throw new cliSessions.KeyboardInterrupt();
    });

    const out = await captureOut(() =>
      cliSessions._compact_hint_watch({
        session_id: sid,
        auto: false,
        max_tokens: 0,
        trigger: "manual",
        interval: 60,
      }),
    );

    expect(out).toContain("(no changes)");
  });

  it("test_watch_header_contains_timestamp", async () => {
    const sid = "watch-timestamp-header-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    vi.spyOn(compact, "build_manifest").mockImplementation(() => "## Manifest\n- content\n");
    vi.spyOn(cliSessions, "sleep").mockImplementation(() => {
      throw new cliSessions.KeyboardInterrupt();
    });

    const out = await captureOut(() =>
      cliSessions._compact_hint_watch({
        session_id: sid,
        auto: false,
        max_tokens: 0,
        trigger: "manual",
        interval: 60,
      }),
    );

    const ts_pattern = /--- compact-hint watch \[\d{2}:\d{2}:\d{2}\] ---/;
    expect(ts_pattern.test(out)).toBe(true);
  });

  it("test_watch_stopped_watching_message_on_keyboard_interrupt", async () => {
    const sid = "watch-stopped-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    vi.spyOn(compact, "build_manifest").mockImplementation(() => "## Manifest\n- content\n");
    vi.spyOn(cliSessions, "sleep").mockImplementation(() => {
      throw new cliSessions.KeyboardInterrupt();
    });

    const out = await captureOut(() =>
      cliSessions._compact_hint_watch({
        session_id: sid,
        auto: false,
        max_tokens: 0,
        trigger: "manual",
        interval: 60,
      }),
    );

    expect(out).toContain("Stopped watching.");
  });

  it("test_watch_custom_interval_passed_to_sleep", async () => {
    const sid = "watch-interval-abc";
    _makeSession(sid, { files_read: 2, edits: 1 });

    vi.spyOn(compact, "build_manifest").mockImplementation(() => "## Manifest\n- content\n");

    const sleep_args: number[] = [];
    vi.spyOn(cliSessions, "sleep").mockImplementation((secs: number) => {
      sleep_args.push(secs);
      throw new cliSessions.KeyboardInterrupt();
    });

    await captureOut(() =>
      cliSessions._compact_hint_watch({
        session_id: sid,
        auto: false,
        max_tokens: 0,
        trigger: "manual",
        interval: 30,
      }),
    );

    expect(sleep_args).toEqual([30]);
  });
});
