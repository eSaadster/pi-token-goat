/**
 * `config *` subcommand implementations — the TS port of cli.py's config_app
 * command bodies (lines 7189–7555).
 *
 * Faithful 1:1 port: same logic, same output, same exit codes. The 6 command
 * implementations (config_list / config_validate / config_get / config_set /
 * config_reset / config_path) plus the 3 internal helpers
 * (_config_get_value / _coerce_config_value / _config_set_value) live here and
 * are exported; cli.ts's `_buildConfigApp()` wires thin commander wrappers that
 * delegate straight through.
 *
 * Output seam (Python `typer.echo` / `raise typer.Exit` / `_error`) routes
 * through cli_common.ts (`_echo` / `CliExit` / `_error`) so the commander app
 * and the test runner observe output identically to the Python originals.
 *
 * Helpers invoked from another function in this module go through `self.fn()`
 * (static `import * as self`) — the ESM live-binding analogue of Python module
 * attribute patching, so a test that `vi.spyOn`s these boundaries sees the
 * patched implementation.
 *
 * JSON parity: every JSON dump uses bare `JSON.stringify(x)` which is compact
 * (separators `,`/`:`) and does NOT ASCII-escape — matching Python's
 * `json.dumps(x, ensure_ascii=False, separators=(",", ":"))` exactly.
 *
 * Confirm-prompt seam: Python's `typer.confirm` reads stdin; under vitest the
 * real stdin blocks, so `_confirmInput` is an injectable resolver the test
 * sets via `_setConfirmInput(() => true/false)`. The default impl prints the
 * prompt and reads one line from stdin (production path).
 */
import fs from "node:fs";

import { parse as tomlParse, TomlError } from "smol-toml";

import * as config from "./config.js";
import { CONFIG_SCHEMA_VERSION, _KNOWN_SECTIONS, serializeConfig } from "./config.js";
import type { ConfigSchema } from "./types.js";
import * as paths from "./paths.js";
import { get_close_matches } from "./difflib.js";
import { CliExit, _echo, _error } from "./cli_common.js";

import * as self from "./cli_config.js";

// ===========================================================================
// Internal helpers (ported from cli.py:7189–7276)
// ===========================================================================

/**
 * Retrieve a nested config value by dotted key (e.g. "compact_assist.enabled").
 *
 * Walks the config object key-by-key and returns the leaf. A section (plain
 * object) is returned as-is — callers decide whether to JSON-dump it. Throws
 * `KeyError` (a real Error with name "KeyError") when any component is absent,
 * matching Python's `KeyError` so the CLI wrapper can translate to exit 2.
 *
 * Port of cli.py:_config_get_value. `hasattr`/`getattr` become `in`/indexing;
 * the `is_dataclass(obj)` short-circuit (Python returned early for a non-
 * dataclass root) is unnecessary in TS — a non-object target simply fails the
 * `in` check on the next iteration and raises KeyError.
 */
export function _config_get_value(cfg: ConfigSchema, key: string): unknown {
  let target: unknown = cfg;
  const parts = key.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw _keyError(key);
  }
  for (const part of parts) {
    if (target === null || typeof target !== "object" || Array.isArray(target)) {
      throw _keyError(key);
    }
    if (!(part in (target as Record<string, unknown>))) {
      throw _keyError(key);
    }
    target = (target as Record<string, unknown>)[part];
  }
  return target;
}

/**
 * Set a nested config value by dotted key, coercing the raw CLI string to the
 * current value's type. Mutates `cfg` in place; returns the coerced value so
 * the caller can echo it.
 *
 * Port of cli.py:_config_set_value. Navigates to the parent of the leaf, reads
 * the current value, dispatches to `_coerce_config_value`, then assigns back.
 */
export function _config_set_value(cfg: ConfigSchema, key: string, rawValue: string): unknown {
  const parts = key.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw _keyError(key);
  }
  let target: unknown = cfg;
  for (const part of parts.slice(0, -1)) {
    if (target === null || typeof target !== "object" || Array.isArray(target)) {
      throw _keyError(key);
    }
    if (!(part in (target as Record<string, unknown>))) {
      throw _keyError(key);
    }
    target = (target as Record<string, unknown>)[part];
  }
  const attr = parts[parts.length - 1]!;
  if (
    target === null ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    !(attr in (target as Record<string, unknown>))
  ) {
    throw _keyError(key);
  }
  const parent = target as Record<string, unknown>;
  const current = parent[attr];
  const updated = self._coerce_config_value(current, rawValue);
  parent[attr] = updated;
  return updated;
}

