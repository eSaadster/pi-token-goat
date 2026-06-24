/**
 * CSS / SCSS / Less extractor — selectors, custom properties, @rules, and mixins.
 *
 * Faithful port of src/token_goat/languages/css_idx.py. Pure-regex scanner, no
 * tree-sitter. CSS files can be large but agents typically need only one
 * selector, variable declaration, or @rule block.
 *
 * What is extracted
 * -----
 * Symbols:
 *   - css_selector  — class selectors (.foo) and ID selectors (#foo)
 *   - css_var       — custom property declarations (--name)
 *   - css_mixin     — @mixin name declarations (SCSS / Less)
 *   - css_keyframe  — @keyframes name declarations
 *   - css_rule      — general @rule names (@media, @layer, @font-face, etc.)
 *
 * Imports:
 *   - @import "path" / @import url("path") — CSS / Less file imports
 *   - @use "path"     — Sass module system import (SCSS)
 *   - @forward "path" — Sass module re-export (SCSS)
 *
 * Sections:
 *   Each symbol also becomes a Section. End-lines are assigned by the flat
 *   algorithm (content up to the next section header, or EOF for the last one).
 *
 * Offset note: Python's m.start()/m.start(1) are CODE-POINT offsets into the
 * (string) source; line numbers come from counting newlines in the slice up to
 * that offset. JS RegExp .index is a UTF-16 offset, but counting "\n" in a slice
 * yields the same newline count regardless of which unit we slice on (newlines
 * are BMP), so line numbers match Python exactly without byte math.
 */

import { ImpExp, type Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import {
  assign_flat_end_lines,
  decode_source_text,
  make_symbol_emitter,
  propagate_section_end_lines_to_symbols,
  strip_cstyle_comments,
} from "./common.js";

const _LOG = getLogger("languages.css_idx");

function _strip_comments(text: string): string {
  return strip_cstyle_comments(text);
}

// ---------------------------------------------------------------------------
// Extraction regexes
// ---------------------------------------------------------------------------

// @keyframes name — SCSS and CSS3 (re.MULTILINE).
const _KEYFRAMES_RE = /^[ \t]*@keyframes\s+([-\w]+)/gm;

// @mixin name (SCSS / Less).
const _MIXIN_RE = /^[ \t]*@mixin\s+([-\w]+)/gm;

// @media / @layer / @supports / @font-face / @container / @page etc.
const _ATRULE_RE =
  /^[ \t]*(@(?:media|layer|supports|container|page|font-face|charset|namespace|import|use|forward|include)\b[^{;\n]*)/gm;

// Custom properties: --name: anywhere in a rule body.
const _CUSTOM_PROP_RE = /(?:^|[\s{;,])\s*(--[-\w]+)\s*:/gm;

// Class selectors: .name at column 0 or on its own selector line.
const _CLASS_SELECTOR_RE = /(?:^|\s|,)(\.[-\w]+)(?=\s*[{,\s])/gm;

// ID selectors: #name — same constraints as class selectors.
const _ID_SELECTOR_RE = /(?:^|\s|,)(#[-\w]+)(?=\s*[{,\s])/gm;

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

// CSS @import "path" / @import url("path"); SCSS @use / @forward.
// re.MULTILINE | re.VERBOSE -> whitespace/comments in the VERBOSE source are
// not significant; the equivalent compact pattern:
//   ^[ \t]*@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]
const _CSS_IMPORT_RE =
  /^[ \t]*@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]/gm;

// Whitespace-run normaliser for @rule headings.
const _WS_RUN_RE = /\s+/g;

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

const _MAX_SYMBOLS = 1000;

/**
 * Count "\n" in `s` (Python str.count("\n")).
 */
function _countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      n += 1;
    }
  }
  return n;
}

/**
 * Iterate all matches of a global regex over `text`, resetting lastIndex.
 */
function* _finditer(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index === re.lastIndex) {
      re.lastIndex += 1;
    }
    yield m;
  }
}

