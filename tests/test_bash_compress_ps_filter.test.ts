/**
 * Tests for PsFilter (ps / top / tasklist process-listing compression).
 *
 * 1:1 port of tests/test_bash_compress_ps_filter.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * module-level test functions are grouped under one `describe("TestPsFilter")`
 * block mirroring the source file's structure.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import PsFilter`
 *      -> import { PsFilter } from the barrel "../src/token_goat/bash_compress.js".
 *  - Python's `_compress(stdout, argv=None)` helper calls
 *    `PsFilter().compress(stdout, "", 0, argv or ["ps", "aux"])`. The TS port
 *    keeps the SAME helper signature and body (positional compress args).
 *  - Python's `PsFilter.detect(text)` is a @staticmethod; the TS port made it
 *    an instance method, so `PsFilter.detect(x)` -> `new PsFilter().detect(x)`.
 *  - Python's `patch.dict(os.environ, {...})` sets env vars for the duration of
 *    the `with` block. The TS port sets `process.env.USERNAME`/`process.env.USER`
 *    before the compress() call and restores the prior values afterward in a
 *    finally — PsFilter.compress() reads process.env.USERNAME at CALL TIME, so
 *    per-call mutation is observed correctly. (env-caching across module load is
 *    NOT a concern here: the lookup happens inside compress(), not at import.)
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks plus one
 * integer parse of the sentinel count token. The fixtures are pure ASCII so
 * Python `len` (code points) equals JS `.length` equals the UTF-8 byte count.
 *
 * splitlines() vs split("\n"): Python compress() uses `stdout.splitlines()`;
 * the TS port uses `stdout.split("\n")`. Every fixture here is built with
 * `"\n".join(lines)` (no trailing newline, no bare CR), so both produce the
 * identical line array — no divergence.
 */
import { describe, expect, it } from "vitest";

import { PsFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Helpers (ported verbatim from the Python module top)
// ---------------------------------------------------------------------------

const _PS_AUX_HEADER =
  "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND";

// Enough system-daemon lines to exceed the 20-line threshold
const _DAEMON_LINES: string[] = Array.from(
  { length: 25 },
  (_v, i) => `root       ${100 + i}  0.0  0.0      0     0 ?        S    Jun08   0:00 [kworker/${i}:0]`,
);

const _PS_EF_HEADER = "UID        PID  PPID  C STIME TTY          TIME CMD";

/** Return a ps aux output string with daemon filler + optional extra lines. */
function _make_ps_aux(extra_lines: string[] | null = null): string {
  const lines = [_PS_AUX_HEADER, ..._DAEMON_LINES];
  if (extra_lines) {
    lines.push(...extra_lines);
  }
  return lines.join("\n");
}

/** Port of Python `_compress(stdout, argv=None)` positional helper. */
function _compress(stdout: string, argv: string[] | null = null): string {
  return new PsFilter().compress(stdout, "", 0, argv ?? ["ps", "aux"]);
}

/**
 * Run `fn` with process.env.USERNAME and process.env.USER temporarily set to
 * `user`, restoring the prior values (or deleting them if unset) afterward.
 * Port of Python `with patch.dict(os.environ, {"USERNAME": u, "USER": u})`.
 */
function _withUser<T>(user: string, fn: () => T): T {
  const prev_username = process.env.USERNAME;
  const prev_user = process.env.USER;
  process.env.USERNAME = user;
  process.env.USER = user;
  try {
    return fn();
  } finally {
    if (prev_username === undefined) {
      delete process.env.USERNAME;
    } else {
      process.env.USERNAME = prev_username;
    }
    if (prev_user === undefined) {
      delete process.env.USER;
    } else {
      process.env.USER = prev_user;
    }
  }
}

describe("TestPsFilter", () => {
  // -------------------------------------------------------------------------
  // 1. Short output (<= 20 lines) -> passthrough unchanged
  // -------------------------------------------------------------------------

  it("test_short_output_passthrough", () => {
    const short = [_PS_AUX_HEADER, ..._DAEMON_LINES.slice(0, 10)].join("\n");
    expect(short.split("\n").length).toBeLessThanOrEqual(20);
    const result = _compress(short);
    expect(result).toBe(short);
  });

  // -------------------------------------------------------------------------
  // 2. Large ps aux: header kept, python process kept, daemons suppressed
  // -------------------------------------------------------------------------

  it("test_large_ps_aux_python_kept", () => {
    const python_line =
      "user      9999  1.2  3.4 123456 65432 pts/0    S    09:00   0:05 python app.py";
    const output = _make_ps_aux([python_line]);
    const result = _compress(output);
    expect(result).toContain(_PS_AUX_HEADER);
    expect(result).toContain("python app.py");
    expect(result).toContain("[suppressed");
  });

  // -------------------------------------------------------------------------
  // 3. High-CPU process (>5%) is kept
  // -------------------------------------------------------------------------

  it("test_high_cpu_process_kept", () => {
    const high_cpu =
      "root        42 12.5  0.1  50000  4096 ?        R    09:00   0:30 /usr/bin/stress";
    const output = _make_ps_aux([high_cpu]);
    const result = _compress(output);
    expect(result).toContain("/usr/bin/stress");
  });

  // -------------------------------------------------------------------------
  // 4. High-MEM process (>2%) is kept
  // -------------------------------------------------------------------------

  it("test_high_mem_process_kept", () => {
    const high_mem =
      "root        99  0.0  5.8 800000 98304 ?        S    09:00   1:00 /usr/bin/bloat";
    const output = _make_ps_aux([high_mem]);
    const result = _compress(output);
    expect(result).toContain("/usr/bin/bloat");
  });

  // -------------------------------------------------------------------------
  // 5. User-owned process is kept (USERNAME/USER env match)
  // -------------------------------------------------------------------------

  it("test_user_owned_process_kept", () => {
    const user_line =
      "alice      7777  0.0  0.1  12345   512 pts/1    S    09:00   0:00 bash";
    const output = _make_ps_aux([user_line]);
    const result = _withUser("alice", () => _compress(output));
    expect(result).toContain("bash");
  });

  // -------------------------------------------------------------------------
  // 6. Dev-relevant command names (uvicorn, node, redis, nginx, ...) are kept
  // -------------------------------------------------------------------------

  it.each([
    ["uvicorn main:app --port 8000", "uvicorn"],
    ["node server.js", "node"],
    ["redis-server /etc/redis.conf", "redis"],
    ["nginx: worker process", "nginx"],
    ["docker-proxy -proto tcp", "docker"],
  ])("test_dev_relevant_commands_kept[%s]", (cmd: string, binary: string) => {
    const dev_line = `user      8888  0.0  0.1  50000  1024 pts/0    S    09:00   0:00 ${cmd}`;
    const output = _make_ps_aux([dev_line]);
    const result = _compress(output);
    expect(result).toContain(binary);
  });

  // -------------------------------------------------------------------------
  // 7. Suppressed sentinel shows correct count
  // -------------------------------------------------------------------------

  it("test_suppressed_sentinel_correct_count", () => {
    // All daemon lines should be suppressed; none are user-owned or dev-relevant
    const output = _make_ps_aux();
    const result = _withUser("noone", () => _compress(output));
    const sentinel_line =
      result.split("\n").find((ln) => ln.startsWith("[suppressed")) ?? null;
    expect(sentinel_line).not.toBeNull();
    // Python: int(sentinel_line.split()[1]) -> second whitespace token is count.
    const suppressed = Number(sentinel_line!.split(/\s+/)[1]);
    expect(suppressed).toBe(_DAEMON_LINES.length);
  });

  // -------------------------------------------------------------------------
  // 8. No lines suppressed -> sentinel NOT appended, output unchanged
  // -------------------------------------------------------------------------

  it("test_no_suppression_no_sentinel", () => {
    // Build output with ONLY the header + python lines so nothing is suppressed
    const lines = [_PS_AUX_HEADER].concat(
      Array.from(
        { length: 25 },
        (_v, i) =>
          `user      ${1000 + i}  0.0  0.5 100000 10000 pts/0    S    09:00   0:01 python worker${i}.py`,
      ),
    );
    const output = lines.join("\n");
    const result = _compress(output);
    expect(result).not.toContain("[suppressed");
    expect(result).toBe(output);
  });

  // -------------------------------------------------------------------------
  // 9. detect() True for ps aux header, False for plain text
  // -------------------------------------------------------------------------

  it("test_detect_true_ps_aux_header", () => {
    expect(
      new PsFilter().detect(
        _PS_AUX_HEADER + "\nroot  1  0.0  0.0  0 0 ? Ss Jun08 0:00 init",
      ),
    ).toBe(true);
  });

  it("test_detect_true_top_batch_mode", () => {
    const top_output =
      "top - 09:00:00 up 2 days,  3:14,  1 user,  load average: 0.10, 0.20, 0.15";
    expect(new PsFilter().detect(top_output)).toBe(true);
  });

  it("test_detect_false_plain_text", () => {
    expect(
      new PsFilter().detect(
        "Hello world\nThis is just plain text\nNo process table here",
      ),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 10. tasklist format: header kept, IMAGE NAME used for dev-relevant match
  // -------------------------------------------------------------------------

  it("test_tasklist_dev_process_kept", () => {
    const tasklist_output = [
      "Image Name                     PID Session Name        Session#    Mem Usage",
      "========================= ======== ================ =========== ============",
    ]
      .concat(
        Array.from(
          { length: 22 },
          (_v, i) =>
            `svchost.exe                  ${200 + i} Services                   0       1,234 K`,
        ),
      )
      .concat(["python.exe                    5678 Console                    1     87,456 K"])
      .join("\n");
    const result = _compress(tasklist_output, ["tasklist"]);
    expect(result).toContain("python.exe");
    expect(result).toContain("[suppressed");
  });

  it("test_tasklist_header_always_kept", () => {
    const tasklist_output = [
      "Image Name                     PID Session Name        Session#    Mem Usage",
      "========================= ======== ================ =========== ============",
    ]
      .concat(
        Array.from(
          { length: 22 },
          (_v, i) =>
            `svchost.exe                  ${300 + i} Services                   0       1,234 K`,
        ),
      )
      .join("\n");
    const result = _compress(tasklist_output, ["tasklist"]);
    expect(result).toContain("Image Name");
  });

  // -------------------------------------------------------------------------
  // 11. ps -ef format: no CPU/MEM columns; CMD column used
  // -------------------------------------------------------------------------

  it("test_ps_ef_dev_command_kept", () => {
    const ef_lines = [_PS_EF_HEADER].concat(
      Array.from(
        { length: 22 },
        (_v, i) => `root       ${500 + i}     1  0 09:00 ?  00:00:00 [kworker/${i}:H]`,
      ),
    );
    ef_lines.push("user      9001     1  0 09:01 pts/0  00:01:00 uvicorn api:app --workers 4");
    const output = ef_lines.join("\n");
    const result = _compress(output, ["ps", "-ef"]);
    expect(result).toContain("uvicorn");
    expect(result).toContain("[suppressed");
  });

  // -------------------------------------------------------------------------
  // 12. top -bn1 batch output: summary header block kept, process table filtered
  // -------------------------------------------------------------------------

  it("test_top_batch_process_table_filtered", () => {
    const top_lines = [
      "top - 09:00:00 up 1 day,  2:34,  1 user,  load average: 0.10, 0.20, 0.15",
      "Tasks: 200 total,   1 running, 199 sleeping,   0 stopped,   0 zombie",
      "%Cpu(s):  0.3 us,  0.7 sy,  0.0 ni, 98.5 id,  0.0 wa,  0.0 hi,  0.5 si,  0.0 st",
      "MiB Mem :  15914.0 total,  12345.0 free,   2100.0 used,   1469.0 buff/cache",
      "MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.  11969.0 avail Mem",
      "",
      "  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND",
    ];
    // Add enough daemon lines to exceed threshold
    top_lines.push(
      ...Array.from(
        { length: 20 },
        (_v, i) =>
          `  ${100 + i} root      20   0    1234    456    123 S   0.0   0.0   0:00.${String(i).padStart(2, "0")} kworker/${i}:0`,
      ),
    );
    top_lines.push(
      "  5678 user      20   0  234567  89012  12345 S   3.2   1.1   0:10.00 node server.js",
    );
    const output = top_lines.join("\n");
    const result = _compress(output, ["top", "-bn1"]);
    expect(result).toContain("node server.js");
    expect(result).toContain("[suppressed");
  });
});