/**
 * Coerce `rawValue` (a CLI string) to the same type as `current`.
 *
 * Dispatch table mirrors cli.py:_coerce_config_value:
 *  - section object → parsed from a JSON object; merge parsed keys onto a copy
 *    of the current section (TS analogue of `current.__class__(**parsed)`).
 *  - bool          → 1/true/yes/on vs 0/false/no/off (case-insensitive).
 *  - int           → parseInt (base 10).
 *  - array         → JSON array literal (inner items stringified) or comma-split.
 *  - str / other   → returned as-is (stripped).
 *
 * Throws Error (translated to a ValueError-shaped message by the caller) for
 * invalid inputs.
 */
export function _coerce_config_value(current: unknown, rawValue: string): unknown {
  const raw = rawValue.trim();

  // Section object: a plain (non-array) object. Python used is_dataclass();
  // the TS analogue is a non-null, non-array object — every config section is
  // one. Reconstruct via Object.assign({}, current, parsed) — the faithful
  // counterpart to `current.__class__(**parsed)` (merge parsed keys onto a
  // fresh copy of the section shape).
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return Object.assign({}, current, parsed);
  }

  // bool BEFORE number — JS booleans are a subtype of number, so the dataclass
  // branch above did not catch them; check typeof boolean explicitly here.
  if (typeof current === "boolean") {
    const lowered = raw.toLowerCase();
    if (lowered === "1" || lowered === "true" || lowered === "yes" || lowered === "on") {
      return true;
    }
    if (lowered === "0" || lowered === "false" || lowered === "no" || lowered === "off") {
      return false;
    }
    throw new Error("expected a boolean value");
  }

  // int — Python's is_real_int excludes bool. typeof number catches both int
  // and float in JS; we deliberately check Number.isInteger so a float field
  // (e.g. auto_trigger_multiplier) falls through to the string branch below
  // (returning the raw string unchanged, exactly as Python does for a float
  // current — Python's dispatch has no float case either). parseInt(_, 10)
  // matches Python int() for decimal strings.
  if (typeof current === "number" && Number.isInteger(current)) {
    const n = Number(raw);
    if (!/^[+-]?\d+$/.test(raw) || !Number.isFinite(n)) {
      throw new Error(`invalid literal for int() with base 10: '${raw}'`);
    }
    return Math.trunc(n);
  }

  if (Array.isArray(current)) {
    if (raw.startsWith("[")) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("expected a JSON list");
      }
      // Python: [str(item) for item in parsed] — stringify every element.
      return parsed.map((item: unknown) => String(item));
    }
    if (raw === "") {
      return [];
    }
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  return raw;
}

/** Construct a Python-shaped KeyError (Error subclass with that name). */
function _keyError(key: string): Error {
  const e = new Error(String(key));
  e.name = "KeyError";
  return e;
}

// ===========================================================================
// Confirm-prompt seam (for `config reset` without --yes)
// ===========================================================================

/**
 * Injectable confirm-prompt resolver. The TEST path sets this via
 * `_setConfirmInput(() => true|false)`. When undefined, the default impl
 * prints the prompt to stdout and reads one line from stdin (the production
 * path — Python's `typer.confirm` reads stdin).
 */
let _confirmInput: ((prompt: string) => boolean) | undefined;

/**
 * Set or clear the confirm-prompt resolver. Registered for reset so
 * clearModuleCaches() (per-test) wipes any injected resolver.
 */
export function _setConfirmInput(fn: ((prompt: string) => boolean) | undefined): void {
  _confirmInput = fn;
}

/**
 * Default confirm: print the prompt (Python typer.confirm echoes it to stdout)
 * and read one line from stdin. Returns true for a "y"/"yes" answer.
 *
 * Best-effort under vitest: the test path always injects via _setConfirmInput,
 * so this branch only runs in real CLI use. Synchronous stdin read via
 * fs.readSync on fd 0.
 */
function _defaultConfirm(prompt: string): boolean {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(8192);
  try {
    const bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    const line = buf.toString("utf8", 0, bytesRead).trim().toLowerCase();
    return line === "y" || line === "yes";
  } catch {
    return false;
  }
}

/** Resolve the confirm prompt via the injected resolver or the default impl. */
function _confirm(prompt: string): boolean {
  return (_confirmInput ?? _defaultConfirm)(prompt);
}

