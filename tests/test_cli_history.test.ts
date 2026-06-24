/**
 * Tests for the `token-goat history` command — TS port of tests/test_cli_history.py.
 *
 * The command reads a SessionCache via `session.safe_load`. The Python tests
 * build a SessionCache directly and `patch("token_goat.session.safe_load",
 * return_value=cache)`; the TS equivalent is `vi.spyOn(session, "safe_load")
 * .mockReturnValue(cache)` (the command calls it via `import * as session`).
 * Entry construction: Python `BashEntry(...)` → `new session.BashEntry({...})`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as session from "../src/token_goat/session.js";
import type { BashEntry, GrepEntry, SessionCache, WebEntry } from "../src/token_goat/session.js";
import { invoke } from "./_cli_runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const SID = "test-session-123";

/** Create a test SessionCache with optional history entries (Python _make_session). */
function makeSession(args: {
  bash?: Record<string, BashEntry>;
  web?: Record<string, WebEntry>;
  grep?: GrepEntry[];
} = {}): SessionCache {
  const now = Date.now() / 1000;
  const init: ConstructorParameters<typeof session.SessionCache>[0] = {
    session_id: SID,
    started_ts: now,
    last_activity_ts: now,
  };
  if (args.bash !== undefined) init.bash_history = args.bash;
  if (args.web !== undefined) init.web_history = args.web;
  if (args.grep !== undefined) init.greps = args.grep;
  return new session.SessionCache(init);
}

