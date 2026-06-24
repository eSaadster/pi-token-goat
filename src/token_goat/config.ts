/**
 * Config loader/saver for token-goat. Reads/writes TOML at paths.configPath().
 *
 * Faithful port of src/token_goat/config.py. The top-level dataclasses (the
 * ~20 section config objects) are imported as TYPE-ONLY interfaces from
 * ./types.js — they carry no runtime defaults, so this module owns the canonical
 * default values in the `makeDefault*` factories and the validation helpers.
 * The TS port drops the separate "section dataclass vs. section TypedDict"
 * split Python needed (TS interfaces erase at runtime, so one shape serves both
 * roles); the runtime defaults live here.
 *
 * What is preserved verbatim from the Python source:
 *  - `load()` process-level mtime + env-fingerprint singleton cache. The cache
 *    tuple is (Config, mtime, envFingerprint, monotonicMs) and is REGISTERED
 *    for reset via registerReset so tests/startup hooks can wipe it. save()
 *    clears the cache so the next load() re-reads from disk.
 *  - All ~30 TOKEN_GOAT_* env overrides with the SAME precedence (env wins over
 *    TOML for the integer/bool knobs it covers; TOML wins for everything else)
 *    and the SAME clamp ranges. The clamp bounds are reproduced as literal
 *    numbers next to each _validatedInt/_validatedFloat call so a future reader
 *    can audit them against config.py without cross-referencing.
 *  - The _validatedInt/_validatedFloat/_validatedBool/_validatedStrList/
 *    _validatedIntList helpers and their exact fallback semantics: wrong type
 *    or out-of-range → default (never throw); bool rejected for numeric fields;
 *    int(4.9) coerces to 4 (truncate toward zero, matching Python int()).
 *  - The default values for every section field.
 *
 * Logging: the Python module emits INFO/WARNING lines that some tests assert on
 * via caplog. The TS port forwards the same messages through the shared
 * util.ts ConsoleLogger (name "token_goat.config"), so log-text assertions
 * translate directly. Tests that checked caplog instead spy on console methods.
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → the cache tuple fields and optional
 * Config section fields are spelled without implicit undefined.
 * `noUncheckedIndexedAccess` is on → every raw[key] / array[i] is narrowed.
 */

import fs from "node:fs";

import { stringify as tomlStringify, parse as tomlParse, TomlError } from "smol-toml";

import type {
  BashCompressConfig,
  BashDiffConfig,
  CodeCompressConfig,
  CompactAssistConfig,
  CompressionConfig,
  ConfigSchema,
  ContextConfig,
  CuratorConfig,
  HintBudgetConfig,
  HintsConfig,
  HooksConfig,
  ImageShrinkConfig,
  IndexingConfig,
  OverflowGuardConfig,
  PromptTrigger,
  RepomapConfig,
  SessionBriefConfig,
  SeverityLogConfig,
  SkillPreservationConfig,
  StatsConfig,
  WebFetchConfig,
  WorkerConfig,
} from "./types.js";

import * as paths from "./paths.js";
import { getLogger } from "./util.js";
import { registerReset } from "./reset.js";

const _LOG = getLogger("config");

// ===========================================================================
// Public constants
// ===========================================================================

/** Hard ceiling for worker.max_pool_workers — applied after config load + env. */
export const WORKER_MAX_POOL_CEILING = 8;

/** Current config schema version. Bumped when the TOML shape changes in a way
 *  that would silently misparse an older file. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Valid trigger strings for compact_assist.triggers. */
const _VALID_TRIGGERS = new Set<string>(["manual", "auto"]);

/** Falsy env-var spellings that disable an opt-out feature. */
const _FALSY_ENV_VALUES = new Set<string>(["0", "false", "no", "off"]);
/** Truthy env-var spellings that enable an opt-in feature. */
const _TRUTHY_ENV_VALUES = new Set<string>(["1", "true", "yes", "on"]);

/** Valid compression.profile values. */
const _VALID_COMPRESSION_PROFILES = new Set<string>([
  "auto",
  "aggressive",
  "balanced",
  "minimal",
]);

/** Valid compact_assist.harness values. */
const _VALID_HARNESS_VALUES = new Set<string>([
  "auto",
  "claudecode",
  "codex",
  "opencode",
  "generic",
]);

/** Every top-level TOML section token-goat recognises (typo detection). */
export const _KNOWN_SECTIONS = new Set<string>([
  "schema_version",
  "compact_assist",
  "bash_compress",
  "session_brief",
  "skill_preservation",
  "image_shrink",
  "curator",
  "hint_budget",
  "repomap",
  "overflow_guard",
  "stats",
  "hints",
  "hooks",
  "webfetch",
  "worker",
  "indexing",
  "compression",
  "context",
  "bash_diff",
  "bash_severity_log",
]);

// ===========================================================================
// Env-var name constants (verbatim from config.py)
// ===========================================================================

const _ENV_COMPACT_ASSIST = "TOKEN_GOAT_COMPACT_ASSIST";
const _ENV_COMPACT_ASSIST_LEGACY = "TOKENWISE_COMPACT_ASSIST";
const _ENV_BASH_COMPRESS = "TOKEN_GOAT_BASH_COMPRESS";
const _ENV_SESSION_BRIEF = "TOKEN_GOAT_SESSION_BRIEF";
const _ENV_SKILL_PRESERVATION = "TOKEN_GOAT_SKILL_PRESERVATION";
const _ENV_PREFER_AVIF = "TOKEN_GOAT_PREFER_AVIF";
const _ENV_ORPHAN_SWEEP = "TOKEN_GOAT_ORPHAN_SWEEP";
const _ENV_CURATOR = "TOKEN_GOAT_CURATOR";
const _ENV_HINT_BUDGET = "TOKEN_GOAT_HINT_BUDGET";
const _ENV_HINT_JSON_SIDECAR = "TOKEN_GOAT_HINT_JSON_SIDECAR";
const _ENV_BASH_DEDUP_MIN_BYTES = "TOKEN_GOAT_BASH_DEDUP_MIN_BYTES";
const _ENV_WEB_DEDUP_MIN_BYTES = "TOKEN_GOAT_WEB_DEDUP_MIN_BYTES";
const _ENV_GREP_DEDUP_MIN_MATCHES = "TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES";
const _ENV_LARGE_READ_BYTES = "TOKEN_GOAT_LARGE_READ_BYTES";
const _ENV_BASELINE_BUDGET_TOKENS = "TOKEN_GOAT_BASELINE_BUDGET_TOKENS";
const _ENV_REPOMAP_COMPACT_THRESHOLD = "TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD";
const _ENV_WEB_CACHE_MAX_FILES = "TOKEN_GOAT_WEB_CACHE_MAX_FILES";
const _ENV_WEB_CACHE_MAX_BYTES = "TOKEN_GOAT_WEB_CACHE_MAX_BYTES";
const _ENV_WEB_COMPRESS = "TOKEN_GOAT_WEB_COMPRESS";
const _ENV_BASH_CACHE_MIN_BYTES = "TOKEN_GOAT_BASH_CACHE_MIN_BYTES";
const _ENV_BASH_CACHE_MAX_FILES = "TOKEN_GOAT_BASH_CACHE_MAX_FILES";
const _ENV_BASH_CACHE_MAX_BYTES = "TOKEN_GOAT_BASH_CACHE_MAX_BYTES";
const _ENV_BASH_CACHE_MAX_BYTES_PER_OUTPUT = "TOKEN_GOAT_BASH_CACHE_MAX_BYTES_PER_OUTPUT";
const _ENV_WORKER_WATCHDOG = "TOKEN_GOAT_WORKER_WATCHDOG";
const _ENV_WORKER_MAX_POOL = "TOKEN_GOAT_WORKER_MAX_POOL";
const _ENV_COMPRESS_PROFILE = "TOKEN_GOAT_COMPRESS_PROFILE";
const _ENV_SKILL_COMPRESS = "TOKEN_GOAT_SKILL_COMPRESS";
const _ENV_LAZY_SKILL_INJECTION = "TOKEN_GOAT_LAZY_SKILL_INJECTION";
const _ENV_SERVE_DIFF_ON_REREAD = "TOKEN_GOAT_SERVE_DIFF_ON_REREAD";
const _ENV_OVERFLOW_GUARD = "TOKEN_GOAT_OVERFLOW_GUARD";
const _ENV_OVERFLOW_MAX_TOKENS = "TOKEN_GOAT_OVERFLOW_MAX_TOKENS";

/**
 * Env vars that affect the parsed Config result. Changes to any of these bust
 * the process-level cache even when the TOML file has not changed on disk
 * (common in tests that set/unset TOKEN_GOAT_* between hook calls).
 */
