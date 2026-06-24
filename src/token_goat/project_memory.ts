/**
 * Per-project persistent key-value memory for session-start context injection.
 *
 * Faithful port of src/token_goat/project_memory.py. Stores arbitrary text
 * facts (one TOML file per project under the data dir) that the agent recalls
 * at the start of every session, without repeating them in conversation
 * history. Reads are instant; writes are atomic (paths.atomicWriteText).
 *
 * Public API (snake_case preserved — the Python tests import these names):
 *   memoryPath / memory_path (projectHash)            -> string  (file path)
 *   load_entries (projectHash)                         -> Record<string, string>
 *   set_entry   (projectHash, key, value)              -> void
 *   unset_entry (projectHash, key)                     -> void
 *   clear_all   (projectHash)                          -> void
 *   build_injection (projectHash)                      -> string | null
 *
 * Parity notes (Python -> TS):
 *  - tomllib.loads(...) -> smol-toml `parse`. The Python `_load_raw` keeps only
 *    str/int/float/bool values and coerces each via `str()`; the TS `_loadRaw`
 *    reproduces that filter and Python's `str()` spelling (bool -> "True"/
 *    "False", ints decimal, floats via _pyFloatStr). The only writer (`_save`)
 *    always emits strings, so in practice values round-trip as-is; the coercion
 *    only matters for hand-edited files.
 *  - `_save` writes TOML by hand (NOT via a stringify lib) with the exact same
 *    escape sequence order as Python — \\ then " then \r then \n — so the file
 *    bytes are identical. Keys are sorted (Python `sorted(entries.items())`).
 *  - String length math in `build_injection` uses Python `len()` semantics =
 *    Unicode code-point count. JS String.length counts UTF-16 units, which
 *    differs for astral chars; `_pyLen` (= [...s].length) restores parity. The
 *    truncation slice likewise uses code points (Array.from), so the "…" marker
 *    lands at the same boundary as Python `val[:_MAX_VALUE_LEN]`.
 *  - `build_injection` returns `null` (not undefined) for "nothing to inject",
 *    matching types.py's `str | None` and the test's `result is None`.
 *  - No module-global mutable cache, so no registerReset registration.
 *
 * `verbatimModuleSyntax` is on -> the smol-toml value import is a value import;
 * there are no type-only imports here.
 * `noUncheckedIndexedAccess` is on -> Object.entries narrowing is applied.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as tomlParse } from "smol-toml";

import * as paths from "./paths.js";
import { getLogger } from "./util.js";

const _LOG = getLogger("project_memory");

// Maximum number of entries surfaced in the session-start injection.
const _MAX_ENTRIES = 30;

// Maximum length of a single value in the injection; longer values are truncated.
const _MAX_VALUE_LEN = 300;

// Hard ceiling on the total injection size (chars). Safety net against a
// pathological CLAUDE.md that sets dozens of large values. 4 000 chars ≈ 1 000
// tokens — generous enough for any normal project, but blocks runaway dumps.
//
// Exported (snake_case) because the Python test imports `_MAX_TOTAL_CHARS`.
export const _MAX_TOTAL_CHARS = 4000;

// Key validation: alphanumeric, hyphens, underscores only; max 80 chars.
const _KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Code-point length, matching Python `len(str)`. JS String.length counts
 * UTF-16 units; spreading into an array iterates by Unicode code point.
 */
function _pyLen(s: string): number {
  return [...s].length;
}

/**
 * Slice the first `n` code points of `s` (Python `s[:n]`). Array.from iterates
 * by code point so an astral char is never split mid-surrogate.
 */
