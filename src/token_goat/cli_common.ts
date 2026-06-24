/**
 * Shared CLI output seam — the `typer.echo` / `typer.Exit` analogues used by
 * BOTH cli.ts (the commander app) and read_commands.ts (the surgical-read
 * command bodies, which emit output directly like their Python originals).
 *
 * Extracting these here avoids a cli ↔ read_commands import cycle. Output is
 * written straight to the process streams (as Python's `typer.echo` ultimately
 * is); the test CliRunner captures it by spying `process.stdout`/`stderr.write`
 * (see tests/_cli_runner.ts), so no indirection layer is needed.
 */
import { colorStderr } from "./render/ansi.js";

/** Analogue of `raise typer.Exit(code)` — caught by cli.run and mapped to the exit code. */
export class CliExit extends Error {
  code: number;
  constructor(code = 0) {
    super(`exit ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
}

/** typer.echo analogue — writes msg + trailing newline to stdout (or stderr). */
export function _echo(msg: string, opts: { err?: boolean } = {}): void {
  const stream = opts.err ? process.stderr : process.stdout;
  stream.write(msg + "\n");
}

/** Print a user-facing error to stderr with a consistent red 'Error: ' prefix. */
export function _error(msg: string): void {
  const prefix = colorStderr() ? "\u001b[31mError:\u001b[0m " : "Error: ";
  _echo(`${prefix}${msg}`, { err: true });
}

/** Print a user-facing warning to stderr with a consistent yellow 'Warning: ' prefix. */
export function _warn(msg: string): void {
  const prefix = colorStderr() ? "\u001b[33mWarning:\u001b[0m " : "Warning: ";
  _echo(`${prefix}${msg}`, { err: true });
}

/**
 * Echo `data` as JSON and raise CliExit(0). Compact separators by default
 * (matches every other JSON-output site); pass `indent` for pretty output.
 */
export function _emit_json(data: unknown, opts: { indent?: number | null } = {}): never {
  const indent = opts.indent ?? null;
  if (indent === null) {
    _echo(JSON.stringify(data));
  } else {
    _echo(JSON.stringify(data, null, indent));
  }
  throw new CliExit(0);
}