const _CONFIG_ENV_KEYS: readonly string[] = [
  _ENV_COMPACT_ASSIST,
  _ENV_COMPACT_ASSIST_LEGACY,
  _ENV_BASH_COMPRESS,
  _ENV_SESSION_BRIEF,
  _ENV_SKILL_PRESERVATION,
  _ENV_PREFER_AVIF,
  _ENV_ORPHAN_SWEEP,
  _ENV_CURATOR,
  _ENV_HINT_BUDGET,
  _ENV_HINT_JSON_SIDECAR,
  _ENV_BASH_DEDUP_MIN_BYTES,
  _ENV_WEB_DEDUP_MIN_BYTES,
  _ENV_GREP_DEDUP_MIN_MATCHES,
  _ENV_REPOMAP_COMPACT_THRESHOLD,
  _ENV_WEB_CACHE_MAX_FILES,
  _ENV_WEB_CACHE_MAX_BYTES,
  _ENV_WEB_COMPRESS,
  _ENV_BASH_CACHE_MIN_BYTES,
  _ENV_BASH_CACHE_MAX_FILES,
  _ENV_BASH_CACHE_MAX_BYTES,
  _ENV_BASH_CACHE_MAX_BYTES_PER_OUTPUT,
  _ENV_WORKER_WATCHDOG,
  _ENV_WORKER_MAX_POOL,
  "TOKEN_GOAT_HOOK_WATCHDOG_MS",
  _ENV_COMPRESS_PROFILE,
  _ENV_SKILL_COMPRESS,
  _ENV_LAZY_SKILL_INJECTION,
  _ENV_SERVE_DIFF_ON_REREAD,
  "TOKEN_GOAT_SESSION_HINT_MIN_BYTES",
  _ENV_LARGE_READ_BYTES,
  _ENV_OVERFLOW_GUARD,
  _ENV_OVERFLOW_MAX_TOKENS,
  _ENV_BASELINE_BUDGET_TOKENS,
];

/**
 * Return a short string encoding the current values of all config env vars.
 *
 * Used as a secondary cache key so test env-var changes (or a user exporting
 * TOKEN_GOAT_* between hook calls) bust the process-level cache without
 * requiring a filesystem change. Built by joining `key=value` pairs for every
 * config env var that is set; unset vars are omitted.
 */
function _configEnvFingerprint(): string {
  const parts: string[] = [];
  for (const key of _CONFIG_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      parts.push(`${key}=${val}`);
    }
  }
  return parts.join("|");
}

// ===========================================================================
// Process-level mtime + env-fingerprint cache (singleton, resettable).
// ===========================================================================

/**
 * Cache entry shape: [Config, mtime, envFingerprint, monotonicMs].
 * `undefined` when the cache is empty (cold).
 */
export type ConfigCacheEntry = readonly [ConfigSchema, number, string, number];

/**
 * Process-level config cache. The cache is keyed by (config_file_mtime,
 * env_fingerprint) so it invalidates on file edits AND on env-var changes.
 *
 * Exposed (mutable) so tests that need to force-bust the cache can assign
 * `_configMtimeCache = null` exactly as the Python tests assigned
 * `cfg_mod._config_mtime_cache = None`. The registerReset registration below
 * also wipes it on every clearModuleCaches() call from tests/setup.ts.
 */
export let _configMtimeCache: ConfigCacheEntry | undefined = undefined;

/**
 * Internal cache setter. `let` exports in ES modules are immutable from outside
 * the module, so config.ts owns a private setter that rebinds the exported
 * binding. load()/save() call this; tests reach in via `clearConfigCache()`.
 */
function _setCache(entry: ConfigCacheEntry | undefined): void {
  _configMtimeCache = entry;
}

/**
 * Clear the process-level config cache.
 *
 * Registered with reset.ts so clearModuleCaches() (called by every test's
 * beforeEach in tests/setup.ts) wipes the cache alongside every other module's
 * mutable globals. Also callable directly by tests that need a guaranteed-cold
 * load() within a single test body.
 */
export function clearConfigCache(): void {
  _setCache(undefined);
}

// Register the cache reset at module load. Idempotent by fn reference.
registerReset(clearConfigCache);

// ===========================================================================
// Validation helpers — exact fallback semantics from config.py
// ===========================================================================

/**
 * Coerce `val` to a number within [lo, hi], returning `default` on failure.
 *
 * Shared core for _validatedInt and _validatedFloat. Type-guard, bool-rejection,
 * conversion, range-check, fallback — identical structure to the Python helper.
 * Bool is rejected explicitly because in TOML true/false is never a sensible
 * numeric value, even though JS `Number(true) === 1`.
 *
 * @param val       Raw value from TOML (already-parsed number/string/boolean).
 * @param default   Fallback when val is the wrong type or out of range.
 * @param lo        Lower bound (inclusive).
 * @param hi        Upper bound (inclusive).
 * @param name      Human-readable field key for log messages.
 * @param convert   `Math.trunc` for int, identity for float.
 * @param typeName  `"int"` or `"float"` for log messages.
 */
function _validatedNumeric(
  val: unknown,
  defaultVal: number,
  lo: number,
  hi: number,
  name: string,
  convert: (n: number) => number,
  typeName: "int" | "float",
): number {
  if (typeof val !== "number" && typeof val !== "string") {
    _LOG.warning("config: %s=%o is not an %s; using default %s", name, val, typeName, defaultVal);
    return defaultVal;
  }
  // bool is a subtype of number in the TOML parse output (true/false arrive as
  // JS boolean). Reject explicitly — matches Python's isinstance(val, bool) guard.
  if (typeof val === "boolean") {
    _LOG.warning("config: %s=%o is not an %s; using default %s", name, val, typeName, defaultVal);
    return defaultVal;
  }
  let n: number;
  if (typeof val === "number") {
    n = val;
  } else {
    // String coercion: Python int("7")/float("0.8"). JS Number() also accepts
    // "1e3", hex, etc. — for int we additionally require the string to parse
    // cleanly. Use Number() and let the range/finite check catch the rest;
    // matches Python's int("75.0") raising ValueError → default.
    n = Number(val);
  }
  if (!Number.isFinite(n)) {
    _LOG.warning("config: %s=%o is not an %s; using default %s", name, val, typeName, defaultVal);
    return defaultVal;
  }
  const converted = convert(n);
  if (converted < lo || converted > hi) {
    _LOG.warning(
      "config: %s=%o out of range [%s, %s]; using default %s",
      name,
      val,
      lo,
      hi,
      defaultVal,
    );
    return defaultVal;
  }
  return converted;
}

/**
 * Coerce `val` to an int within [lo, hi], returning `default` on failure.
 *
 * Accepts int, float (truncated toward zero via Math.trunc, matching Python's
 * `int(4.9) == 4`), or string (via Number() with a finite check). Out-of-range
 * values and non-convertible types both fall back to default with a WARNING
 * log. Float strings like `"75.0"` are rejected (Number("75.0") === 75 is
 * finite, but Python `int("75.0")` raises) — we therefore require the string
 * to match strict integer syntax when the target type is int.
 */
export function _validatedInt(
  val: unknown,
  defaultVal: number,
  lo: number,
  hi: number,
  name: string,
): number {
  // String fast-path for strict integer syntax. Python int("75.0") raises;
  // Number("75.0") === 75 would wrongly accept it. Match Python by rejecting
  // any string that isn't /^[+-]?\d+$/ for the int path.
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      _LOG.warning("config: %s=%o is not an int; using default %s", name, val, defaultVal);
      return defaultVal;
    }
  }
  return _validatedNumeric(val, defaultVal, lo, hi, name, Math.trunc, "int");
}

/**
 * Coerce `val` to a float within [lo, hi], returning `default` on failure.
 *
 * Mirrors _validatedInt but for float fields. Bool is rejected explicitly.
 */
export function _validatedFloat(
  val: unknown,
  defaultVal: number,
  lo: number,
  hi: number,
  name: string,
): number {
  return _validatedNumeric(val, defaultVal, lo, hi, name, (n) => n, "float");
}

/**
 * Coerce `val` to a bool, returning `default` on failure.
 *
 * Accepts bool directly or int (0 → false, non-zero → true). Any other type
 * falls back to default with a WARNING log. TOML native booleans arrive as JS
 * boolean, so the common case hits the first branch with no conversion.
 */
export function _validatedBool(val: unknown, defaultVal: boolean, name: string): boolean {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "number" && !Number.isNaN(val)) {
    // Python bool(0) is False, bool(non-zero) is True. JS !!n matches except
    // JS treats NaN as false; guard with !isNaN above so the NaN path logs.
    return val !== 0;
  }
  _LOG.warning("config: %s=%o is not a bool; using default %s", name, val, defaultVal);
  return defaultVal;
}

/**
 * Validate a TOML list-of-strings, dropping non-string entries with a warning.
 *
 * Returns a fresh copy of `defaultVal` when val is not an array. Empty arrays
 * are accepted as a meaningful value (e.g. disabled_filters = [] explicitly
 * enables every filter).
 */
