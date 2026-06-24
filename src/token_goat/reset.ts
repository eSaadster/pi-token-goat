/**
 * Cache-clearing test seam for the token-goat TS port.
 *
 * Python's tests/conftest.py clears module-global caches (paths._DATA_DIR_CACHE,
 * config._config_mtime_cache, session._proc_load_cache, compact's several TTL
 * caches, ...) by monkeypatching the module attributes directly. JS cannot do
 * that: a `let _cache = ...` in an ES module is private to that module, so a
 * test in another file cannot reach in and null it out. Instead, every port
 * module that owns mutable module-global state registers a reset function here
 * at load time, and every test's beforeEach calls clearModuleCaches() to wipe
 * them all back to their freshly-imported state.
 *
 * This module also owns the paths.ts dataDir() override. In Python, paths.py
 * computes _DATA_DIR_CACHE once at import and never re-reads the environment;
 * tests that need a temp data dir instead use the isolate_data_dir autouse
 * fixture, which monkeypatches the module global. The TS port mirrors this with
 * an explicit override slot read by paths.ts's dataDir() getter: tests call
 * setDataDirOverride(tmpDir) to redirect, and clearDataDirOverride() to restore
 * the default. The override is itself registered with registerReset so that
 * clearModuleCaches() (called in the same beforeEach) returns the data dir to
 * its platform default too.
 *
 * Faithful port of the cache-invalidation contract implied by
 * src/token_goat/{paths,config,session,compact}.py + tests/conftest.py. Pure,
 * dependency-free, sync. No relative imports (it is the shared root that other
 * port modules import from, so pulling anything in here would either cycle or
 * bias load order).
 *
 * Parity notes:
 *  - resetRegistry is a Set, not a Map: registration is idempotent (the same
 *    fn reference registered twice clears once), iteration order is insertion
 *    order, and there is no per-fn identity the caller cares about. This
 *    matches Python's "list of fns cleared on each test reset" model without
 *    the bookkeeping of a key.
 *  - clearModuleCaches runs each fn in its own try/catch. A single module's
 *    buggy reset (e.g. referencing a not-yet-initialised field) must not mask
 *    the resets of every other module, or test failures cascade into
 *    "everything is dirty" noise that obscures the real cause. Errors are
 *    collected and re-thrown after every fn has had its chance, so a test
 *    still fails loudly but the remaining caches stay clean for the next run.
 *  - exactOptionalPropertyTypes is on, so getDataDirOverride returns
 *    `string | undefined` (never an implicit `string | null`) and the setter
 *    takes `string | undefined`. Passing undefined clears the slot, matching
 *    paths.py's `_hooks_stderr_log_override: Path | None = None` convention.
 */

/**
 * Registry of reset functions, one per port module that owns mutable
 * module-global cache state. Modules register at load time:
 *
 *   import { registerReset } from "./reset.js";
 *   let _cache: X | null = null;
 *   registerReset(() => { _cache = null; });
 *
 * A Set (not a Map): registration is idempotent by fn reference, iteration is
 * insertion-order, and no per-fn key is needed.
 */
export const resetRegistry = new Set<() => void>();

/**
 * Register a cache-clearing function. Idempotent by fn reference — registering
 * the same arrow / named function twice is a no-op on the second call, so it
 * is safe for a module to call this at top level on every load.
 *
 * @param fn Zero-arg function that resets the registering module's mutable
 *   globals to their freshly-imported state. Must not throw under normal
 *   conditions; if it does, clearModuleCaches() isolates the failure (see its
 *   docstring) but the offending module's cache will remain stale for that
 *   clear cycle.
 */
export function registerReset(fn: () => void): void {
  resetRegistry.add(fn);
}

/**
 * Run every registered reset function, each in its own try/catch.
 *
 * Called by every test's beforeEach (and by hand from any code path that needs
 * a clean cache slate). One throwing reset does not stop the rest — errors are
 * collected and, if any occurred, re-thrown as a single Error after every fn
 * has run, so the remaining caches are still cleared and the next test starts
 * from a clean slate rather than cascading "dirty cache" failures.
 *
 * The aggregated error chains the first thrown reset's message via `cause` so
 * the original stack is preserved for diagnosis. If multiple resets throw,
 * subsequent messages are appended to the Error.message rather than chained
 * (Error.cause is a single link, not a list).
 */
export function clearModuleCaches(): void {
  const errors: unknown[] = [];
  for (const fn of resetRegistry) {
    try {
      fn();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    const first = errors[0]!;
    const head =
      first instanceof Error ? first.message : String(first);
    const message =
      errors.length === 1
        ? `clearModuleCaches: a reset function threw: ${head}`
        : `clearModuleCaches: ${errors.length} reset functions threw; first: ${head}`;
    throw new Error(message, { cause: first });
  }
}

// ---------------------------------------------------------------------------
// paths.ts dataDir() override test seam
// ---------------------------------------------------------------------------
// In Python, tests redirect the data directory by monkeypatching the
// _DATA_DIR_CACHE module global (computed once at import in paths.py). The TS
// port cannot monkeypatch a module-private `let`, so paths.ts's dataDir()
// getter consults this override slot first; when it is undefined, dataDir()
// falls back to computing (and caching) the platform default, mirroring
// paths.py's _default_data_dir() + _DATA_DIR_CACHE behaviour.
//
// Tests call setDataDirOverride(tmpDir) in their setup and rely on
// clearModuleCaches() (which runs clearDataDirOverride via the registration
// below) to restore the default on teardown.

/** @internal Current data-dir override, or undefined when the platform default is in effect. */
let _dataDirOverride: string | undefined = undefined;

/**
 * Return the data-dir override if one is set, else undefined.
 *
 * paths.ts's dataDir() getter calls this on every invocation; a non-undefined
 * return short-circuits the platform-default computation (and its caching) so
 * a test's tmp_path override is observed immediately, without process restart.
 */
export function getDataDirOverride(): string | undefined {
  return _dataDirOverride;
}

/**
 * Set or clear the data-dir override.
 *
 * Pass an absolute path (typically a test tmp dir) to redirect all path
 * resolution under it; pass `undefined` to restore the platform default.
 * paths.ts reads the new value on its next dataDir() call — no invalidation
 * hook is needed because dataDir() checks this slot before consulting its own
 * memoised default.
 *
 * @param dir Absolute path string to override with, or undefined to clear.
 */
export function setDataDirOverride(dir: string | undefined): void {
  _dataDirOverride = dir;
}

/**
 * Clear the data-dir override, restoring the platform default.
 *
 * Equivalent to setDataDirOverride(undefined). Exposed as its own named
 * function so the clear-module-caches registration below reads as intent
 * ("clear the data-dir override") rather than a call-site that happens to pass
 * undefined.
 */
export function clearDataDirOverride(): void {
  _dataDirOverride = undefined;
}

// Register the data-dir override reset so clearModuleCaches() — called by
// every test's beforeEach — returns the data dir to its platform default as
// part of the same wipe that clears every other module's caches. Registered
// once at module load; idempotent under re-registration.
registerReset(clearDataDirOverride);
