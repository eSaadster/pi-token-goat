/**
 * INI / CFG / .env extractor — one Section per `[section]` header.
 *
 * Faithful port of src/token_goat/languages/ini_idx.py. Strict NodeNext ESM.
 *
 * INI-family configuration files are line-oriented and unambiguous: a
 * `[name]` header at column 0 opens a section that spans every following line
 * until the next header or EOF. `.env` (dotenv) files have no section syntax
 * at all — they are flat `KEY=value` pairs — so for those we emit one
 * `env_key` symbol per top-level assignment and skip sections entirely.
 *
 * Why a custom scanner rather than `configparser`:
 *
 * * `configparser` parses to a dict and discards source positions. We need
 *   start/end line numbers so `token-goat section` can slice the source file
 *   back out.
 *
 * * INI dialects vary (Windows `;` comments vs Unix `#`; multi-line values
 *   with continuation indent; spaces in keys). A targeted line scanner gives
 *   predictable, low-surprise behaviour without inheriting configparser's
 *   strictness on edge cases that token-goat does not need to enforce.
 *
 * Section model
 * -------------
 * * `heading`: the bracketed name, lowercased and trimmed. Dotted/colon-
 *   separated sections like `[tool.black]` or `[mysqld:replica]` are kept
 *   verbatim so callers can target the exact name they see in the file.
 * * `level`: always 1 — INI has no nested headers.
 * * `line`: 1-based line of the header.
 * * `end_line`: 1-based last line of the section's content (the line
 *   immediately before the next header, or EOF for the trailing entry).
 *
 * The `.env` path emits no sections — only the per-key symbols — because
 * treating each top-level key as a "section" would produce one entry per line
 * and inflate the index for what is already a small flat file.
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import { scan_flat_headers } from "./common.js";

export const __all__ = ["extract", "extract_env"] as const;

const _LOG = getLogger("languages.ini_idx");

// Column-0-anchored `[name]` header. We allow letters, digits, underscores,
// hyphens, dots, colons, and slashes in the name — this covers every dialect
// seen in the wild (`[tool.black]` in setup.cfg, `[mysqld:replica]` in my.cnf,
// `[group/sub]` in PHP-FPM pools) without admitting whitespace or quotes that
// would indicate a malformed line.
//
// Python: re.compile(r"^\[([A-Za-z0-9_\-.:/]+)\]\s*(?:[;#].*)?$")
const _HEADER_RE = /^\[([A-Za-z0-9_\-.:/]+)\]\s*(?:[;#].*)?$/;

// Maximum number of headers indexed per file. Real INI files top out in the
// low tens; the cap is generous so a hand-typed config never hits it but tight
// enough to bound a pathological generated file (Apache `vhost` dumps, Windows
// `.ini` exports with thousands of entries).
const _MAX_SECTIONS = 200;
// Maximum length of a section header we accept. Real names are short.
const _MAX_HEADING_LEN = 200;

/**
 * Extract INI/CFG `[section]` headers as Section + Symbol entries.
 *
 * Refs and imports are always empty for INI files — there is no cross-file
 * reference model in this format.
 */
export function extract(
  source: Buffer,
  _rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const result = scan_flat_headers(source, _LOG, "ini_idx", {
    pattern: _HEADER_RE,
    get_name: (m: RegExpMatchArray): string => (m[1] as string).trim(),
    symbol_kind: "ini_section",
    max_entries: _MAX_SECTIONS,
    max_heading_len: _MAX_HEADING_LEN,
    // `[` is the only first character that can introduce a header in INI; skip
    // the regex cost on every other line.
    prefilter: (c: string): boolean => Boolean(c) && c[0] === "[",
  });
  if (result === null) {
    return [[], [], [], []];
  }
  const [symbols, sections] = result;
  return [symbols, [], [], sections];
}

// A flat `KEY=value` assignment at column 0. `=` and `:` are both accepted as
// the separator because real-world `.env` and `.envrc` files use either; the
// key body matches the standard shell-identifier character class. Lines with
// leading whitespace are intentionally skipped — they are either continuation
// values or invalid — and lines starting with `#` / `;` are comments.
//
// Python: re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]")
const _ENV_KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/;

// Maximum number of env keys captured per file. Production `.env` files rarely
// exceed a few dozen; the cap is conservative against pathological auto-
// generated dumps.
const _MAX_ENV_KEYS = 200;

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
 * flat by design and there is no surrounding "block" to slice. Each captured
 * key carries its 1-based line number so `token-goat symbol` points at the
 * assignment.
 */
export function extract_env(
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