export function _validatedStrList(
  val: unknown,
  defaultVal: readonly string[],
  name: string,
): string[] {
  if (!Array.isArray(val)) {
    _LOG.warning("config: %s must be a list of strings; using default %s", name, defaultVal);
    return [...defaultVal];
  }
  const valid: string[] = [];
  const unknown: unknown[] = [];
  for (const item of val) {
    if (typeof item === "string") {
      valid.push(item);
    } else {
      unknown.push(item);
    }
  }
  if (unknown.length > 0) {
    _LOG.warning("config: %s contained non-string entries (ignored): %o", name, unknown);
  }
  return valid;
}

/**
 * Validate a TOML list-of-ints, dropping non-integer entries with a warning.
 *
 * Returns a fresh copy of `defaultVal` when val is not an array. Empty arrays
 * are accepted (disables the feature). Non-negative integers only; bool entries
 * are rejected (bool is a subtype of number in JS, matching Python's
 * isinstance(bool, int) guard). The returned list is always sorted ascending;
 * an out-of-order input is sorted and a WARNING is logged.
 */
export function _validatedIntList(
  val: unknown,
  defaultVal: readonly number[],
  name: string,
): number[] {
  if (!Array.isArray(val)) {
    _LOG.warning("config: %s must be a list of integers; using default %s", name, defaultVal);
    return [...defaultVal];
  }
  const valid: number[] = [];
  const invalid: unknown[] = [];
  for (const item of val) {
    if (typeof item === "boolean") {
      invalid.push(item);
    } else if (typeof item === "number" && Number.isInteger(item) && item >= 0) {
      valid.push(item);
    } else {
      invalid.push(item);
    }
  }
  if (invalid.length > 0) {
    _LOG.warning("config: %s contained invalid entries (ignored): %o", name, invalid);
  }
  const sorted = [...valid].sort((a, b) => a - b);
  // Compare element-wise against the original to decide whether to log the
  // "must be sorted" warning. JSON.stringify is a cheap deep-equal for arrays
  // of numbers.
  if (JSON.stringify(valid) !== JSON.stringify(sorted)) {
    _LOG.warning(
      "config: %s must be sorted in ascending order; got %s — using sorted: %s",
      name,
      valid,
      sorted,
    );
  }
  return sorted;
}

/**
 * Read and validate an integer from an environment variable.
 *
 * Retrieves the env var, strips whitespace, parses as int (strict /^[+-]?\d+$/
 * — rejects float strings like "75.0" exactly as Python int() does), validates
 * range, logs on success/failure, returns the validated value or default.
 *
 * Exported because Python's tests call `cfg_mod._env_int(...)` directly with
 * synthetic env vars — the TS port must expose the same symbol.
 */
export function _envInt(
  envKey: string,
  defaultVal: number,
  lo: number,
  hi: number,
  configPath: string,
): number {
  const envVal = (process.env[envKey] ?? "").trim();
  if (envVal === "") {
    return defaultVal;
  }
  // Strict integer syntax — rejects "75.0", "1e3", "0x10", "abc".
  if (!/^[+-]?\d+$/.test(envVal)) {
    _LOG.warning(
      "%s env override invalid (not an int): %s; using default %s",
      configPath,
      envVal,
      defaultVal,
    );
    return defaultVal;
  }
  const v = _validatedInt(Number(envVal), defaultVal, lo, hi, `${configPath}(env)`);
  if (v !== defaultVal) {
    _LOG.info("%s overridden by environment: %d", configPath, v);
  }
  return v;
}

/**
 * Set `obj[attr] = true` when `envKey` holds a truthy env-var value.
 *
 * Mirror of _applyEnvDisable for opt-in features whose default is false.
 * Recognises "1"/"true"/"yes"/"on" (case-insensitive, whitespace-stripped).
 * No-ops when the variable is unset or holds any other value.
 */
function _applyEnvEnable(
  obj: Record<string, unknown>,
  attr: string,
  envKey: string,
  label: string,
): void {
  const val = (process.env[envKey] ?? "").trim().toLowerCase();
  if (_TRUTHY_ENV_VALUES.has(val)) {
    _LOG.info("%s enabled by environment variable (%s=%s)", label, envKey, val);
    obj[attr] = true;
  }
}

/**
 * Set `obj[attr] = false` when `envKey` holds a falsy env-var value.
 *
 * Recognises "0"/"false"/"no"/"off" (case-insensitive, whitespace-stripped).
 * No-ops when the variable is unset or holds any other value.
 */
function _applyEnvDisable(
  obj: Record<string, unknown>,
  attr: string,
  envKey: string,
  label: string,
): void {
  const val = (process.env[envKey] ?? "").trim().toLowerCase();
  if (_FALSY_ENV_VALUES.has(val)) {
    _LOG.info("%s disabled by environment variable (%s=%s)", label, envKey, val);
    obj[attr] = false;
  }
}

/**
 * Validate the compact_assist.harness config value.
 *
 * Returns val unchanged when it is one of the recognised harness strings;
 * falls back to "auto" with a WARNING log when unrecognised.
 */
function _validatedHarness(val: unknown): string {
  if (typeof val === "string" && _VALID_HARNESS_VALUES.has(val)) {
    return val;
  }
  _LOG.warning(
    "config: compact_assist.harness=%o is not one of %s; using 'auto'",
    val,
    [..._VALID_HARNESS_VALUES].sort(),
  );
  return "auto";
}

/**
 * Validate a list of hook-trigger strings against _VALID_TRIGGERS.
 *
 * val must be an array of strings; any element not in _VALID_TRIGGERS is
 * silently dropped with a WARNING log. If val is not an array, or every element
 * is invalid, defaultVal is returned unchanged (prevents a misconfigured
 * triggers key from disabling all hooks).
 */
function _validatedTriggers(val: unknown, defaultVal: readonly string[]): string[] {
  if (!Array.isArray(val)) {
    _LOG.warning("config: triggers must be a list; using default %s", defaultVal);
    return [...defaultVal];
  }
  const valid: string[] = [];
  const unknown: unknown[] = [];
  for (const t of val) {
    if (typeof t === "string" && _VALID_TRIGGERS.has(t)) {
      valid.push(t);
    } else {
      unknown.push(t);
    }
  }
  if (unknown.length > 0) {
    _LOG.warning("config: unknown trigger values ignored: %o", unknown);
  }
  return valid.length > 0 ? valid : [...defaultVal];
}

/**
 * Parse a `[[hints.prompt_triggers]]` TOML array into PromptTrigger objects.
 *
 * Each entry must be a table with a `keywords` array-of-strings and a `hint`
 * string. Malformed entries are skipped with a warning; the rest are returned.
 * Keywords are lowercased and empty entries dropped (matches Python's
 * `[k.lower() for k in kws if k.strip()]`); hints are whitespace-stripped.
 */
function _parsePromptTriggers(val: unknown): PromptTrigger[] {
  if (!Array.isArray(val)) {
    _LOG.warning("config: hints.prompt_triggers must be a list of tables; ignoring");
    return [];
  }
  const result: PromptTrigger[] = [];
  for (let i = 0; i < val.length; i++) {
    const entry = val[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      _LOG.warning("config: hints.prompt_triggers[%d] must be a table; skipping", i);
      continue;
    }
    const tbl = entry as Record<string, unknown>;
    const kwsRaw = tbl["keywords"];
    const hintRaw = tbl["hint"];
    if (!Array.isArray(kwsRaw) || !kwsRaw.every((k) => typeof k === "string")) {
      _LOG.warning("config: hints.prompt_triggers[%d].keywords must be list[str]; skipping", i);
      continue;
    }
    if (typeof hintRaw !== "string" || hintRaw.trim() === "") {
      _LOG.warning(
        "config: hints.prompt_triggers[%d].hint must be a non-empty string; skipping",
        i,
      );
      continue;
    }
    const keywords = (kwsRaw as string[])
      .filter((k) => k.trim() !== "")
      .map((k) => k.toLowerCase());
    result.push({ keywords, hint: hintRaw.trim() });
  }
  return result;
}

// ===========================================================================
// Helpers for typed extraction from the raw TOML dict.
// ===========================================================================

/**
 * Return `raw[key]` cast to unknown, or undefined when absent.
 *
 * The TOML parser yields `Record<string, unknown>`; each section lookup goes
 * through here so the noUncheckedIndexedAccess narrowing is applied uniformly.
 */
function _section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = raw[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return {};
  }
  return v as Record<string, unknown>;
}

// ===========================================================================
// load() — parse TOML, apply defaults + validation + env overrides, cache.
// ===========================================================================

