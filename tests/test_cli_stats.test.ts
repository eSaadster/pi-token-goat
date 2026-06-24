/**
 * Tests for cli_stats._render_top_session_files.
 *
 * Faithful port of tests/test_cli_stats.py — exercises the
 * `_render_top_session_files` helper DIRECTLY (not via the CLI). The
 * `tmp_data_dir` fixture is automatic (tests/setup.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";

import * as paths from "../src/token_goat/paths.js";
import * as session from "../src/token_goat/session.js";
import * as cli_stats from "../src/token_goat/cli_stats.js";

/** Create a session file with the given file_access_counts. */
function _seed_session(sid: string, file_counts: Record<string, number>): void {
  const cache = session.load(sid);
  Object.assign(cache.file_access_counts, file_counts);
  paths.ensureDir(paths.sessionsDir());
  fs.writeFileSync(paths.sessionCachePath(sid), cache.to_json(), "utf-8");
  session._proc_load_cache.delete(sid);
}

describe("TestRenderTopSessionFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_no_sessions_dir_returns_empty", () => {
    expect(cli_stats._render_top_session_files()).toBe("");
  });

  it("test_empty_sessions_dir_returns_empty", () => {
    fs.mkdirSync(paths.sessionsDir(), { recursive: true });
    expect(cli_stats._render_top_session_files()).toBe("");
  });

  it("test_single_access_files_filtered_out", () => {
    _seed_session("topfiles-filter-01", { "/proj/src/auth.py": 1 });
    expect(cli_stats._render_top_session_files()).toBe("");
  });

  it("test_multi_access_files_appear_in_output", () => {
    _seed_session("topfiles-multi-01", {
      "/proj/src/auth.py": 5,
      "/proj/src/models.py": 3,
    });
    const result = cli_stats._render_top_session_files();
    expect(result).toContain("Top files this session");
    expect(result).toContain("auth.py");
    expect(result).toContain("models.py");
  });

  it("test_output_sorted_descending_by_count", () => {
    _seed_session("topfiles-sort-01", {
      "/proj/a.py": 2,
      "/proj/b.py": 10,
      "/proj/c.py": 7,
    });
    const result = cli_stats._render_top_session_files();
    expect(result.indexOf("b.py")).toBeLessThan(result.indexOf("c.py"));
    expect(result.indexOf("c.py")).toBeLessThan(result.indexOf("a.py"));
  });

  it("test_top_n_limits_output", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      counts[`/proj/file${i}.py`] = i + 2;
    }
    _seed_session("topfiles-topn-01", counts);
    const result = cli_stats._render_top_session_files(3);
    const file_lines = result.split("\n").filter((ln) => ln.includes("x  "));
    expect(file_lines.length).toBeLessThanOrEqual(3);
  });
});
