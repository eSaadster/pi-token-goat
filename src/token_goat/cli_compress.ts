/**
 * `compress` command implementation — the TS port of cli.py's `cmd_compress`
 * (cli.py:6476). Grouped with batch G in the original decomposition but it is a
 * bash-pipeline command: a thin wrapper over `bash_runner.run` that runs a shell
 * command, prints a compressed view of its output, and exits with the wrapped
 * command's exit code.
 *
 * ASYNC: `bash_runner.run` is async in the TS port (Node's spawn is event-based)
 * → `cmd_compress` is async and `cli.ts` awaits it.
 *
 * Output seam: `raise typer.Exit(code)` → `throw new CliExit(code)` (cli_common).
 */
import * as childProcess from "node:child_process";
import * as os from "node:os";

import * as bash_runner from "./bash_runner.js";
import { CliExit } from "./cli_common.js";

/** Run a shell command and emit a compressed view of its output (cli.py:6476). */
export async function cmd_compress(args: {
  cmd: string;
  filter_name: string | null;
  timeout: number;
  no_compress: boolean;
  profile: string | null;
  max_tokens: number;
}): Promise<void> {
  if (args.no_compress) {
    // Stream straight through; useful for debugging the wrapper.
    const res = childProcess.spawnSync(args.cmd, { shell: true, stdio: "inherit" });
    let code = res.status ?? 0;
    if (res.status === null && res.signal) {
      code = 128 + (os.constants.signals[res.signal] ?? 15);
    }
    throw new CliExit(code);
  }

  const effectiveTimeout =
    args.timeout > 0 ? args.timeout : bash_runner.DEFAULT_TIMEOUT_SECONDS;
  const exitCode = await bash_runner.run(args.cmd, {
    filter_name: args.filter_name,
    timeout: effectiveTimeout,
    compression_profile: args.profile,
    max_tokens: args.max_tokens,
  });
  throw new CliExit(exitCode);
}