/**
 * Load config from TOML. Returns defaults if the file is absent or unreadable.
 *
 * A process-level mtime+env-fingerprint cache avoids re-parsing the TOML file
 * on every call. The first call per process pays the full cost; subsequent
 * calls within the same process pay one fs.statSync (~0.1ms) instead of stat +
 * read + parse. The cache is invalidated when the config file's mtime changes
 * OR when any config-affecting env var changes value, so edits and test env
 * monkeypatches take effect on the next call.
 *
 * The cache is a singleton: load() returns the SAME ConfigSchema object across
 * calls until the cache busts (the Python `c1 is c2` identity invariant).
 */
export function load(): ConfigSchema {
  const p = paths.configPath();

  // Fast path: stat the file, compare (mtime, env_fingerprint) to the cache.
  let currentMtime: number;
  try {
    currentMtime = fs.statSync(p).mtimeMs;
  } catch {
    // FileNotFoundError or permission error — treat as mtime 0.0 (absent).
    currentMtime = 0.0;
  }
  const currentEnvFp = _configEnvFingerprint();
  if (_configMtimeCache !== undefined) {
    const [cachedCfg, cachedMtime, cachedEnvFp] = _configMtimeCache;
    if (currentMtime === cachedMtime && currentEnvFp === cachedEnvFp) {
      return cachedCfg;
    }
  }

  let raw: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    try {
      const text = fs.readFileSync(p, "utf8");
      const parsed = tomlParse(text);
      // smol-toml yields a Record<string, unknown> shape; validate the runtime
      // type before indexing.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        _LOG.warning("config load failed for %s (parsed root is not a table); using defaults", p);
        raw = {};
      } else {
        raw = parsed as Record<string, unknown>;
        _LOG.info("config loaded from file: %s", p);
      }
    } catch (e) {
      if (e instanceof TomlError) {
        _LOG.warning("config load failed for %s (%s); using defaults", p, e.message);
      } else {
        _LOG.warning("config load failed for %s (%s); using defaults", p, (e as Error).message);
      }
      raw = {};
    }
  } else {
    _LOG.info("config file not found at %s; using all defaults", p);
  }

  // Warn on any top-level keys token-goat doesn't recognise — almost always a
  // typo (e.g. [compact_assit] instead of [compact_assist]). Warn rather than
  // crash so the rest of the config remains effective.
  for (const sectionKey of Object.keys(raw)) {
    if (!_KNOWN_SECTIONS.has(sectionKey)) {
      _LOG.warning(
        "unknown config section: %o — check config.toml for typos (known sections: %s)",
        sectionKey,
        [..._KNOWN_SECTIONS].sort().join(", "),
      );
    }
  }

  // schema_version forward-compat warning.
  const schemaV = raw["schema_version"];
  let schemaVInt = 0;
  if (typeof schemaV === "number") {
    schemaVInt = Math.trunc(schemaV);
  } else if (typeof schemaV === "string" && /^[+-]?\d+$/.test(schemaV.trim())) {
    schemaVInt = Number(schemaV.trim());
  }
  if (schemaVInt > CONFIG_SCHEMA_VERSION) {
    _LOG.warning(
      "config schema_version %s > current %s; some keys may be ignored",
      schemaV,
      CONFIG_SCHEMA_VERSION,
    );
  }

  const result = _buildConfig(raw);
  _setCache([result, currentMtime, currentEnvFp, _monotonicMs()]);
  return result;
}

/**
 * Return a fresh ConfigSchema of all defaults (the faithful analogue of the
 * Python `Config()` constructor — `_buildConfig({})` with no raw TOML and no
 * env overrides in effect at construction time).
 *
 * Used by the `config list`/`config reset` CLI commands to diff the current
 * config against the default baseline. Reads the live env (so a TOKEN_GOAT_*
 * override active in the process still perturbs the "default" the same way
 * Python's `Config()` did), matching the Python behaviour where env overrides
 * apply to both the default and the loaded config symmetrically.
 */
export function defaultConfig(): ConfigSchema {
  return _buildConfig({});
}

/**
 * Build a fully-validated, env-overridden ConfigSchema from a raw TOML dict.
 *
 * Hoisted out of load() so the cache-bust path can call straight through. Every
 * field default and clamp range lives here, reproduced verbatim from
 * config.py's _validatedInt / _validatedFloat call sites.
 */
