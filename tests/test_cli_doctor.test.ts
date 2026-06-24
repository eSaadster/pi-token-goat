/**
 * CLI tests for the `doctor` command (cli_doctor.ts) — faithful port of
 * tests/test_cli_doctor.py plus the doctor-touching cases from
 * test_coverage_iter165.py (version checks) and test_security_validation.py
 * (WAL smoke).
 *
 * Harness seams:
 *  - `invoke(["doctor"])` is the typer CliRunner analogue (`r.exit_code` /
 *    `r.output` = stdout+stderr interleaved). `tmp_data_dir` is automatic via
 *    tests/setup.ts (fresh isolated data dir + cleared caches per test), so
 *    `db.recordStat(...)` lands in the per-test global.db.
 *  - Doctor probes `npm --version` + the npm registry for the latest version;
 *    both are neutralized by spying `cli_doctor._subprocessRun` (npm passthrough)
 *    and `_check_npm_version`
 *    (TS `_packageVersion()` reads a real package.json, unlike Python's
 *    PackageNotFoundError, so the unmocked check would hit the network).
 *  - Hook wrapper path/content come from `paths.hookWrapperPath` /
 *    `paths.hookWrapperContent` (vi.spyOn → string paths, not Path objects).
 *  - Subprocess timeout/failure tests re-spy `_subprocessRun` inside the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as paths from "../src/token_goat/paths.js";
import * as db from "../src/token_goat/db.js";
import * as cli_doctor from "../src/token_goat/cli_doctor.js";
import { invoke } from "./_cli_runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Neutralize doctor's toolchain + network probes: mock the `npm --version`
 * subprocess and the `_check_npm_version` registry fetch. Tests needing
 * different subprocess behavior re-spy `_subprocessRun` inside the test body
 * (the later spy wins); `_check_npm_version` stays mocked.
 */
function mockNpmAndRegistry(): void {
  vi.spyOn(cli_doctor, "_subprocessRun").mockImplementation((cmd: string[]) => {
    if (cmd[0] === "npm") return { returncode: 0, stdout: "10.9.0\n", stderr: "" };
    return { returncode: 0, stdout: "token-goat 0.6.1\n", stderr: "" };
  });
  vi.spyOn(cli_doctor, "_check_npm_version").mockResolvedValue("0.6.1 (latest)");
}

// ---------------------------------------------------------------------------
// Hook wrapper section in doctor output
// ---------------------------------------------------------------------------

