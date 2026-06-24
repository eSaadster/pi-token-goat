/**
 * token-goat package version — port of src/token_goat/__init__.py.
 *
 * Python resolves `__version__` lazily via PEP 562 module `__getattr__` +
 * importlib.metadata, deferring a ~60 ms cold-start cost away from the hook
 * hot path. The TS equivalent reads the sibling package.json once at module
 * load — cheap (a single small readFileSync), no importlib.metadata analogue
 * needed. Cached in a module-level constant after first resolution.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the package version from the sibling package.json.
 *
 * Falls back to "0.0.0" if the file is missing/unreadable or has no version
 * field — mirroring Python's PackageNotFoundError -> "0.0.0.dev0" (the TS port
 * uses plain "0.0.0" as its zero value; the seed package.json is
 * "0.0.0-seed"). Never throws: version is needed by --version output and must
 * not crash a hook dispatch if the install layout is unusual.
 */
function resolveVersion(): string {
  try {
    // This file lives at src/token_goat/version.ts; package.json is two levels up.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    const v = pkg.version;
    return typeof v === "string" && v.length > 0 ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The token-goat package version string (e.g. "0.0.0-seed"), read once at load. */
export const __version__: string = resolveVersion();