// ===========================================================================
// config list  (cli.py:7279)
// ===========================================================================

/**
 * List all config keys with their current values and defaults.
 *
 * Flattens defaultConfig() and load() to dotted-key leaf pairs, then prints a
 * table. `--json` emits `{key: {value, default}}`. Changed keys (current !=
 * default) are marked with `*`.
 *
 * Port of cli.py:config_list. The Python `_flatten` walked `dataclasses.fields()`;
 * the TS port walks the ConfigSchema recursively — for each key, a plain non-
 * array object recurses (dotted key), anything else is a leaf. `schema_version`
 * is a ClassVar in Python (excluded from `fields()`); in TS it is absent from
 * the ConfigSchema entirely, so no exclusion is needed.
 */
export function config_list(opts: { json_output?: boolean } = {}): void {
  const defaults = config.defaultConfig();
  const current = config.load();

  const defaultPairs = _flattenConfig(defaults);
  const currentPairs = _flattenConfig(current);

  if (opts.json_output) {
    const out: Record<string, { value: unknown; default: unknown }> = {};
    for (const k of Object.keys(currentPairs)) {
      out[k] = { value: currentPairs[k], default: defaultPairs[k] };
    }
    _echo(JSON.stringify(out));
    return;
  }

  // Human-readable table. col_key = max key length + 2 (Python f-string pad).
  const keys = Object.keys(currentPairs);
  const colKey = keys.reduce((m, k) => Math.max(m, k.length), 0) + 2;
  const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  for (const k of keys) {
    const cur = currentPairs[k];
    const dflt = defaultPairs[k];
    const curStr = JSON.stringify(cur);
    const dfltStr = JSON.stringify(dflt);
    const changed = JSON.stringify(cur) !== JSON.stringify(dflt);
    const marker = changed ? "*" : " ";
    let keyFmt = k;
    let curFmt = curStr;
    if (useColor) {
      keyFmt = `[36m${k}[0m`;
      if (changed) curFmt = `[33m${curStr}[0m`;
    }
    // Python: f"{marker} {key_fmt:<{col_key + 9}} {cur_fmt}  (default: {dflt_str})"
    _echo(
      `${marker} ${keyFmt.padEnd(colKey + 9)} ${curFmt}  (default: ${dfltStr})`,
    );
  }
}

/**
 * Recursively flatten a ConfigSchema into dotted-key -> leaf-value pairs.
 *
 * A "leaf" is anything that is not a plain non-array object: numbers, booleans,
 * strings, arrays, null, undefined all count as leaves (arrays are leaves
 * because config lists are `[a, b]`, not recursively keyed). A plain object
 * (a section) recurses with the dotted prefix.
 */
function _flattenConfig(
  obj: unknown,
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return out;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const val = rec[key];
    const dotted = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      Object.assign(out, _flattenConfig(val, dotted));
    } else {
      out[dotted] = val;
    }
  }
  return out;
}

// ===========================================================================
// config validate  (cli.py:7332)
// ===========================================================================

/**
 * The 11 sections Python's _KNOWN_SECTION_KEYS covers (cli.py:7357–7369).
 * Kept as an explicit list (NOT auto-derived from all ~20 TS sections) so the
 * parity surface matches Python exactly: only these sections get per-section
 * sub-key validation. Each section's key-set is derived at runtime from
 * defaultConfig()[section] so adding a field is picked up automatically.
 */
const _VALIDATED_SECTIONS: readonly string[] = [
  "compact_assist",
  "bash_compress",
  "session_brief",
  "skill_preservation",
  "image_shrink",
  "curator",
  "hint_budget",
  "hints",
  "repomap",
  "stats",
  "webfetch",
];

/**
 * Validate config.toml and report unknown keys with did-you-mean suggestions.
 *
 * Parses the raw TOML file (NOT load() — load() silently drops unknown keys),
 * compares every top-level key against `_KNOWN_SECTIONS`, and every sub-key
 * against the 11 sections' default key-sets. `--json` emits
 * `{ok, issues, config_path}`; exits 1 when issues exist.
 *
 * Port of cli.py:config_validate.
 */