describe("TestHistory", () => {
  it("requires session id", async () => {
    const result = await invoke(["history"]);
    expect(result.exit_code).toBe(1);
  });

  it("empty session shows all sections", async () => {
    const cache = makeSession();
    vi.spyOn(session, "safe_load").mockReturnValue(cache);
    const result = await invoke(["history", "--session-id", SID]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("## Bash History");
    expect(result.output).toContain("## Web History");
    expect(result.output).toContain("## Grep History");
    expect(result.output).toContain("(no entries)");
  });

  it("bash only", async () => {
    const now = Date.now() / 1000;
    const bash = {
      sha1: new session.BashEntry({
        cmd_sha: "sha1",
        cmd_preview: "pytest tests/",
        output_id: "out1",
        ts: now - 60,
        stdout_bytes: 1024,
        stderr_bytes: 0,
        exit_code: 0,
      }),
    };
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ bash }));
    const result = await invoke(["history", "--session-id", SID, "--bash"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("## Bash History");
    expect(result.output).not.toContain("## Web History");
    expect(result.output).not.toContain("## Grep History");
    expect(result.output).toContain("pytest tests/");
  });

  it("web only", async () => {
    const now = Date.now() / 1000;
    const web = {
      sha1: new session.WebEntry({
        url_sha: "sha1",
        url_preview: "https://example.com/api",
        output_id: "web1",
        ts: now - 30,
        body_bytes: 2048,
        status_code: 200,
      }),
    };
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ web }));
    const result = await invoke(["history", "--session-id", SID, "--web"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("## Web History");
    expect(result.output).not.toContain("## Bash History");
    expect(result.output).not.toContain("## Grep History");
    expect(result.output).toContain("example.com");
  });

  it("grep only", async () => {
    const now = Date.now() / 1000;
    const grep = [
      new session.GrepEntry({
        pattern: "function.*login",
        path: "src/auth.py",
        ts: now - 45,
        result_count: 5,
      }),
    ];
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ grep }));
    const result = await invoke(["history", "--session-id", SID, "--grep"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("## Grep History");
    expect(result.output).not.toContain("## Bash History");
    expect(result.output).not.toContain("## Web History");
    expect(result.output).toContain("function.*login");
    expect(result.output).toContain("src/auth.py");
    expect(result.output).toContain("5 matches");
  });

  it("limit respected", async () => {
    const now = Date.now() / 1000;
    const bash: Record<string, BashEntry> = {};
    for (let i = 0; i < 5; i++) {
      bash[`sha${i}`] = new session.BashEntry({
        cmd_sha: `sha${i}`,
        cmd_preview: `cmd_${i}`,
        output_id: `out${i}`,
        ts: now - (50 - i * 10),
        stdout_bytes: 1024,
        stderr_bytes: 0,
        exit_code: 0,
      });
    }
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ bash }));
    const result = await invoke(["history", "--session-id", SID, "--bash", "--limit", "2"]);
    expect(result.exit_code).toBe(0);
    const lines = result.output.split("\n").filter((l) => l.trim().startsWith("cmd_"));
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("json output bash", async () => {
    const now = Date.now() / 1000;
    const bash = {
      sha1: new session.BashEntry({
        cmd_sha: "sha1",
        cmd_preview: "pytest tests/",
        output_id: "out1",
        ts: now - 60,
        stdout_bytes: 1024,
        stderr_bytes: 512,
        exit_code: 0,
      }),
    };
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ bash }));
    const result = await invoke(["history", "--session-id", SID, "--bash", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.bash).toBeDefined();
    expect(data.bash).toHaveLength(1);
    expect(data.bash[0].command).toBe("pytest tests/");
    expect(data.bash[0].exit_code).toBe(0);
    expect(data.bash[0].cached).toBe("yes");
    expect(data.bash[0].size_bytes).toBe(1536);
  });

  it("json output web", async () => {
    const now = Date.now() / 1000;
    const web = {
      sha1: new session.WebEntry({
        url_sha: "sha1",
        url_preview: "https://example.com/api",
        output_id: "web1",
        ts: now - 30,
        body_bytes: 2048,
        status_code: 200,
      }),
    };
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ web }));
    const result = await invoke(["history", "--session-id", SID, "--web", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.web).toBeDefined();
    expect(data.web).toHaveLength(1);
    expect(data.web[0].url).toContain("example.com");
    expect(data.web[0].status_code).toBe(200);
    expect(data.web[0].size_kb).toBe(2);
  });

  it("json output grep", async () => {
    const now = Date.now() / 1000;
    const grep = [
      new session.GrepEntry({
        pattern: "function.*login",
        path: "src/auth.py",
        ts: now - 45,
        result_count: 5,
      }),
    ];
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ grep }));
    const result = await invoke(["history", "--session-id", SID, "--grep", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.grep).toBeDefined();
    expect(data.grep).toHaveLength(1);
    expect(data.grep[0].pattern).toBe("function.*login");
    expect(data.grep[0].path).toBe("src/auth.py");
    expect(data.grep[0].result_count).toBe(5);
  });

  it("all sections json", async () => {
    const now = Date.now() / 1000;
    const bash = {
      bash1: new session.BashEntry({
        cmd_sha: "bash1",
        cmd_preview: "ls -la",
        output_id: "out1",
        ts: now - 60,
        stdout_bytes: 512,
        stderr_bytes: 0,
        exit_code: 0,
      }),
    };
    const web = {
      web1: new session.WebEntry({
        url_sha: "web1",
        url_preview: "https://docs.example.com",
        output_id: "web1",
        ts: now - 30,
        body_bytes: 1024,
        status_code: 200,
      }),
    };
    const grep = [
      new session.GrepEntry({ pattern: "TODO", path: null, ts: now - 15, result_count: 3 }),
    ];
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ bash, web, grep }));
    const result = await invoke(["history", "--session-id", SID, "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.bash).toBeDefined();
    expect(data.web).toBeDefined();
    expect(data.grep).toBeDefined();
    expect(data.bash).toHaveLength(1);
    expect(data.web).toHaveLength(1);
    expect(data.grep).toHaveLength(1);
  });

  it("text format spacing", async () => {
    const now = Date.now() / 1000;
    const bash = {
      sha1: new session.BashEntry({
        cmd_sha: "sha1",
        cmd_preview: "pytest tests/test_cli.py -v",
        output_id: "out1",
        ts: now - 120,
        stdout_bytes: 5 * 1024,
        stderr_bytes: 2 * 1024,
        exit_code: 0,
      }),
    };
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ bash }));
    const result = await invoke(["history", "--session-id", SID, "--bash"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("pytest tests/test_cli.py -v");
    expect(result.output).toContain("exit=0");
    expect(result.output).toContain("cached");
    expect(result.output).toContain("120");
  });

  it("grep global pattern", async () => {
    const now = Date.now() / 1000;
    const grep = [
      new session.GrepEntry({ pattern: "FIXME", path: null, ts: now - 25, result_count: 8 }),
    ];
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ grep }));
    const result = await invoke(["history", "--session-id", SID, "--grep"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("FIXME");
    expect(result.output).toContain("(global)");
    expect(result.output).toContain("8 matches");
  });

  it("bash uncached entry", async () => {
    const now = Date.now() / 1000;
    const bash = {
      sha1: new session.BashEntry({
        cmd_sha: "sha1",
        cmd_preview: "echo hello",
        output_id: "",
        ts: now - 30,
        stdout_bytes: 100,
        stderr_bytes: 0,
        exit_code: 0,
      }),
    };
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ bash }));
    const result = await invoke(["history", "--session-id", SID, "--bash"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("not cached");
  });

  it("bash with exit code", async () => {
    const now = Date.now() / 1000;
    const bash = {
      sha1: new session.BashEntry({
        cmd_sha: "sha1",
        cmd_preview: "failing_command",
        output_id: "out1",
        ts: now - 10,
        stdout_bytes: 256,
        stderr_bytes: 128,
        exit_code: 127,
      }),
    };
    vi.spyOn(session, "safe_load").mockReturnValue(makeSession({ bash }));
    const result = await invoke(["history", "--session-id", SID, "--bash"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("exit=127");
  });
});
