/**
 * In-process CliRunner — the TS analogue of `typer.testing.CliRunner().invoke`.
 *
 * `cli.run(argv)` routes _echo/help/usage output through its `_io` sink which
 * defaults to the process streams, and the hook commands' `safe_run` writes its
 * JSON response straight to `process.stdout`. So to capture everything uniformly
 * we spy `process.stdout.write` / `process.stderr.write` (the proven
 * captureStdout pattern from the dispatcher tests) and run with the default io.
 *
 *  - `stdout` = the process.stdout stream only (what `json.loads(result.stdout)`
 *    expects for hook output).
 *  - `stderr` = the process.stderr stream only.
 *  - `output` = the two interleaved in write order (click's `mix_stderr=True`).
 */
import { vi } from "vitest";

import * as cli from "../src/token_goat/cli.js";

export interface CliResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  output: string;
}

function _decode(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

/** Invoke the CLI with a user argv slice and capture output + exit code. */
export async function invoke(argv: string[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const combined: string[] = [];

  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    const s = _decode(chunk);
    out.push(s);
    combined.push(s);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    const s = _decode(chunk);
    err.push(s);
    combined.push(s);
    return true;
  });

  let exit_code: number;
  try {
    exit_code = await cli.run(argv);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }

  return {
    exit_code,
    stdout: out.join(""),
    stderr: err.join(""),
    output: combined.join(""),
  };
}
