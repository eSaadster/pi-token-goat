/**
 * SQL extractor — CREATE TABLE/VIEW/FUNCTION/PROCEDURE/INDEX/TRIGGER names.
 *
 * Faithful port of src/token_goat/languages/sql_idx.py. Pure-regex,
 * case-insensitive, no tree-sitter.
 *
 * What is extracted (each symbol also becomes a Section):
 *   - sql_table     — CREATE [TEMP[ORARY]] TABLE [IF NOT EXISTS] name
 *   - sql_view      — CREATE [OR REPLACE] [TEMP[ORARY]] VIEW name
 *   - sql_function  — CREATE [OR REPLACE] FUNCTION name
 *   - sql_procedure — CREATE [OR REPLACE] PROCEDURE name
 *   - sql_index     — CREATE [UNIQUE] INDEX [IF NOT EXISTS] name
 *   - sql_trigger   — CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name
 *   - sql_type      — CREATE [OR REPLACE] TYPE name
 *   - sql_schema    — CREATE SCHEMA [IF NOT EXISTS] name
 *
 * Refs and imports are always empty for SQL schema files.
 *
 * Offset note: Python m.start() is a code-point offset; line numbers come from
 * counting "\n" in the slice up to that offset, which is unit-agnostic (newlines
 * are BMP), so JS UTF-16 .index produces identical line numbers without byte
 * math.
 */

import { type ImpExp, type Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import {
  assign_flat_end_lines,
  decode_source_text,
  propagate_section_end_lines_to_symbols,
  strip_cstyle_comments,
} from "./common.js";

const _LOG = getLogger("languages.sql_idx");

// SQL line comments: -- ... (passed to strip_cstyle_comments as line_re).
const _SQL_LINE_COMMENT_RE = /--[^\n]*/g;

function _strip_comments(text: string): string {
  return strip_cstyle_comments(text, { line_re: _SQL_LINE_COMMENT_RE });
}

// ---------------------------------------------------------------------------
// Name pattern
// ---------------------------------------------------------------------------

// Bare identifiers, double-quoted, backtick-quoted, or square-bracket-quoted
// names. Schema-qualified names (schema.name) captured via optional suffix.
const _BARE = "[A-Za-z_][A-Za-z0-9_$]*";
const _QUOTED = '"[^"]{1,128}"|`[^`]{1,128}`|\\[[^\\]]{1,128}\\]';
const _NAME = `(?:${_QUOTED}|${_BARE})(?:\\.(?:${_QUOTED}|${_BARE}))?`;

/**
 * Build a CREATE [opt_prefix] <object_kw> [IF NOT EXISTS] <name> regex
 * (case-insensitive, global). `opt_prefix` is a self-contained optional fragment
 * inserted verbatim between CREATE\s+ and object_kw.
 */
function _make_create_re(object_kw: string, opt_prefix = ""): RegExp {
  return new RegExp(
    `(?<!\\w)CREATE\\s+${opt_prefix}${object_kw}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${_NAME})`,
    "gi",
  );
}

// TABLE (with optional TEMP[ORARY])
const _TABLE_RE = _make_create_re("TABLE", "(?:TEMP(?:ORARY)?\\s+)?");

// VIEW (with optional OR REPLACE and optional TEMP[ORARY])
const _VIEW_RE = _make_create_re(
  "VIEW",
  "(?:OR\\s+REPLACE\\s+)?(?:TEMP(?:ORARY)?\\s+)?",
);

// FUNCTION / PROCEDURE (with optional OR REPLACE)
const _FUNCTION_RE = _make_create_re("FUNCTION", "(?:OR\\s+REPLACE\\s+)?");
const _PROCEDURE_RE = _make_create_re("PROCEDURE", "(?:OR\\s+REPLACE\\s+)?");

// INDEX (with optional UNIQUE)
const _INDEX_RE = _make_create_re("INDEX", "(?:UNIQUE\\s+)?");

// TRIGGER (with optional OR REPLACE and optional CONSTRAINT)
const _TRIGGER_RE = _make_create_re(
  "TRIGGER",
  "(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?",
);

// TYPE (with optional OR REPLACE)
const _TYPE_RE = _make_create_re("TYPE", "(?:OR\\s+REPLACE\\s+)?");

// SCHEMA
const _SCHEMA_RE = _make_create_re("SCHEMA");

const _PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [_TABLE_RE, "sql_table"],
  [_VIEW_RE, "sql_view"],
  [_FUNCTION_RE, "sql_function"],
  [_PROCEDURE_RE, "sql_procedure"],
  [_INDEX_RE, "sql_index"],
  [_TRIGGER_RE, "sql_trigger"],
  [_TYPE_RE, "sql_type"],
  [_SCHEMA_RE, "sql_schema"],
];

const _MAX_SYMBOLS = 500;
const _MAX_HEADING_LEN = 128;

/** Length of `s` in CODE POINTS (Python len(str)). */
function _lenCodepoints(s: string): number {
  let n = 0;
  for (const _ of s) {
    n += 1;
  }
  return n;
}

/** Count "\n" in `s` (Python str.count("\n")). */
function _countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      n += 1;
    }
  }
  return n;
}

/** Strip outer quoting from an SQL identifier. */
function _unquote(name: string): string {
  if (
    name.length >= 2 &&
    ((name[0] === '"' && name[name.length - 1] === '"') ||
      (name[0] === "`" && name[name.length - 1] === "`") ||
      (name[0] === "[" && name[name.length - 1] === "]"))
  ) {
    return name.slice(1, -1);
  }
  return name;
}

/**
 * Extract SQL DDL object names from `source`.
 * Returns [symbols, refs, imports, sections]; refs and imports are empty.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const text = decode_source_text(source, _LOG, "sql_idx");
  if (text === null) {
    return [[], [], [], []];
  }

  try {
    const stripped = _strip_comments(text);
    const total_lines = text.split("\n").length;

    const symbols: Symbol[] = [];
    const sections: Section[] = [];
    const seen: Set<string> = new Set();

    const _emit = (raw_name: string, kind: string, line: number): void => {
      const name = _unquote(raw_name).trim();
      if (!name || _lenCodepoints(name) > _MAX_HEADING_LEN) {
        return;
      }
      if (symbols.length >= _MAX_SYMBOLS) {
        return;
      }
      const key = `${name}\n${line}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      symbols.push(new Symbol({ name, kind, line }));
      sections.push(new Section({ heading: name, level: 1, line }));
    };

    for (const [pattern, kind] of _PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(stripped)) !== null) {
        if (m.index === pattern.lastIndex) {
          pattern.lastIndex += 1;
        }
        const raw_name = m[1];
        if (raw_name) {
          const line = _countNewlines(stripped.slice(0, m.index)) + 1;
          _emit(raw_name, kind, line);
        }
      }
    }

    // Sort by line for deterministic end-line assignment (stable, like Python).
    sections.sort((a, b) => a.line - b.line);
    symbols.sort((a, b) => a.line - b.line);

    assign_flat_end_lines(sections, total_lines);
    propagate_section_end_lines_to_symbols(symbols, sections);

    return [symbols, [], [], sections];
  } catch (exc) {
    _LOG.debug(
      "sql_idx: parse failed for %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}
