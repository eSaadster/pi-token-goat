/**
 * Tests for `token-goat bash-output` --full / --diff flags — TS port of
 * tests/test_bash_output_flags.py, plus the 2 mcp-output/mcp-history CLI
 * registration smoke checks from tests/test_mcp_output_cli.py (the rest of that
 * file — compact_mcp_result / store_mcp_result / sidecar round-trip — is already
 * covered by test_mcp_cache.test.ts).
 *
 * Seeding: `bash_cache.store_output(session_id, command, body, "", 0,
 * {min_cache_bytes: 0})` writes under the per-test data-dir override (the Python
 * tests' tmp_path fixture), so no path spy is needed. Returns a BashOutputMeta;
 * `.output_id` is the recall id.
 */
import { describe, expect, it } from "vitest";

import * as bash_cache from "../src/token_goat/bash_cache.js";
import { invoke } from "./_cli_runner.js";

// Enough lines to trigger the smart-default trimming (threshold = 30 + 80 = 110).
const MANY = 200;

function store(sessionId: string, command: string, body: string): string {
  const meta = bash_cache.store_output(sessionId, command, body, "", 0, { min_cache_bytes: 0 });
  if (meta === null) throw new Error("store_output returned null");
  return meta.output_id;
}

function largeBody(n = MANY): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

describe("TestBashOutputFlags", () => {
  it("full returns all lines", async () => {
    const oid = store("sess_full", "echo test", largeBody());
    const result = await invoke(["bash-output", oid, "--full"]);
    expect(result.exit_code).toBe(0);
    for (let i = 0; i < MANY; i++) {
      expect(result.output).toContain(`line ${i}`);
    }
    expect(result.output).not.toContain("elided");
  });

  it("diff shows plus lines for stripped content", async () => {
    const oid = store("sess_diff", "echo test", largeBody());
    const result = await invoke(["bash-output", oid, "--diff"]);
    expect(result.exit_code).toBe(0);
    const plusLines = result.output
      .split("\n")
      .filter((ln) => ln.startsWith("+") && !ln.startsWith("+++"));
    expect(plusLines.length).toBeGreaterThan(0);
    expect(plusLines.some((ln) => ln.includes("line 50"))).toBe(true);
  });

  it("full and diff together gives error", async () => {
    const oid = store("sess_both", "echo test", largeBody());
    const result = await invoke(["bash-output", oid, "--full", "--diff"]);
    expect(result.exit_code).toBe(1);
    expect(result.output.includes("--full") || result.output.includes("--diff")).toBe(true);
  });

  it("missing id gives not found", async () => {
    const result = await invoke(["bash-output", "nonexistent_id_xyz", "--diff"]);
    expect(result.exit_code).toBe(1);
    const lower = result.output.toLowerCase();
    expect(lower.includes("no cached output") || lower.includes("not found")).toBe(true);
  });

  it("full on short entry passes through cleanly", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `short ${i}`).join("\n");
    const oid = store("sess_short", "echo short", body);
    const result = await invoke(["bash-output", oid, "--full"]);
    expect(result.exit_code).toBe(0);
    for (let i = 0; i < 10; i++) {
      expect(result.output).toContain(`short ${i}`);
    }
    expect(result.output).not.toContain("elided");
  });

  it("diff on short entry reports no diff", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `short ${i}`).join("\n");
    const oid = store("sess_short_diff", "echo short", body);
    const result = await invoke(["bash-output", oid, "--diff"]);
    expect(result.exit_code).toBe(0);
    const plusMinus = result.output
      .split("\n")
      .filter((ln) => (ln.startsWith("+") || ln.startsWith("-")) && !ln.startsWith("+++") && !ln.startsWith("---"));
    expect(plusMinus).toHaveLength(0);
  });

  it("diff missing id exits one", async () => {
    const result = await invoke(["bash-output", "bad_id_abc", "--diff"]);
    expect(result.exit_code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mcp-output / mcp-history CLI registration smoke (from test_mcp_output_cli.py)
// ---------------------------------------------------------------------------

describe("TestMcpCommandRegistration", () => {
  it("mcp-output command registered", async () => {
    const result = await invoke(["mcp-output", "--help"]);
    expect(result.exit_code).toBe(0);
    const lower = result.output.toLowerCase();
    expect(lower.includes("cached mcp") || lower.includes("mcp")).toBe(true);
  });

  it("mcp-history command registered", async () => {
    const result = await invoke(["mcp-history", "--help"]);
    expect(result.exit_code).toBe(0);
  });
});
