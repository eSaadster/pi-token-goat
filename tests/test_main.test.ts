/**
 * Port of __main__.py's entry contract.
 *
 * main.ts now delegates to the real cli.ts (commander) — it is no longer the
 * Layer-1 stub. `main` is async and returns the process exit code; a no-arg
 * invocation prints help (no_args_is_help) and a real subcommand runs and
 * returns 0.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/token_goat/main.js";

afterEach(() => vi.restoreAllMocks());

/** Capture process.stdout during the call so help/version don't clutter output. */
async function withCapturedStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  });
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

describe("main (port of __main__.py)", () => {
  it("main is a callable function", () => {
    expect(typeof main).toBe("function");
  });

  it("main([]) prints help (no_args_is_help) and resolves to exit code 0", async () => {
    const { code, out } = await withCapturedStdout(() => main([]));
    expect(code).toBe(0);
    expect(out).toContain("token-goat");
  });

  it("main(['version']) runs the real CLI and resolves to exit code 0", async () => {
    const { code, out } = await withCapturedStdout(() => main(["version"]));
    expect(code).toBe(0);
    expect(/\d/.test(out)).toBe(true);
  });
});
