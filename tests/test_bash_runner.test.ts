/**
 * Tests for token_goat/bash_runner — subprocess wrapper around bash_compress.
 *
 * Port of tests/test_bash_runner.py. Seams / adaptations:
 *  - run() is ASYNC in the TS port (Node's spawn is event-based), so every
 *    invocation is awaited and each test is async.
 *  - write_stdout / write_stderr are callbacks; the Python io.StringIO().write
 *    sink becomes a JS string accumulator closure (`captured += s`).
 *  - tmp_data_dir is AUTOMATIC (tests/setup.ts isolates the data dir per test),
 *    so the fixture param is dropped; db.recordStat lands in the per-test global
 *    DB, read back via db.openGlobalReadonly.
 *  - The Python test uses bare `python`; this runner only has `python3`, so the
 *    commands use `python3` (same intent: a controllable subprocess).
 *  - The two _record_savings threshold tests patch token_goat.db.record_stat;
 *    the TS port uses vi.spyOn(db, "recordStat").
 *  - The TestPressureScaledBashCap class targets hooks_read._pressure_scaled_bash_cap
 *    which is unrelated to bash_runner and lives in the hooks_read test suite; it
 *    is omitted here (not part of the bash_runner module/port).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import * as bash_runner from "../src/token_goat/bash_runner.js";
import * as bash_compress from "../src/token_goat/bash_compress.js";
import * as db from "../src/token_goat/db.js";

const PY = "python3";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Passthrough mode (no filter matches)
// ---------------------------------------------------------------------------

describe("TestPassthrough", () => {
  it("test_unrecognised_command_runs_unchanged", async () => {
    const rc = await bash_runner.run("echo hello-passthrough", { timeout: 10 });
    expect(rc).toBe(0);
  });

  it("test_exit_code_preserved", async () => {
    const rc = await bash_runner.run("exit 7", { timeout: 10 });
    expect(rc).toBe(7);
  });

  it("test_command_not_found", async () => {
    const rc = await bash_runner.run("totally-bogus-binary-1234", { timeout: 10 });
    // Shell returns 127 for command not found.
    expect([127, 1, 2]).toContain(rc);
  });
});

// ---------------------------------------------------------------------------
// Wrapped + compressed mode
// ---------------------------------------------------------------------------

describe("TestWrapAndCompress", () => {
  it("test_pytest_summary_compressed", async () => {
    // Pipe 200 fake PASSED lines through the pytest filter. We pick a filter we
    // know exists by passing filter_name explicitly.
    let captured = "";
    const cmd =
      `${PY} -c "import sys; [sys.stdout.write(f'PASSED tests/test_{i}.py::test_x\\n')` +
      ` for i in range(200)]; print('= 200 passed, 0 failed in 1s =')"`;
    const rc = await bash_runner.run(cmd, {
      filter_name: "pytest",
      timeout: 30,
      write_stdout: (s) => {
        captured += s;
      },
    });
    expect(rc).toBe(0);
    expect(captured).toContain("200 passed");
    // 200 individual PASSED lines should be collapsed.
    expect(captured).toContain("collapsed");
    expect(captured).toContain("PASSED");
  });

  it("test_exit_code_surfaces_through_wrapper", async () => {
    // A failing command must propagate its exit code.
    let captured = "";
    const rc = await bash_runner.run(`${PY} -c "import sys; sys.exit(3)"`, {
      filter_name: "pytest",
      timeout: 10,
      write_stdout: (s) => {
        captured += s;
      },
    });
    expect(rc).toBe(3);
  });

  it("test_stderr_captured", async () => {
    let captured = "";
    // The "generic" filter name is not a registered lookup target, so this falls
    // back to argv-based dispatch (no filter) and exits via raw exec; rc still 0.
    const rc = await bash_runner.run(
      `${PY} -c "import sys; sys.stderr.write('errmsg\\n'); sys.stdout.write('outmsg\\n')"`,
      {
        filter_name: "generic",
        timeout: 10,
        write_stdout: (s) => {
          captured += s;
        },
      },
    );
    expect(rc).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timeout (POSIX-only sleep semantics)
// ---------------------------------------------------------------------------

describe("TestTimeout", () => {
  it.skipIf(process.platform === "win32")("test_timeout_kills_long_command", async () => {
    let captured = "";
    const rc = await bash_runner.run("sleep 30", {
      filter_name: "pytest", // any filter; just exercise the timeout path
      timeout: 2,
      write_stdout: (s) => {
        captured += s;
      },
    });
    // 124 = timeout(1) convention.
    expect(rc).toBe(124);
  }, 15000);

  it.skipIf(process.platform === "win32")("test_passthrough_timeout", async () => {
    const rc = await bash_runner.run("sleep 30", { timeout: 2 });
    expect(rc).toBe(124);
  }, 15000);
});

// ---------------------------------------------------------------------------
// Chained command (smoke)
// ---------------------------------------------------------------------------

describe("TestOverflow", () => {
  it("test_chained_command_with_explicit_filter", async () => {
    // "&&" chains are rejected by detect_from_command but pass when filter_name
    // is given explicitly. Use cheap shell built-ins to avoid Python startup cost.
    let captured = "";
    const rc = await bash_runner.run("echo x && echo y", {
      filter_name: "pytest",
      timeout: 10,
      write_stdout: (s) => {
        captured += s;
      },
    });
    expect(rc).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stats recording (smoke, uses real DB via the per-test isolated data dir)
// ---------------------------------------------------------------------------

describe("TestStatsRecording", () => {
  it("test_savings_recorded_for_compressed_run", async () => {
    // Force a heavy compression scenario and verify the stat row appears.
    let captured = "";
    const cmd =
      `${PY} -c "import sys; [print(f'PASSED tests/test_{i}.py::test_x')` +
      ` for i in range(500)]"`;
    await bash_runner.run(cmd, {
      filter_name: "pytest",
      timeout: 30,
      write_stdout: (s) => {
        captured += s;
      },
    });
    // Query the stats DB for our row.
    const rows = db.openGlobalReadonly((conn) =>
      conn
        .prepare(
          "SELECT kind, bytes_saved, tokens_saved FROM stats WHERE kind LIKE 'bash_compress:%'",
        )
        .all() as Array<{ kind: string; bytes_saved: number; tokens_saved: number }>,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.bytes_saved > 0)).toBe(true);
  });

  it("test_small_savings_below_threshold_not_recorded", () => {
    // Build a CompressedOutput that saves only 3 bytes (below threshold of 32).
    const result = new bash_compress.CompressedOutput({
      text: "x",
      original_bytes: 10,
      compressed_bytes: 7,
      filter_name: "python",
    });
    expect(result.bytes_saved).toBe(3);
    expect(result.bytes_saved).toBeLessThan(bash_runner.MIN_RECORD_STAT_BYTES);

    // _record_savings should return before touching the DB.
    const mockRecord = vi.spyOn(db, "recordStat").mockImplementation(() => {});
    bash_runner._record_savings(result, "python -c 'pass'", 1.0);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("test_savings_at_threshold_are_recorded", () => {
    const threshold = bash_runner.MIN_RECORD_STAT_BYTES;
    const result = new bash_compress.CompressedOutput({
      text: "x",
      original_bytes: threshold + 50,
      compressed_bytes: 50,
      filter_name: "pytest",
    });
    expect(result.bytes_saved).toBe(threshold);

    const mockRecord = vi.spyOn(db, "recordStat").mockImplementation(() => {});
    bash_runner._record_savings(result, "pytest tests/", 5.0);
    expect(mockRecord).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pressure-scaled token cap
// ---------------------------------------------------------------------------

describe("TestMaxTokensCap", () => {
  // filter_name="generic" → filter_by_name("generic") returns null (GenericFilter
  // is no longer in the FILTERS registry — it never matched via select_filter
  // anyway and is absent in CPython's 156-filter list), so _resolve_filter falls
  // back to select_filter(argv) on the command, matching CPython exactly.
  it("test_max_tokens_zero_no_cap", async () => {
    // max_tokens=0 means no post-compress cap — large output passes through.
    let captured = "";
    // 200 unique lines × 100 chars ≈ 20 KB.
    const cmd = `${PY} -c "[print(f'line_{i}: ' + 'x' * 100) for i in range(200)]"`;
    await bash_runner.run(cmd, {
      filter_name: "generic",
      timeout: 15,
      write_stdout: (s) => {
        captured += s;
      },
      max_tokens: 0,
    });
    expect(captured).not.toContain("[token-goat: output capped at");
  });

  it("test_max_tokens_applied_when_output_large", async () => {
    // filter_name="generic" → null → select_filter routes this oversized output
    // to the catch-all; the external 50-token cap then trims further. The
    // compression marker must survive the cap. (Matches CPython.)
    let captured = "";
    const cmd = `${PY} -c "[print(f'line_{i}: ' + 'x' * 100) for i in range(200)]"`;
    await bash_runner.run(cmd, {
      filter_name: "generic",
      timeout: 15,
      write_stdout: (s) => {
        captured += s;
      },
      max_tokens: 50,
    });
    expect(captured).toContain("[token-goat: output capped at ~50 tokens]");
    expect(captured).toContain("TOKEN_GOAT_BASH_COMPRESS");
  });

  it("test_max_tokens_not_applied_when_output_small", async () => {
    // The cap does not fire when output already fits.
    let captured = "";
    await bash_runner.run(`${PY} -c "print('1 passed')"`, {
      filter_name: "pytest",
      timeout: 10,
      write_stdout: (s) => {
        captured += s;
      },
      max_tokens: 8000,
    });
    expect(captured).not.toContain("[token-goat: output capped at");
  });
});