function _pySlice(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/**
 * Spell a JS number the way Python `str()` would for an int or float pulled
 * out of a TOML table. Integers render as decimals; non-integers go through a
 * best-effort Python-repr-ish path (JS String(0.8) === "0.8" matches Python).
 */
function _pyFloatStr(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/** Return the TOML file path for this project's memory entries. */
export function memoryPath(projectHash: string): string {
  return path.join(paths.dataDir(), "projects", `${projectHash}_memory.toml`);
}

/** snake_case alias the Python test suite references. */
export const memory_path = memoryPath;

function _validateKey(key: string): void {
  if (!_KEY_RE.test(key)) {
    throw new Error(
      `Invalid memory key '${key}': use only letters, digits, hyphens, underscores (max 80 chars)`,
    );
  }
}

/** Read and parse the TOML file; return an empty object on any failure. */
function _loadRaw(p: string): Record<string, string> {
  if (!fs.existsSync(p)) {
    return {};
  }
  try {
    const text = fs.readFileSync(p, "utf8");
    const data = tomlParse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === "string") {
        out[k] = v;
      } else if (typeof v === "boolean") {
        out[k] = v ? "True" : "False";
      } else if (typeof v === "number") {
        out[k] = _pyFloatStr(v);
      } else if (typeof v === "bigint") {
        // smol-toml may yield bigint for large integers; Python int -> str.
        out[k] = v.toString();
      }
      // any other type (date, array, table) is skipped — matches Python's
      // isinstance(v, (str, int, float, bool)) guard.
    }
    return out;
  } catch (exc) {
    _LOG.debug("project_memory: failed to load %s: %s", p, String(exc));
    return {};
  }
}

/** Serialize *entries* to TOML and write atomically. */
function _save(p: string, entries: Record<string, string>): void {
  const lines: string[] = [];
  const keys = Object.keys(entries).sort();
  for (const k of keys) {
    const v = entries[k]!;
    const escaped = v
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
    lines.push(`${k} = "${escaped}"`);
  }
  paths.atomicWriteText(p, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
}

/** Return all memory entries for *projectHash*, or an empty object. */
export function load_entries(projectHash: string): Record<string, string> {
  return _loadRaw(memoryPath(projectHash));
}

/** Set *key* to *value* in this project's memory. */
export function set_entry(projectHash: string, key: string, value: string): void {
  _validateKey(key);
  const p = memoryPath(projectHash);
  paths.ensureParentDir(p);
  const entries = _loadRaw(p);
  entries[key] = value;
  _save(p, entries);
}

/** Remove *key* from this project's memory (no-op if absent). */
export function unset_entry(projectHash: string, key: string): void {
  _validateKey(key);
  const p = memoryPath(projectHash);
  const entries = _loadRaw(p);
  if (!(key in entries)) {
    return;
  }
  delete entries[key];
  _save(p, entries);
}

/** Remove all memory entries for *projectHash*. */
export function clear_all(projectHash: string): void {
  const p = memoryPath(projectHash);
  if (fs.existsSync(p)) {
    _save(p, {});
  }
}

/**
 * Build a compact Markdown block of memory entries for session-start injection.
 *
 * Returns null when no entries are stored — callers should treat null as
 * "nothing to inject" and skip the additionalContext entirely.
 */
export function build_injection(projectHash: string): string | null {
  let entries: Record<string, string>;
  try {
    entries = load_entries(projectHash);
  } catch {
    return null;
  }
  if (Object.keys(entries).length === 0) {
    return null;
  }

  const header = "## Project Memory";
  const lines: string[] = [header];
  let total = _pyLen(header);
  let skipped = 0;
  const items = Object.entries(entries).slice(0, _MAX_ENTRIES);
  for (const [key, val] of items) {
    const display =
      _pyLen(val) <= _MAX_VALUE_LEN ? val : _pySlice(val, _MAX_VALUE_LEN) + "…";
    const line = `- **${key}**: ${display}`;
    if (total + _pyLen(line) + 1 > _MAX_TOTAL_CHARS) {
      skipped += 1;
      continue;
    }
    lines.push(line);
    total += _pyLen(line) + 1; // +1 for the joining newline
  }
  if (skipped) {
    lines.push(
      `- (+${skipped} more memory entries omitted — total size limit reached)`,
    );
  }
  return lines.join("\n");
}