function _buildConfig(raw: Record<string, unknown>): ConfigSchema {
  // ----- [compact_assist] -----
  const caRaw = _section(raw, "compact_assist");
  const ca: CompactAssistConfig = {
    enabled: _validatedBool(caRaw["enabled"], true, "compact_assist.enabled"),
    triggers: _validatedTriggers(caRaw["triggers"], ["manual", "auto"]),
    min_events: _validatedInt(caRaw["min_events"], 3, 0, 1000, "compact_assist.min_events"),
    max_manifest_tokens: _validatedInt(
      caRaw["max_manifest_tokens"],
      400,
      50,
      10000,
      "compact_assist.max_manifest_tokens",
    ),
    auto_trigger_multiplier: _validatedFloat(
      caRaw["auto_trigger_multiplier"],
      2.0,
      1.0,
      10.0,
      "compact_assist.auto_trigger_multiplier",
    ),
    // Clamp (0, 3600] seconds — the lo bound of 1.0 prevents "never skip" log spam.
    compact_skip_ttl_secs: _validatedFloat(
      caRaw["compact_skip_ttl_secs"],
      300.0,
      1.0,
      3600.0,
      "compact_assist.compact_skip_ttl_secs",
    ),
    noise_floor_tokens: _validatedInt(
      caRaw["noise_floor_tokens"],
      0,
      0,
      10000,
      "compact_assist.noise_floor_tokens",
    ),
    edited_dir_group_threshold: _validatedInt(
      caRaw["edited_dir_group_threshold"],
      3,
      0,
      100,
      "compact_assist.edited_dir_group_threshold",
    ),
    max_section_lines: _validatedInt(
      caRaw["max_section_lines"],
      0,
      0,
      10000,
      "compact_assist.max_section_lines",
    ),
    wide_session_threshold: _validatedInt(
      caRaw["wide_session_threshold"],
      15,
      1,
      10000,
      "compact_assist.wide_session_threshold",
    ),
    orchestrator_commit_threshold: _validatedInt(
      caRaw["orchestrator_commit_threshold"],
      5,
      1,
      10000,
      "compact_assist.orchestrator_commit_threshold",
    ),
    lazy_skill_injection: _validatedBool(
      caRaw["lazy_skill_injection"],
      true,
      "compact_assist.lazy_skill_injection",
    ),
    max_manifest_chars: _validatedInt(
      caRaw["max_manifest_chars"],
      1600,
      0,
      16000,
      "compact_assist.max_manifest_chars",
    ),
    harness: _validatedHarness(caRaw["harness"] ?? "auto"),
  };
  // Env: TOKEN_GOAT_COMPACT_ASSIST=0/false/no/off disables. Also accept the
  // legacy TOKENWISE_COMPACT_ASSIST alias when the canonical key is unset.
  const caEnvKey =
    process.env[_ENV_COMPACT_ASSIST] !== undefined
      ? _ENV_COMPACT_ASSIST
      : _ENV_COMPACT_ASSIST_LEGACY;
  _applyEnvDisable(ca as unknown as Record<string, unknown>, "enabled", caEnvKey, "compact_assist");
  _applyEnvDisable(
    ca as unknown as Record<string, unknown>,
    "lazy_skill_injection",
    _ENV_LAZY_SKILL_INJECTION,
    "compact_assist.lazy_skill_injection",
  );

  // ----- [bash_compress] -----
  const bcRaw = _section(raw, "bash_compress");
  const bc: BashCompressConfig = {
    enabled: _validatedBool(bcRaw["enabled"], true, "bash_compress.enabled"),
    disabled_filters: _validatedStrList(bcRaw["disabled_filters"], [], "bash_compress.disabled_filters"),
    max_lines: _validatedInt(bcRaw["max_lines"], 1000, 50, 100_000, "bash_compress.max_lines"),
    max_bytes: _validatedInt(
      bcRaw["max_bytes"],
      64 * 1024,
      1024,
      16 * 1024 * 1024,
      "bash_compress.max_bytes",
    ),
    timeout_seconds: _validatedInt(
      bcRaw["timeout_seconds"],
      600,
      5,
      7200,
      "bash_compress.timeout_seconds",
    ),
    cache_min_bytes: _validatedInt(
      bcRaw["cache_min_bytes"],
      0,
      0,
      100 * 1024 * 1024,
      "bash_compress.cache_min_bytes",
    ),
    cache_max_file_count: _validatedInt(
      bcRaw["cache_max_file_count"],
      4096,
      1,
      1_000_000,
      "bash_compress.cache_max_file_count",
    ),
    cache_max_bytes: _validatedInt(
      bcRaw["cache_max_bytes"],
      16 * 1024 * 1024,
      1024,
      4 * 1024 * 1024 * 1024,
      "bash_compress.cache_max_bytes",
    ),
    cache_max_bytes_per_output: _validatedInt(
      bcRaw["cache_max_bytes_per_output"],
      50 * 1024 * 1024,
      1024,
      4 * 1024 * 1024 * 1024,
      "bash_compress.cache_max_bytes_per_output",
    ),
  };
  _applyEnvDisable(bc as unknown as Record<string, unknown>, "enabled", _ENV_BASH_COMPRESS, "bash_compress");
  bc.cache_min_bytes = _envInt(
    _ENV_BASH_CACHE_MIN_BYTES,
    bc.cache_min_bytes!,
    0,
    4 * 1024 * 1024 * 1024,
    "bash_compress.cache_min_bytes",
  );
  bc.cache_max_file_count = _envInt(
    _ENV_BASH_CACHE_MAX_FILES,
    bc.cache_max_file_count!,
    1,
    1_000_000,
    "bash_compress.cache_max_file_count",
  );
  bc.cache_max_bytes = _envInt(
    _ENV_BASH_CACHE_MAX_BYTES,
    bc.cache_max_bytes!,
    1024,
    4 * 1024 * 1024 * 1024,
    "bash_compress.cache_max_bytes",
  );
  bc.cache_max_bytes_per_output = _envInt(
    _ENV_BASH_CACHE_MAX_BYTES_PER_OUTPUT,
    bc.cache_max_bytes_per_output!,
    1024,
    4 * 1024 * 1024 * 1024,
    "bash_compress.cache_max_bytes_per_output",
  );

  // ----- [session_brief] -----
  const sbRaw = _section(raw, "session_brief");
  const sb: SessionBriefConfig = {
    enabled: _validatedBool(sbRaw["enabled"], true, "session_brief.enabled"),
  };
  _applyEnvDisable(sb as unknown as Record<string, unknown>, "enabled", _ENV_SESSION_BRIEF, "session_brief");

  // ----- [skill_preservation] -----
  const spRaw = _section(raw, "skill_preservation");
  const sp: SkillPreservationConfig = {
    enabled: _validatedBool(spRaw["enabled"], true, "skill_preservation.enabled"),
    max_cache_bytes: _validatedInt(
      spRaw["max_cache_bytes"],
      5 * 1024 * 1024,
      64 * 1024, // 64 KB floor — must hold at least one tiny skill
      512 * 1024 * 1024, // 512 MB ceiling
      "skill_preservation.max_cache_bytes",
    ),
    orphan_sweep_enabled: _validatedBool(
      spRaw["orphan_sweep_enabled"],
      true,
      "skill_preservation.orphan_sweep_enabled",
    ),
    orphan_age_secs: _validatedInt(
      spRaw["orphan_age_secs"],
      604800,
      1,
      2_592_000,
      "skill_preservation.orphan_age_secs",
    ),
    truncation_budget_tokens: _validatedInt(
      spRaw["truncation_budget_tokens"],
      800,
      0,
      8000,
      "skill_preservation.truncation_budget_tokens",
    ),
    compress_bodies: _validatedBool(
      spRaw["compress_bodies"],
      true,
      "skill_preservation.compress_bodies",
    ),
    compress_min_bytes: _validatedInt(
      spRaw["compress_min_bytes"],
      16 * 1024,
      1024,
      10 * 1024 * 1024,
      "skill_preservation.compress_min_bytes",
    ),
    inline_snippets: _validatedBool(
      spRaw["inline_snippets"],
      true,
      "skill_preservation.inline_snippets",
    ),
    pre_skill_enabled: _validatedBool(
      spRaw["pre_skill_enabled"],
      true,
      "skill_preservation.pre_skill_enabled",
    ),
    first_load_compact: _validatedBool(
      spRaw["first_load_compact"],
      false,
      "skill_preservation.first_load_compact",
    ),
    post_compact_full_loads: _validatedBool(
      spRaw["post_compact_full_loads"],
      false,
      "skill_preservation.post_compact_full_loads",
    ),
  };
  _applyEnvDisable(
    sp as unknown as Record<string, unknown>,
    "enabled",
    _ENV_SKILL_PRESERVATION,
    "skill_preservation",
  );
  _applyEnvDisable(
    sp as unknown as Record<string, unknown>,
    "orphan_sweep_enabled",
    _ENV_ORPHAN_SWEEP,
    "skill_preservation.orphan_sweep_enabled",
  );
  _applyEnvDisable(
    sp as unknown as Record<string, unknown>,
    "compress_bodies",
    _ENV_SKILL_COMPRESS,
    "skill_preservation.compress_bodies",
  );
  _applyEnvDisable(
    sp as unknown as Record<string, unknown>,
    "pre_skill_enabled",
    "TOKEN_GOAT_PRE_SKILL",
    "skill_preservation.pre_skill_enabled",
  );

  // ----- [image_shrink] -----
  const isRaw = _section(raw, "image_shrink");
  const isCfg: ImageShrinkConfig = {
    prefer_avif: _validatedBool(isRaw["prefer_avif"], true, "image_shrink.prefer_avif"),
    avif_quality: _validatedInt(isRaw["avif_quality"], 60, 1, 100, "image_shrink.avif_quality"),
    jpeg_quality: _validatedInt(isRaw["jpeg_quality"], 75, 1, 100, "image_shrink.jpeg_quality"),
    max_image_pixels: _validatedInt(
      isRaw["max_image_pixels"],
      16_000_000,
      0,
      500_000_000,
      "image_shrink.max_image_pixels",
    ),
    orphan_sweep_enabled: _validatedBool(
      isRaw["orphan_sweep_enabled"],
      true,
      "image_shrink.orphan_sweep_enabled",
    ),
    orphan_age_secs: _validatedInt(
      isRaw["orphan_age_secs"],
      604800,
      1,
      2_592_000,
      "image_shrink.orphan_age_secs",
    ),
    screenshot_redirect: _validatedBool(
      isRaw["screenshot_redirect"],
      true,
      "image_shrink.screenshot_redirect",
    ),
  };
  _applyEnvDisable(
    isCfg as unknown as Record<string, unknown>,
    "prefer_avif",
    _ENV_PREFER_AVIF,
    "image_shrink.prefer_avif",
  );
  _applyEnvDisable(
    isCfg as unknown as Record<string, unknown>,
    "orphan_sweep_enabled",
    _ENV_ORPHAN_SWEEP,
    "image_shrink.orphan_sweep_enabled",
  );

  // ----- [curator] -----
  const curRaw = _section(raw, "curator");
  const cur: CuratorConfig = {
    enabled: _validatedBool(curRaw["enabled"], true, "curator.enabled"),
    min_samples: _validatedInt(curRaw["min_samples"], 10, 1, 10_000, "curator.min_samples"),
    threshold_pct: _validatedInt(curRaw["threshold_pct"], 20, 0, 100, "curator.threshold_pct"),
  };
  _applyEnvDisable(cur as unknown as Record<string, unknown>, "enabled", _ENV_CURATOR, "curator");

  // ----- [hint_budget] -----
  const hbRaw = _section(raw, "hint_budget");
  const hb: HintBudgetConfig = {
    enabled: _validatedBool(hbRaw["enabled"], true, "hint_budget.enabled"),
    max_per_session: _validatedInt(
      hbRaw["max_per_session"],
      100,
      0,
      1_000_000,
      "hint_budget.max_per_session",
    ),
    max_structured_per_session: _validatedInt(
      hbRaw["max_structured_per_session"],
      30,
      0,
      1_000_000,
      "hint_budget.max_structured_per_session",
    ),
    max_index_only_per_session: _validatedInt(
      hbRaw["max_index_only_per_session"],
      30,
      0,
      1_000_000,
      "hint_budget.max_index_only_per_session",
    ),
  };
  _applyEnvDisable(
    hb as unknown as Record<string, unknown>,
    "enabled",
    _ENV_HINT_BUDGET,
    "hint_budget",
  );

  // ----- [repomap] -----
  const rmRaw = _section(raw, "repomap");
  const rm: RepomapConfig = {
    compact_file_threshold: _validatedInt(
      rmRaw["compact_file_threshold"],
      50,
      0,
      100_000,
      "repomap.compact_file_threshold",
    ),
    exclude_tests: _validatedBool(rmRaw["exclude_tests"], true, "repomap.exclude_tests"),
  };
  rm.compact_file_threshold = _envInt(
    _ENV_REPOMAP_COMPACT_THRESHOLD,
    rm.compact_file_threshold!,
    0,
    100_000,
    "repomap.compact_file_threshold",
  );

  // ----- [overflow_guard] -----
  const ogRaw = _section(raw, "overflow_guard");
  const og: OverflowGuardConfig = {
    enabled: _validatedBool(ogRaw["enabled"], true, "overflow_guard.enabled"),
    max_tokens: _validatedInt(ogRaw["max_tokens"], 25000, 0, 10_000_000, "overflow_guard.max_tokens"),
  };
  _applyEnvDisable(
    og as unknown as Record<string, unknown>,
    "enabled",
    _ENV_OVERFLOW_GUARD,
    "overflow_guard.enabled",
  );
  og.max_tokens = _envInt(
    _ENV_OVERFLOW_MAX_TOKENS,
    og.max_tokens!,
    0,
    10_000_000,
    "overflow_guard.max_tokens",
  );

  // ----- [stats] -----
  const statsRaw = _section(raw, "stats");
  const stats: StatsConfig = {
    record_zero_savings: _validatedBool(
      statsRaw["record_zero_savings"],
      false,
      "stats.record_zero_savings",
    ),
  };

  // ----- [hints] -----
  const hintsRaw = _section(raw, "hints");
  const hintsCfg: HintsConfig = {
    suppress_after_ignored: _validatedInt(
      hintsRaw["suppress_after_ignored"],
      5,
      0,
      1000,
      "hints.suppress_after_ignored",
    ),
    quiet_hours: String(hintsRaw["quiet_hours"] ?? "").trim(),
    json_sidecar: _validatedBool(hintsRaw["json_sidecar"], false, "hints.json_sidecar"),
    verbose_until_seen_count: _validatedInt(
      hintsRaw["verbose_until_seen_count"],
      2,
      0,
      1000,
      "hints.verbose_until_seen_count",
    ),
    min_file_lines_for_hint: _validatedInt(
      hintsRaw["min_file_lines_for_hint"],
      0,
      0,
      100000,
      "hints.min_file_lines_for_hint",
    ),
    bash_dedup_min_bytes: _validatedInt(
      hintsRaw["bash_dedup_min_bytes"],
      200,
      0,
      100000,
      "hints.bash_dedup_min_bytes",
    ),
    web_dedup_min_bytes: _validatedInt(
      hintsRaw["web_dedup_min_bytes"],
      200,
      0,
      100000,
      "hints.web_dedup_min_bytes",
    ),
    grep_dedup_min_matches: _validatedInt(
      hintsRaw["grep_dedup_min_matches"],
      5,
      0,
      100000,
      "hints.grep_dedup_min_matches",
    ),
    serve_diff_on_reread: _validatedBool(
      hintsRaw["serve_diff_on_reread"],
      false,
      "hints.serve_diff_on_reread",
    ),
    backoff_thresholds: _validatedIntList(
      hintsRaw["backoff_thresholds"],
      [1, 3, 10, 30],
      "hints.backoff_thresholds",
    ),
    git_hint_max_ms: _validatedInt(
      hintsRaw["git_hint_max_ms"],
      50,
      0,
      10000,
      "hints.git_hint_max_ms",
    ),
    min_session_hint_savings_bytes: _validatedInt(
      hintsRaw["min_session_hint_savings_bytes"],
      512,
      0,
      1_000_000,
      "hints.min_session_hint_savings_bytes",
    ),
    pre_skill_advisory: _validatedBool(
      hintsRaw["pre_skill_advisory"],
      true,
      "hints.pre_skill_advisory",
    ),
    context_threshold_advisory: _validatedBool(
      hintsRaw["context_threshold_advisory"],
      true,
      "hints.context_threshold_advisory",
    ),
    diff_hint_min_tokens_saved: _validatedInt(
      hintsRaw["diff_hint_min_tokens_saved"],
      1000,
      0,
      100_000,
      "hints.diff_hint_min_tokens_saved",
    ),
    large_read_redirect_bytes: _validatedInt(
      hintsRaw["large_read_redirect_bytes"],
      45_000,
      0,
      100_000_000,
      "hints.large_read_redirect_bytes",
    ),
    reread_deny: _validatedBool(hintsRaw["reread_deny"], true, "hints.reread_deny"),
    reread_deny_min_bytes: _validatedInt(
      hintsRaw["reread_deny_min_bytes"],
      2048,
      0,
      100_000_000,
      "hints.reread_deny_min_bytes",
    ),
    baseline_budget_tokens: _validatedInt(
      hintsRaw["baseline_budget_tokens"],
      0,
      0,
      10_000_000,
      "hints.baseline_budget_tokens",
    ),
    stable_doc_compacts: _validatedBool(
      hintsRaw["stable_doc_compacts"],
      true,
      "hints.stable_doc_compacts",
    ),
    truncated_read_min_lines: _validatedInt(
      hintsRaw["truncated_read_min_lines"],
      200,
      0,
      1_000_000,
      "hints.truncated_read_min_lines",
    ),
    protect_recent_reads: _validatedInt(
      hintsRaw["protect_recent_reads"],
      4,
      0,
      100,
      "hints.protect_recent_reads",
    ),
    prompt_triggers: _parsePromptTriggers(hintsRaw["prompt_triggers"]),
  };
  // Opt-in env overrides.
  _applyEnvEnable(
    hintsCfg as unknown as Record<string, unknown>,
    "json_sidecar",
    _ENV_HINT_JSON_SIDECAR,
    "hints.json_sidecar",
  );
  _applyEnvEnable(
    hintsCfg as unknown as Record<string, unknown>,
    "serve_diff_on_reread",
    _ENV_SERVE_DIFF_ON_REREAD,
    "hints.serve_diff_on_reread",
  );
  hintsCfg.bash_dedup_min_bytes = _envInt(
    _ENV_BASH_DEDUP_MIN_BYTES,
    hintsCfg.bash_dedup_min_bytes!,
    0,
    100000,
    "hints.bash_dedup_min_bytes",
  );
  hintsCfg.web_dedup_min_bytes = _envInt(
    _ENV_WEB_DEDUP_MIN_BYTES,
    hintsCfg.web_dedup_min_bytes!,
    0,
    100000,
    "hints.web_dedup_min_bytes",
  );
  hintsCfg.grep_dedup_min_matches = _envInt(
    _ENV_GREP_DEDUP_MIN_MATCHES,
    hintsCfg.grep_dedup_min_matches!,
    0,
    100000,
    "hints.grep_dedup_min_matches",
  );
  hintsCfg.min_session_hint_savings_bytes = _envInt(
    "TOKEN_GOAT_SESSION_HINT_MIN_BYTES",
    hintsCfg.min_session_hint_savings_bytes!,
    0,
    1_000_000,
    "hints.min_session_hint_savings_bytes",
  );
  hintsCfg.large_read_redirect_bytes = _envInt(
    _ENV_LARGE_READ_BYTES,
    hintsCfg.large_read_redirect_bytes!,
    0,
    100_000_000,
    "hints.large_read_redirect_bytes",
  );
  hintsCfg.baseline_budget_tokens = _envInt(
    _ENV_BASELINE_BUDGET_TOKENS,
    hintsCfg.baseline_budget_tokens!,
    0,
    10_000_000,
    "hints.baseline_budget_tokens",
  );

  // ----- [webfetch] -----
  const wfRaw = _section(raw, "webfetch");
  const wfCfg: WebFetchConfig = {
    allow: _validatedStrList(wfRaw["allow"], [], "webfetch.allow"),
    deny: _validatedStrList(wfRaw["deny"], [], "webfetch.deny"),
    max_file_count: _validatedInt(
      wfRaw["max_file_count"],
      4096,
      1,
      1_000_000,
      "webfetch.max_file_count",
    ),
    max_bytes: _validatedInt(
      wfRaw["max_bytes"],
      32 * 1024 * 1024,
      1024,
      4 * 1024 * 1024 * 1024,
      "webfetch.max_bytes",
    ),
    compress_bodies: _validatedBool(wfRaw["compress_bodies"], true, "webfetch.compress_bodies"),
    compress_min_bytes: _validatedInt(
      wfRaw["compress_min_bytes"],
      16 * 1024,
      1024,
      10 * 1024 * 1024,
      "webfetch.compress_min_bytes",
    ),
  };
  wfCfg.max_file_count = _envInt(
    _ENV_WEB_CACHE_MAX_FILES,
    wfCfg.max_file_count!,
    1,
    1_000_000,
    "webfetch.max_file_count",
  );
  wfCfg.max_bytes = _envInt(
    _ENV_WEB_CACHE_MAX_BYTES,
    wfCfg.max_bytes!,
    1024,
    4 * 1024 * 1024 * 1024,
    "webfetch.max_bytes",
  );
  _applyEnvDisable(
    wfCfg as unknown as Record<string, unknown>,
    "compress_bodies",
    _ENV_WEB_COMPRESS,
    "webfetch.compress_bodies",
  );

  // ----- [worker] -----
  const wkRaw = _section(raw, "worker");
  const wk: WorkerConfig = {
    watchdog_enabled: _validatedBool(wkRaw["watchdog_enabled"], true, "worker.watchdog_enabled"),
    max_pool_workers: _validatedInt(
      wkRaw["max_pool_workers"],
      4,
      1,
      WORKER_MAX_POOL_CEILING,
      "worker.max_pool_workers",
    ),
  };
  _applyEnvDisable(
    wk as unknown as Record<string, unknown>,
    "watchdog_enabled",
    _ENV_WORKER_WATCHDOG,
    "worker.watchdog_enabled",
  );
  wk.max_pool_workers = _envInt(
    _ENV_WORKER_MAX_POOL,
    wk.max_pool_workers!,
    1,
    WORKER_MAX_POOL_CEILING,
    "worker.max_pool_workers",
  );
  // Enforce ceiling regardless of how the value was set (defensive — _envInt
  // already clamps, but this guards a future code path that assigns directly).
  if (wk.max_pool_workers > WORKER_MAX_POOL_CEILING) {
    _LOG.warning(
      "worker.max_pool_workers=%d exceeds hard ceiling %d; clamping",
      wk.max_pool_workers,
      WORKER_MAX_POOL_CEILING,
    );
    wk.max_pool_workers = WORKER_MAX_POOL_CEILING;
  }

  // ----- [hooks] -----
  const hkRaw = _section(raw, "hooks");
  const hk: HooksConfig = {
    watchdog_ms: _validatedInt(hkRaw["watchdog_ms"], 5000, 100, 30_000, "hooks.watchdog_ms"),
  };
  hk.watchdog_ms = _envInt("TOKEN_GOAT_HOOK_WATCHDOG_MS", hk.watchdog_ms!, 100, 30_000, "hooks.watchdog_ms");

  // ----- [indexing] -----
  const idxRaw = _section(raw, "indexing");
  let idxSymbolOnlyKb = _validatedInt(
    idxRaw["large_file_symbol_only_kb"],
    500,
    1,
    1_048_576,
    "indexing.large_file_symbol_only_kb",
  );
  let idxSkipKb = _validatedInt(
    idxRaw["large_file_skip_kb"],
    2048,
    1,
    1_048_576,
    "indexing.large_file_skip_kb",
  );
  // Ensure skip >= symbol_only: clamp skip up to symbol_only so the tiers don't
  // overlap in a confusing way.
  if (idxSkipKb < idxSymbolOnlyKb) {
    _LOG.warning(
      "config: indexing.large_file_skip_kb (%d) < large_file_symbol_only_kb (%d); clamping skip_kb to symbol_only_kb",
      idxSkipKb,
      idxSymbolOnlyKb,
    );
    idxSkipKb = idxSymbolOnlyKb;
  }
  const idxSkipDirsRaw = idxRaw["skip_dirs"];
  let idxSkipDirs: string[];
  if (!Array.isArray(idxSkipDirsRaw)) {
    if (idxSkipDirsRaw !== undefined) {
      _LOG.warning("config: indexing.skip_dirs must be a list; ignoring");
    }
    idxSkipDirs = [];
  } else {
    idxSkipDirs = idxSkipDirsRaw.filter((d): d is string => typeof d === "string").map(String);
  }
  const idxCfg: IndexingConfig = {
    large_file_symbol_only_kb: idxSymbolOnlyKb,
    large_file_skip_kb: idxSkipKb,
    skip_dirs: idxSkipDirs,
  };

  // ----- [compression] -----
  const cmpRaw = _section(raw, "compression");
  let cmpProfileRaw = String(cmpRaw["profile"] ?? "auto").trim().toLowerCase();
  if (!_VALID_COMPRESSION_PROFILES.has(cmpProfileRaw)) {
    _LOG.warning(
      "config: compression.profile=%o is not valid (expected %s); using 'auto'",
      cmpProfileRaw,
      [..._VALID_COMPRESSION_PROFILES].sort().join(", "),
    );
    cmpProfileRaw = "auto";
  }
  // Env override: TOKEN_GOAT_COMPRESS_PROFILE takes precedence over config file.
  const cmpProfileEnv = (process.env[_ENV_COMPRESS_PROFILE] ?? "").trim().toLowerCase();
  if (cmpProfileEnv !== "") {
    if (_VALID_COMPRESSION_PROFILES.has(cmpProfileEnv)) {
      _LOG.info(
        "compression.profile overridden by environment: %s=%s",
        _ENV_COMPRESS_PROFILE,
        cmpProfileEnv,
      );
      cmpProfileRaw = cmpProfileEnv;
    } else {
      _LOG.warning(
        "compression.profile env override %o not valid (expected %s); ignoring",
        cmpProfileEnv,
        [..._VALID_COMPRESSION_PROFILES].sort().join(", "),
      );
    }
  }
  const cmpCfg: CompressionConfig = { profile: cmpProfileRaw };

  // ----- [context] -----
  const ctxRaw = _section(raw, "context");
  let ctxWindow = _validatedInt(
    ctxRaw["model_window_tokens"],
    200_000,
    10_000,
    10_000_000,
    "context.model_window_tokens",
  );
  ctxWindow = _envInt(
    "TOKEN_GOAT_MODEL_WINDOW_TOKENS",
    ctxWindow,
    10_000,
    10_000_000,
    "context.model_window_tokens",
  );
  const ctxCfg: ContextConfig = { model_window_tokens: ctxWindow };

  // ----- [bash_diff] -----
  const bdRaw = _section(raw, "bash_diff");
  const bdCfg: BashDiffConfig = {
    max_hunks_per_file: _validatedInt(
      bdRaw["max_hunks_per_file"],
      10,
      0,
      10000,
      "bash_diff.max_hunks_per_file",
    ),
    hunk_density_cap: _validatedBool(bdRaw["hunk_density_cap"], true, "bash_diff.hunk_density_cap"),
  };

  // ----- [bash_severity_log] -----
  const bslRaw = _section(raw, "bash_severity_log");
  const bslCfg: SeverityLogConfig = {
    context_lines: _validatedInt(
      bslRaw["context_lines"],
      3,
      0,
      100,
      "bash_severity_log.context_lines",
    ),
    score_threshold: _validatedFloat(
      bslRaw["score_threshold"],
      0.5,
      0.0,
      1.0,
      "bash_severity_log.score_threshold",
    ),
  };

  // ----- [post_read_code_compress] -----
  // Python nests under [post_read.code_compress]; the TS shape flattens to
  // post_read_code_compress for clarity. Accept both spellings for compat.
  const prNested = _section(_section(raw, "post_read"), "code_compress");
  const prFlat = _section(raw, "post_read_code_compress");
  const prcRaw: Record<string, unknown> = Object.keys(prNested).length > 0 ? prNested : prFlat;
  const prcCfg: CodeCompressConfig = {
    min_lines: _validatedInt(prcRaw["min_lines"], 200, 1, 100_000, "post_read.code_compress.min_lines"),
  };

  return {
    compact_assist: ca,
    bash_compress: bc,
    bash_diff: bdCfg,
    bash_severity_log: bslCfg,
    post_read_code_compress: prcCfg,
    session_brief: sb,
    skill_preservation: sp,
    image_shrink: isCfg,
    curator: cur,
    hint_budget: hb,
    repomap: rm,
    overflow_guard: og,
    stats,
    hints: hintsCfg,
    hooks: hk,
    webfetch: wfCfg,
    worker: wk,
    indexing: idxCfg,
    compression: cmpCfg,
    context: ctxCfg,
  };
}