/**
 * Extract CSS / SCSS / Less symbols, imports, and sections from `source`.
 * Returns [symbols, refs, imports, sections]; refs are always empty.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const text = decode_source_text(source, _LOG, "css_idx");
  if (text === null) {
    return [[], [], [], []];
  }

  try {
    const stripped = _strip_comments(text);
    const lines = text.split("\n");
    const total_lines = lines.length;

    const symbols: Symbol[] = [];
    const imp_exp: ImpExp[] = [];
    const sections: Section[] = [];
    const seen: Set<string> = new Set();

    const _emit = make_symbol_emitter(symbols, sections, seen, {
      max_symbols: _MAX_SYMBOLS,
    });

    // @import / @use / @forward — extract import edges.
    for (const m of _finditer(_CSS_IMPORT_RE, stripped)) {
      const path = (m[1] ?? "").trim();
      if (path) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        imp_exp.push(new ImpExp({ kind: "import", target: path, line }));
      }
    }

    // @keyframes
    for (const m of _finditer(_KEYFRAMES_RE, stripped)) {
      const name = (m[1] ?? "").trim();
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(`@keyframes ${name}`, "css_keyframe", line);
      }
    }

    // @mixin
    for (const m of _finditer(_MIXIN_RE, stripped)) {
      const name = (m[1] ?? "").trim();
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(`@mixin ${name}`, "css_mixin", line);
      }
    }

    // @rules (media, layer, supports, etc.)
    for (const m of _finditer(_ATRULE_RE, stripped)) {
      const raw = (m[1] ?? "").trim();
      // Normalize whitespace runs inside the query for compact headings.
      _WS_RUN_RE.lastIndex = 0;
      const name = raw.replace(_WS_RUN_RE, " ");
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, "css_rule", line);
      }
    }

    // Custom properties (--name). Use m.index of group 1: the captured group is
    // preceded by a leading whitespace/punctuation char, so we recompute the
    // group's start offset.
    const seen_vars: Set<string> = new Set();
    for (const m of _finditer(_CUSTOM_PROP_RE, stripped)) {
      const name = (m[1] ?? "").trim();
      if (name && !seen_vars.has(name)) {
        seen_vars.add(name);
        const g1start = _group1Start(m);
        const line = _countNewlines(stripped.slice(0, g1start)) + 1;
        _emit(name, "css_var", line);
      }
    }

    // Class selectors.
    const seen_cls: Set<string> = new Set();
    for (const m of _finditer(_CLASS_SELECTOR_RE, stripped)) {
      const name = (m[1] ?? "").trim();
      if (name && !seen_cls.has(name)) {
        seen_cls.add(name);
        const g1start = _group1Start(m);
        const line = _countNewlines(stripped.slice(0, g1start)) + 1;
        _emit(name, "css_selector", line);
      }
    }

    // ID selectors.
    const seen_ids: Set<string> = new Set();
    for (const m of _finditer(_ID_SELECTOR_RE, stripped)) {
      const name = (m[1] ?? "").trim();
      if (name && !seen_ids.has(name)) {
        seen_ids.add(name);
        const g1start = _group1Start(m);
        const line = _countNewlines(stripped.slice(0, g1start)) + 1;
        _emit(name, "css_selector", line);
      }
    }

    // Sort sections by line then assign end_lines (stable, like Python sort).
    sections.sort((a, b) => a.line - b.line);
    assign_flat_end_lines(sections, total_lines);
    propagate_section_end_lines_to_symbols(symbols, sections);

    return [symbols, [], imp_exp, sections];
  } catch (exc) {
    _LOG.debug(
      "css_idx: parse failed for %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}

/**
 * Return the UTF-16 start offset of capture group 1 within the whole match.
 *
 * Python uses m.start(1). JS RegExpExecArray does not expose per-group offsets
 * directly, so we recover it: the captured group's text is `m[1]`, which is the
 * tail of the whole match `m[0]` (the leading context before group 1 is the
 * difference). group1Start = m.index + (len(m[0]) - len(m[1]) ... ) but the
 * group is not necessarily the suffix when a lookahead trails it. For all
 * css_idx group-1 patterns, group 1 is followed only by a zero-width lookahead
 * or a non-captured `:`/whitespace, so group 1 is a substring of m[0]; we locate
 * its first occurrence within m[0] starting after the leading context.
 */
function _group1Start(m: RegExpExecArray): number {
  const whole = m[0];
  const g1 = m[1] ?? "";
  // The captured group is the LAST occurrence of g1 in `whole` that leaves room
  // for any trailing non-captured chars. For these patterns the captured token
  // (e.g. ".foo", "--bar") is unique and unambiguous; find its index in `whole`.
  // Custom-prop / selector patterns: group 1 begins after leading
  // whitespace/punctuation, so the first index of g1 in `whole` is its start.
  const rel = whole.indexOf(g1);
  return m.index + (rel === -1 ? 0 : rel);
}