describe("TestDoctorHookWrapper", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    mockNpmAndRegistry();
  });

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  function mkTmp(): string {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "tg-doctor-test-"));
    tmpDirs.push(t);
    return t;
  }

  it("test_hook_wrapper_missing_shows_fail", async () => {
    const tmp = mkTmp();
    const missing = path.join(tmp, "bin", "tg-hook.cmd");
    vi.spyOn(paths, "hookWrapperPath").mockReturnValue(missing);
    vi.spyOn(paths, "hookWrapperContent").mockReturnValue("@echo off\r\n");

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("Hook wrapper");
    expect(r.output).toContain("[FAIL]");
    expect(r.output).toContain("NOT FOUND");
  });

  it("test_hook_wrapper_up_to_date_shows_ok", async () => {
    const tmp = mkTmp();
    const wrapper = path.join(tmp, "bin", "tg-hook.cmd");
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    const expected_content = "@echo off\r\nREM token-goat hook wrapper\r\n";
    fs.writeFileSync(wrapper, expected_content); // CRLF preserved (newline="")

    vi.spyOn(paths, "hookWrapperPath").mockReturnValue(wrapper);
    vi.spyOn(paths, "hookWrapperContent").mockReturnValue(expected_content);

    // Selective mock: wrapper invocation returns ok; npm passes through.
    vi.spyOn(cli_doctor, "_subprocessRun").mockImplementation((cmd: string[]) => {
      if (cmd[0] === wrapper) {
        return { returncode: 0, stdout: "token-goat 0.6.1\n", stderr: "" };
      }
      return { returncode: 0, stdout: "10.9.0\n", stderr: "" };
    });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("Hook wrapper");
    expect(r.output).toContain("up to date");
  });

  it("test_hook_wrapper_stale_content_shows_warn", async () => {
    const tmp = mkTmp();
    const wrapper = path.join(tmp, "bin", "tg-hook.cmd");
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, "@echo off\r\nREM old content\r\n");

    vi.spyOn(paths, "hookWrapperPath").mockReturnValue(wrapper);
    vi.spyOn(paths, "hookWrapperContent").mockReturnValue("@echo off\r\nREM new content\r\n");

    vi.spyOn(cli_doctor, "_subprocessRun").mockReturnValue({
      returncode: 0,
      stdout: "token-goat 0.6.1\n",
      stderr: "",
    });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("Hook wrapper");
    expect(r.output).toContain("[WARN]");
    expect(r.output).toContain("differs from expected");
  });

  it("test_hook_wrapper_invoke_failure_shows_warn", async () => {
    const tmp = mkTmp();
    const wrapper = path.join(tmp, "bin", "tg-hook.cmd");
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    const content = "@echo off\r\nREM token-goat\r\n";
    fs.writeFileSync(wrapper, content);

    vi.spyOn(paths, "hookWrapperPath").mockReturnValue(wrapper);
    vi.spyOn(paths, "hookWrapperContent").mockReturnValue(content);

    vi.spyOn(cli_doctor, "_subprocessRun").mockReturnValue({
      returncode: 1,
      stdout: "",
      stderr: "error: something went wrong",
    });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("Hook wrapper");
    expect(r.output).toContain("[WARN]");
  });

  it("test_hook_wrapper_section_appears_before_worker", async () => {
    const tmp = mkTmp();
    const missing = path.join(tmp, "bin", "tg-hook.cmd");
    vi.spyOn(paths, "hookWrapperPath").mockReturnValue(missing);
    vi.spyOn(paths, "hookWrapperContent").mockReturnValue("@echo off\r\n");

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);

    const hook_wrapper_pos = r.output.indexOf("Hook wrapper");
    const worker_pos = r.output.indexOf("\nWorker");
    expect(hook_wrapper_pos).not.toBe(-1);
    expect(worker_pos).not.toBe(-1);
    expect(hook_wrapper_pos).toBeLessThan(worker_pos);
  });

  it("test_hook_wrapper_invoke_timeout_shows_warn", async () => {
    const tmp = mkTmp();
    const wrapper = path.join(tmp, "bin", "tg-hook.cmd");
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    const content = "@echo off\r\n";
    fs.writeFileSync(wrapper, content);

    vi.spyOn(paths, "hookWrapperPath").mockReturnValue(wrapper);
    vi.spyOn(paths, "hookWrapperContent").mockReturnValue(content);

    vi.spyOn(cli_doctor, "_subprocessRun").mockImplementation(() => {
      throw new cli_doctor.TimeoutExpired("cmd", 10);
    });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("[WARN]");
    expect(r.output).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// Stats section in doctor output: top kinds, last-write recency, kind coverage
// ---------------------------------------------------------------------------

describe("TestDoctorStatsSection", () => {
  beforeEach(() => {
    mockNpmAndRegistry();
  });

  it("test_top_kinds_listed_when_rows_exist", async () => {
    db.recordStat(undefined, "image_shrink", { bytesSaved: 10000, tokensSaved: 2500 });
    db.recordStat(undefined, "read_replacement", { bytesSaved: 4000, tokensSaved: 1000 });
    db.recordStat(undefined, "session_hint", { bytesSaved: 2000, tokensSaved: 500 });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("top kind: image_shrink");
    expect(r.output).toContain("2500 tokens");
  });

  it("test_unmapped_kind_surfaces_as_warn", async () => {
    db.recordStat(undefined, "totally_new_kind_2026", { bytesSaved: 500, tokensSaved: 125 });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("unmapped kinds");
    expect(r.output).toContain("totally_new_kind_2026");
    expect(r.output).toContain("[WARN] unmapped kinds");
  });

  it("test_all_mapped_kinds_show_all_clear", async () => {
    db.recordStat(undefined, "image_shrink", { bytesSaved: 1000, tokensSaved: 250 });
    db.recordStat(undefined, "session_hint", { bytesSaved: 500, tokensSaved: 125 });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("kind coverage");
    expect(r.output).toContain("all kinds mapped");
  });

  it("test_recent_write_shows_minutes", async () => {
    db.recordStat(undefined, "image_shrink", { bytesSaved: 1000, tokensSaved: 250 });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("last write");
    expect(r.output).toContain("m ago"); // minute granularity
  });

  it("test_stale_write_surfaces_as_warn", async () => {
    db.recordStat(undefined, "image_shrink", { bytesSaved: 1000, tokensSaved: 250 });
    const ten_days_ago = Math.trunc(Date.now() / 1000) - 10 * 86400;
    db.openGlobal((conn) => {
      conn.prepare("UPDATE stats SET ts = ? WHERE kind = ?").run(ten_days_ago, "image_shrink");
    });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("last write");
    expect(r.output).toContain("stats DB looks stale");
  });

  it("test_bash_compress_prefix_does_not_count_as_unmapped", async () => {
    db.recordStat(undefined, "bash_compress:pytest", { bytesSaved: 500, tokensSaved: 125 });
    db.recordStat(undefined, "bash_compress:npm", { bytesSaved: 300, tokensSaved: 75 });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).not.toContain("[WARN] unmapped kinds");
    expect(r.output).toContain("all kinds mapped");
  });
});

// ---------------------------------------------------------------------------
// Compaction budget utilization section in doctor output
// ---------------------------------------------------------------------------

describe("TestDoctorCompactionUtilization", () => {
  beforeEach(() => {
    mockNpmAndRegistry();
  });

  function writeCompactRow(budget: number, actual: number, trigger = "manual"): void {
    const detail = `budget=${budget},actual=${actual},trigger=${trigger},events=1`;
    db.recordStat(undefined, "compact_manifest", { tokensSaved: 0, bytesSaved: 0, detail });
  }

  it("test_p50_correct_for_three_values", async () => {
    // utilizations: 30/100=0.30, 60/100=0.60, 90/100=0.90
    writeCompactRow(100, 30);
    writeCompactRow(100, 60);
    writeCompactRow(100, 90);

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("p50=60%"); // median, not minimum (30%)
  });

  it("test_p50_correct_for_five_values", async () => {
    for (const actual of [10, 20, 50, 80, 90]) {
      writeCompactRow(100, actual);
    }

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("p50=50%");
  });
});

// ---------------------------------------------------------------------------
// skill_preservation config knobs in doctor output
// ---------------------------------------------------------------------------

describe("TestDoctorSkillPreservationConfig", () => {
  beforeEach(() => {
    mockNpmAndRegistry();
  });

  it("test_doctor_reports_skill_preservation_truncation_budget", async () => {
    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("skill_preservation.truncation_budget_tokens");
  });

  it("test_doctor_reports_skill_preservation_compress_bodies", async () => {
    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("skill_preservation.compress_bodies");
  });

  it("test_doctor_reports_skill_preservation_compress_min_bytes", async () => {
    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("skill_preservation.compress_min_bytes");
  });
});

// ---------------------------------------------------------------------------
// Version checks (folded in from test_coverage_iter165.py:88-125)
// ---------------------------------------------------------------------------

describe("TestDoctorVersionChecks", () => {
  beforeEach(() => {
    mockNpmAndRegistry();
  });

  it("test_package_not_found_shows_unknown", async () => {
    // Python patches importlib.metadata.version to raise PackageNotFoundError →
    // "token-goat: unknown". TS `_packageVersion()` is module-private and reads a
    // real package.json, so we drive the analogous "unknown" path through the
    // exported `_check_npm_version` seam (ccVer === "unknown" branch) and assert
    // doctor still exits 0 and emits the token-goat version line. (Weaker
    // invariant — noted in the port report; no exported _packageVersion seam.)
    vi.spyOn(cli_doctor, "_check_npm_version").mockResolvedValue(
      "installed version unknown — skipping",
    );

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("token-goat");
    expect(r.output).toContain("installed version unknown — skipping");
  });

  it("test_npm_not_found_shows_warn", async () => {
    // _check_npm_version stays mocked via the describe's beforeEach; here we make
    // the `npm --version` toolchain probe ENOENT so doctor WARNs on it.
    vi.spyOn(cli_doctor, "_subprocessRun").mockImplementation((cmd: string[]) => {
      if (cmd[0] === "npm") {
        const e: NodeJS.ErrnoException = new Error("spawn npm ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return { returncode: 0, stdout: "x\n", stderr: "" };
    });

    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("[WARN]");
    expect(r.output).toContain("npm");
  });
});

// ---------------------------------------------------------------------------
// WAL smoke (intent from test_security_validation.py:299-322)
// ---------------------------------------------------------------------------

describe("TestDoctorWalSmoke", () => {
  beforeEach(() => {
    mockNpmAndRegistry();
  });

  it("test_sqlite_wal_section_appears", async () => {
    const r = await invoke(["doctor"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("SQLite");
    expect(r.output).toMatch(/WAL/);
  });
});