// ===========================================================================
// save() — serialize ConfigSchema to TOML, atomic write, bust cache.
// ===========================================================================

/**
 * Persist config to TOML atomically, creating parent dirs as needed.
 *
 * Accepts a partial ConfigSchema: missing sections fall back to defaults via
 * `_buildConfig({})`, so `save({})` writes the full default config. This
 * matches the Python `save(config: Config)` contract where the caller passes a
 * complete Config (the TS partial is a lenient superset of that contract).
 *
 * After a successful write the process-level cache is cleared so the next
 * load() re-reads the file we just wrote rather than serving the pre-save value.
 *
 * @param config The config to persist (partial allowed; defaults fill gaps).
 */
export function save(config: ConfigSchema): void {
  const p = paths.configPath();
  const data = serializeConfig(config);
  try {
    paths.atomicWriteBytes(p, Buffer.from(data, "utf8"));
    // Invalidate the cache so the next load() re-reads the file we just wrote.
    _setCache(undefined);
  } catch (e) {
    _LOG.warning("config save failed: %s", (e as Error).message);
  }
}

/**
 * Serialize a ConfigSchema to a TOML string.
 *
 * Hoisted out of save() so a future `config get` (no-arg TOML dump) CLI command
 * can call straight through. The shape mirrors the Python `save()` dict:
 * schema_version + the subset of sections Python persists (compact_assist,
 * bash_compress, session_brief, skill_preservation, image_shrink, curator,
 * hint_budget, repomap, overflow_guard, stats, hints, webfetch, worker,
 * indexing, compression). bash_diff / bash_severity_log / post_read_code_compress
 * are also included so they survive a save → load cycle.
 */
