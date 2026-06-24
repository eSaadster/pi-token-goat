/**
 * Dotenv / environment variable file extractor.
 *
 * Faithful port of src/token_goat/languages/env_idx.py.
 *
 * Handles `.env`, `.env.example`, `.env.sample`, `.env.local`, and similar
 * dotenv-family files. Each `KEY=value` or `KEY = value` assignment at column 0
 * becomes an `env_key` symbol so `token-goat symbol DATABASE_URL` jumps directly
 * to the line that declares it.
 *
 * Python is a thin wrapper that re-exports `ini_idx.extract_env` as `extract`:
 *
 *     from .ini_idx import extract_env as extract
 *
 * In this TS port the `ini_idx` adapter is NOT yet ported, so we cannot import
 * it. Instead the `extract_env` logic (which itself is a thin call into
 * `common.scan_flat_headers`) is inlined here verbatim. The constants and the
 * prefilter match ini_idx.py's `extract_env` exactly:
 *   - _ENV_KEY_RE  = ^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]
 *   - _MAX_ENV_KEYS = 200
 *   - _MAX_HEADING_LEN = 200
 *   - _env_prefilter rejects comments (`#` / `;`) and continuation lines
 *     (leading whitespace) before paying the regex cost.
 *
 * What is extracted
 * -----------------
 * Symbols:
 *  - `env_key` — every `KEY=value` or `KEY = value` assignment at column 0. The
 *    extracted name is the key only (e.g. `DATABASE_URL`).
 *
 * Sections: not emitted (dotenv files are flat by design).
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import { scan_flat_headers } from "./common.js";

export const __all__ = ["extract"] as const;

// ini_idx.py uses the logger name "languages.ini_idx" and passes the label
// "ini_idx" into scan_flat_headers; extract_env is defined there, so we keep
// that identity exactly (this module re-exports ini_idx.extract_env in Python).
const _LOG = getLogger("languages.ini_idx");

// A flat ``KEY=value`` assignment at column 0. ``=`` and ``:`` are both accepted
// as the separator because real-world ``.env`` and ``.envrc`` files use either;
// the key body matches the standard shell-identifier character class.
const _ENV_KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/;

// Maximum number of env keys captured per file.
const _MAX_ENV_KEYS = 200;

// Maximum heading length we accept (shared with ini_idx.py).
const _MAX_HEADING_LEN = 200;

/**
 * Cheap per-line filter for the `.env` scan path.
 *
 * Rejects comments (`#` / `;`) and continuation lines (leading whitespace)
 * before paying the regex cost. Returns true only for lines that could
 * plausibly carry a `KEY=value` assignment at column 0.
 *
 * Python: `bool(candidate) and candidate[0] not in "#; \t"`.
 */
function _env_prefilter(candidate: string): boolean {
  if (!candidate) {
    return false;
  }
  const first = candidate[0] as string;
  return first !== "#" && first !== ";" && first !== " " && first !== "\t";
}

/**
 * Extract `.env` / `.envrc` top-level keys as `env_key` symbols.
 *
 * Sections, refs, and imports are always empty for dotenv files: the format is
 * flat by design and there is no surrounding "block" to slice.
 */
export function extract(
  source: Buffer,
  _rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const result = scan_flat_headers(source, _LOG, "ini_idx", {
    pattern: _ENV_KEY_RE,
    get_name: (m: RegExpMatchArray): string => m[1] as string,
    symbol_kind: "env_key",
    max_entries: _MAX_ENV_KEYS,
    max_heading_len: _MAX_HEADING_LEN,
    emit_sections: false,
    prefilter: _env_prefilter,
  });
  if (result === null) {
    return [[], [], [], []];
  }
  const [symbols] = result;
  return [symbols, [], [], []];
}