export function config_validate(opts: { json_output?: boolean } = {}): void {
  const cfgPath = paths.configPath();
  const issues: Array<Record<string, unknown>> = [];

  if (!fs.existsSync(cfgPath)) {
    if (opts.json_output) {
      _echo(
        JSON.stringify({
          ok: true,
          issues: [],
          note: "config file not found (defaults in use)",
        }),
      );
    } else {
      _echo("config file not found — defaults in use, nothing to validate");
    }
    return;
  }

  let raw: Record<string, unknown>;
  try {
    const text = fs.readFileSync(cfgPath, "utf8");
    const parsed = tomlParse(text);
    raw =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    const issue: Record<string, unknown> = {
      path: cfgPath,
      error: `TOML parse error: ${msg}`,
    };
    if (opts.json_output) {
      _echo(JSON.stringify({ ok: false, issues: [issue] }));
    } else {
      _error(`TOML parse error in ${cfgPath}: ${msg}`);
    }
    throw new CliExit(1);
  }

  // Top-level keys vs _KNOWN_SECTIONS (which already includes schema_version).
  for (const key of Object.keys(raw)) {
    if (!_KNOWN_SECTIONS.has(key)) {
      const suggestion = _closest(key, _KNOWN_SECTIONS);
      const issue: Record<string, unknown> = {
        path: cfgPath,
        key,
        message: `unknown top-level key: '${key}'`,
      };
      if (suggestion !== null) {
        issue["suggestion"] = `did you mean: ${suggestion}`;
      }
      issues.push(issue);
    }
  }

  // Per-section sub-keys vs each section's default key-set.
  const defaults = config.defaultConfig();
  for (const sectionKey of _VALIDATED_SECTIONS) {
    const sectionVal = raw[sectionKey];
    if (sectionVal === null || typeof sectionVal !== "object" || Array.isArray(sectionVal)) {
      continue;
    }
    const knownSectionKeys = new Set<string>(
      Object.keys((defaults as unknown as Record<string, unknown>)[sectionKey] as Record<string, unknown> ?? {}),
    );
    for (const subKey of Object.keys(sectionVal as Record<string, unknown>)) {
      if (!knownSectionKeys.has(subKey)) {
        const suggestion = _closest(subKey, knownSectionKeys);
        const issue: Record<string, unknown> = {
          path: cfgPath,
          key: `${sectionKey}.${subKey}`,
          message: `unknown key: '${sectionKey}.${subKey}'`,
        };
        if (suggestion !== null) {
          issue["suggestion"] = `did you mean: ${sectionKey}.${suggestion}`;
        }
        issues.push(issue);
      }
    }
  }

  const ok = issues.length === 0;
  if (opts.json_output) {
    _echo(JSON.stringify({ ok, issues, config_path: cfgPath }));
    if (!ok) throw new CliExit(1);
    return;
  }

  if (ok) {
    _echo(`config OK: ${cfgPath}`);
    return;
  }

  for (const issue of issues) {
    let line = `  [UNKNOWN] ${issue["key"]}`;
    if (issue["suggestion"] !== undefined) {
      line += `  (${issue["suggestion"]})`;
    }
    _echo(line);
  }
  _echo(`\n${issues.length} issue(s) found in ${cfgPath}`);
  throw new CliExit(1);
}

/** Closest did-you-mean match via difflib.get_close_matches (n=1, cutoff=0.6). */
function _closest(key: string, known: ReadonlySet<string>): string | null {
  const sorted = [...known].sort();
  const matches = get_close_matches(key, sorted, 1, 0.6);
  return matches.length > 0 ? (matches[0] ?? null) : null;
}

// ===========================================================================
// config get  (cli.py:7439)
// ===========================================================================

/**
 * Show current config value(s).
 *
 * With no key, dumps the full config in TOML (serializeConfig then trimEnd —
 * Python's `tomli_w.dumps(asdict(cfg)).rstrip()`). With a dotted key, prints
 * the leaf value as compact JSON (sections become JSON objects).
 *
 * Port of cli.py:get. Unknown key → `_error` + CliExit(2).
 */
export function config_get(opts: { key: string | undefined } = {} as { key: string | undefined }): void {
  const cfg = config.load();

  if (opts.key === undefined) {
    // Python re-adds schema_version (a ClassVar omitted by asdict); serializeConfig
    // already includes it, so this is a straight dump + rstrip.
    const data = serializeConfig(cfg).trimEnd();
    _echo(data);
    return;
  }

  let value: unknown;
  try {
    value = self._config_get_value(cfg, opts.key);
  } catch {
    _error(`unknown config key: ${opts.key}`);
    throw new CliExit(2);
  }

  _echo(JSON.stringify(value));
}