export function serializeConfig(config: ConfigSchema): string {
  const ca = config.compact_assist ?? {};
  const bc = config.bash_compress ?? {};
  const sb = config.session_brief ?? {};
  const sp = config.skill_preservation ?? {};
  const isCfg = config.image_shrink ?? {};
  const cur = config.curator ?? {};
  const hb = config.hint_budget ?? {};
  const rm = config.repomap ?? {};
  const og = config.overflow_guard ?? {};
  const stats = config.stats ?? {};
  const hints = config.hints ?? {};
  const hk = config.hooks ?? {};
  const wf = config.webfetch ?? {};
  const wk = config.worker ?? {};
  const idx = config.indexing ?? {};
  const cmp = config.compression ?? {};
  const bd = config.bash_diff ?? {};
  const bsl = config.bash_severity_log ?? {};
  const prc = config.post_read_code_compress ?? {};
  const ctx = config.context ?? {};

  const data: Record<string, unknown> = {
    schema_version: CONFIG_SCHEMA_VERSION,
    compact_assist: {
      enabled: ca.enabled ?? true,
      triggers: ca.triggers ?? ["manual", "auto"],
      min_events: ca.min_events ?? 3,
      max_manifest_tokens: ca.max_manifest_tokens ?? 400,
      auto_trigger_multiplier: ca.auto_trigger_multiplier ?? 2.0,
      compact_skip_ttl_secs: ca.compact_skip_ttl_secs ?? 300.0,
      noise_floor_tokens: ca.noise_floor_tokens ?? 0,
      edited_dir_group_threshold: ca.edited_dir_group_threshold ?? 3,
      max_section_lines: ca.max_section_lines ?? 0,
      wide_session_threshold: ca.wide_session_threshold ?? 15,
      orchestrator_commit_threshold: ca.orchestrator_commit_threshold ?? 5,
      lazy_skill_injection: ca.lazy_skill_injection ?? true,
      max_manifest_chars: ca.max_manifest_chars ?? 1600,
      harness: ca.harness ?? "auto",
    },
    bash_compress: {
      enabled: bc.enabled ?? true,
      disabled_filters: bc.disabled_filters ?? [],
      max_lines: bc.max_lines ?? 1000,
      max_bytes: bc.max_bytes ?? 64 * 1024,
      timeout_seconds: bc.timeout_seconds ?? 600,
      cache_min_bytes: bc.cache_min_bytes ?? 0,
      cache_max_file_count: bc.cache_max_file_count ?? 4096,
      cache_max_bytes: bc.cache_max_bytes ?? 16 * 1024 * 1024,
      cache_max_bytes_per_output: bc.cache_max_bytes_per_output ?? 50 * 1024 * 1024,
    },
    session_brief: {
      enabled: sb.enabled ?? true,
    },
    skill_preservation: {
      enabled: sp.enabled ?? true,
      max_cache_bytes: sp.max_cache_bytes ?? 5 * 1024 * 1024,
      orphan_sweep_enabled: sp.orphan_sweep_enabled ?? true,
      orphan_age_secs: sp.orphan_age_secs ?? 604800,
      truncation_budget_tokens: sp.truncation_budget_tokens ?? 800,
      compress_bodies: sp.compress_bodies ?? true,
      compress_min_bytes: sp.compress_min_bytes ?? 16 * 1024,
      inline_snippets: sp.inline_snippets ?? true,
      pre_skill_enabled: sp.pre_skill_enabled ?? true,
      first_load_compact: sp.first_load_compact ?? false,
      post_compact_full_loads: sp.post_compact_full_loads ?? false,
    },
    image_shrink: {
      prefer_avif: isCfg.prefer_avif ?? true,
      avif_quality: isCfg.avif_quality ?? 60,
      jpeg_quality: isCfg.jpeg_quality ?? 75,
      max_image_pixels: isCfg.max_image_pixels ?? 16_000_000,
      orphan_sweep_enabled: isCfg.orphan_sweep_enabled ?? true,
      orphan_age_secs: isCfg.orphan_age_secs ?? 604800,
      screenshot_redirect: isCfg.screenshot_redirect ?? true,
    },
    curator: {
      enabled: cur.enabled ?? true,
      min_samples: cur.min_samples ?? 10,
      threshold_pct: cur.threshold_pct ?? 20,
    },
    hint_budget: {
      enabled: hb.enabled ?? true,
      max_per_session: hb.max_per_session ?? 100,
      max_structured_per_session: hb.max_structured_per_session ?? 30,
      max_index_only_per_session: hb.max_index_only_per_session ?? 30,
    },
    repomap: {
      compact_file_threshold: rm.compact_file_threshold ?? 50,
      exclude_tests: rm.exclude_tests ?? true,
    },
    overflow_guard: {
      enabled: og.enabled ?? true,
      max_tokens: og.max_tokens ?? 25000,
    },
    stats: {
      record_zero_savings: stats.record_zero_savings ?? false,
    },
    hints: {
      suppress_after_ignored: hints.suppress_after_ignored ?? 5,
      quiet_hours: hints.quiet_hours ?? "",
      json_sidecar: hints.json_sidecar ?? false,
      verbose_until_seen_count: hints.verbose_until_seen_count ?? 2,
      min_file_lines_for_hint: hints.min_file_lines_for_hint ?? 0,
      bash_dedup_min_bytes: hints.bash_dedup_min_bytes ?? 200,
      web_dedup_min_bytes: hints.web_dedup_min_bytes ?? 200,
      grep_dedup_min_matches: hints.grep_dedup_min_matches ?? 5,
      serve_diff_on_reread: hints.serve_diff_on_reread ?? false,
      backoff_thresholds: hints.backoff_thresholds ?? [1, 3, 10, 30],
      git_hint_max_ms: hints.git_hint_max_ms ?? 50,
      min_session_hint_savings_bytes: hints.min_session_hint_savings_bytes ?? 512,
      pre_skill_advisory: hints.pre_skill_advisory ?? true,
      context_threshold_advisory: hints.context_threshold_advisory ?? true,
      diff_hint_min_tokens_saved: hints.diff_hint_min_tokens_saved ?? 1000,
      large_read_redirect_bytes: hints.large_read_redirect_bytes ?? 45_000,
      reread_deny: hints.reread_deny ?? true,
      reread_deny_min_bytes: hints.reread_deny_min_bytes ?? 2048,
      baseline_budget_tokens: hints.baseline_budget_tokens ?? 0,
      stable_doc_compacts: hints.stable_doc_compacts ?? true,
      truncated_read_min_lines: hints.truncated_read_min_lines ?? 200,
      protect_recent_reads: hints.protect_recent_reads ?? 4,
    },
    hooks: {
      watchdog_ms: hk.watchdog_ms ?? 5000,
    },
    webfetch: {
      allow: wf.allow ?? [],
      deny: wf.deny ?? [],
      max_file_count: wf.max_file_count ?? 4096,
      max_bytes: wf.max_bytes ?? 32 * 1024 * 1024,
      compress_bodies: wf.compress_bodies ?? true,
      compress_min_bytes: wf.compress_min_bytes ?? 16 * 1024,
    },
    worker: {
      watchdog_enabled: wk.watchdog_enabled ?? true,
      max_pool_workers: wk.max_pool_workers ?? 4,
    },
    indexing: {
      large_file_symbol_only_kb: idx.large_file_symbol_only_kb ?? 500,
      large_file_skip_kb: idx.large_file_skip_kb ?? 2048,
      skip_dirs: idx.skip_dirs ?? [],
    },
    compression: {
      profile: cmp.profile ?? "auto",
    },
    context: {
      model_window_tokens: ctx.model_window_tokens ?? 200_000,
    },
    bash_diff: {
      max_hunks_per_file: bd.max_hunks_per_file ?? 10,
      hunk_density_cap: bd.hunk_density_cap ?? true,
    },
    bash_severity_log: {
      context_lines: bsl.context_lines ?? 3,
      score_threshold: bsl.score_threshold ?? 0.5,
    },
    post_read_code_compress: {
      min_lines: prc.min_lines ?? 200,
    },
  };
  return tomlStringify(data);
}

// ===========================================================================
// _monotonicMs — process uptime in ms (analogue of time.monotonic()).
// ===========================================================================

/**
 * Return a process-monotonic time in milliseconds.
 *
 * Used only as the 4th cache-tuple element for diagnostics (the cache key is
 * (mtime, env_fingerprint); the monotonic value is never compared). Node's
 * process.uptime() is the closest analogue to CPython's time.monotonic(): both
 * are immune to wall-clock adjustments and increase monotonically across the
 * process lifetime.
 */
function _monotonicMs(): number {
  return process.uptime() * 1000;
}
