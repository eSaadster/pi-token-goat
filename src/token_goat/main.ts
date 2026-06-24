/**
 * CLI entry point — port of src/token_goat/__main__.py (`from .cli import app; app()`).
 *
 * Delegates argv parsing + dispatch to cli.ts (the commander app). `main` is
 * ASYNC because the CLI dispatch (hook handlers run through `safe_run`) is
 * async. It returns the process exit code rather than calling `process.exit`,
 * so it stays unit-testable; the entry guard below propagates the code when the
 * module is executed directly.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as cli from "./cli.js";

export { main };

/**
 * True when this module is the process entry point — robust to symlinks.
 *
 * When token-goat is installed as an npm bin, the executable
 * (`~/.npm-global/bin/token-goat`) is a SYMLINK to the bundle, so
 * `process.argv[1]` is the unresolved symlink path while `import.meta.url` is
 * the symlink-RESOLVED real path. A raw URL compare misses, `main()` never
 * runs, and every command silently no-ops (exit 0, no output). Resolving
 * symlinks on both sides via realpathSync fixes that; the URL compare is the
 * fallback when argv[1] is not a real file.
 */
function _isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(argv1).href;
  }
}

/**
 * Run the token-goat CLI.
 *
 * @param argv Optional argv slice; defaults to process.argv.slice(2) exactly as
 *   a `node` invocation would receive it.
 * @returns Process exit code (0 = success). Delegates to cli.main, which wraps
 *   cli.run with the hook-subcommand SystemExit guard.
 */
async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return cli.main(argv);
}

// Process entry: when executed directly (`node main.js`), run and propagate the
// exit code. Guarded so importing this module (e.g. from tests) never triggers a
// run — under vitest, process.argv[1] is the runner, not this file.
if (_isMainModule()) {
  void main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${String(e)}\n`);
      process.exit(1);
    },
  );
}