// ===========================================================================
// config set  (cli.py:7471)
// ===========================================================================

/**
 * Set a config value, creating config.toml if it does not exist.
 *
 * VALUE is coerced to the current value's type automatically. On success,
 * saves and echoes `Set <key> = <json>`.
 *
 * Port of cli.py:set. Unknown key → exit 2; invalid value (JSON / type / range)
 * → `_error("invalid value for <key>: <msg>")` + exit 2.
 */
export function config_set(opts: { key: string; value: string }): void {
  const cfg = config.load();
  let updated: unknown;
  try {
    updated = self._config_set_value(cfg, opts.key, opts.value);
  } catch (exc) {
    if (exc instanceof Error && exc.name === "KeyError") {
      _error(`unknown config key: ${opts.key}`);
      throw new CliExit(2);
    }
    // JSON parse errors, TypeErrors, and ValueErrors all surface here. Python
    // caught (json.JSONDecodeError, TypeError, ValueError) — in JS, JSON.parse
    // throws SyntaxError (a subclass of Error), and our coercion throws plain
    // Error with a message. Map both to the "invalid value" exit-2 path.
    const msg = exc instanceof Error ? exc.message : String(exc);
    _error(`invalid value for ${opts.key}: ${msg}`);
    throw new CliExit(2);
  }
  config.save(cfg);
  _echo(`Set ${opts.key} = ${JSON.stringify(updated)}`);
}

// ===========================================================================
// config reset  (cli.py:7498)
// ===========================================================================

/**
 * Reset config to defaults — one key or everything.
 *
 * With no KEY, deletes config.toml entirely (after a confirm prompt unless
 * `--yes`). With KEY, restores that one key to its default and saves.
 *
 * Port of cli.py:reset. Unknown key → exit 2.
 */
export function config_reset(
  opts: { key: string | undefined; yes: boolean } = {} as {
    key: string | undefined;
    yes: boolean;
  },
): void {
  const cfgPath = paths.configPath();

  if (opts.key === undefined) {
    if (!fs.existsSync(cfgPath)) {
      _echo("Config file does not exist — already at defaults.");
      return;
    }
    if (!opts.yes) {
      const confirmed = _confirm("Delete config.toml and restore all defaults? [y/N]: ");
      if (!confirmed) {
        _echo("Aborted.");
        throw new CliExit(0);
      }
    }
    fs.unlinkSync(cfgPath);
    // Python pokes `_config_mtime_cache = None`; clearConfigCache() is the TS
    // equivalent (save() also busts the cache, but reset deletes the file
    // directly so an explicit bust is required).
    config.clearConfigCache();
    _echo(`Deleted ${cfgPath} — all settings restored to defaults.`);
    return;
  }

  // Single-key reset: load current, set that key to the default, save.
  const cfg = config.load();
  const defaults = config.defaultConfig();
  let defaultValue: unknown;
  try {
    defaultValue = self._config_get_value(defaults, opts.key);
  } catch {
    _error(`unknown config key: ${opts.key}`);
    throw new CliExit(2);
  }

  const parts = opts.key.split(".").filter((p) => p.length > 0);
  let target: unknown = cfg;
  for (const part of parts.slice(0, -1)) {
    target = (target as Record<string, unknown>)[part];
  }
  (target as Record<string, unknown>)[parts[parts.length - 1]!] = defaultValue;
  config.save(cfg);
  _echo(`Reset ${opts.key} = ${JSON.stringify(defaultValue)} (default)`);
}

// ===========================================================================
// config path  (cli.py:7550)
// ===========================================================================

/** Print the path to token-goat's config.toml. Port of cli.py:path. */
export function config_path(): void {
  _echo(paths.configPath());
}

// ===========================================================================
// Reset registration — wipe the confirm-prompt resolver per-test.
// ===========================================================================
// Imported lazily (circular with reset.ts is benign: reset.ts has no dependency
// on cli_config). Registered at module load so clearModuleCaches() (called by
// every test's beforeEach in tests/setup.ts) drops an injected resolver.
import { registerReset } from "./reset.js";
registerReset(_setConfirmInput.bind(null, undefined));

// Keep the CONFIG_SCHEMA_VERSION import live (re-exported for any consumer
// that wants the constant alongside the config helpers). The serializeConfig
// import is consumed by config_get; _KNOWN_SECTIONS by config_validate.
void CONFIG_SCHEMA_VERSION;
