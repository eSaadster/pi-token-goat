/**
 * Markdown extractor — ATX headings, Setext headings, front-matter titles.
 *
 * Faithful port of src/token_goat/languages/markdown.py. Strict NodeNext ESM.
 *
 * Offset parity: markdown.py maps match positions to lines by counting "\n" in
 * the prefix (`text[:match.start()].count("\n") + 1`). Newlines are ASCII, so
 * counting newlines over UTF-16 code units is byte-exact; this port counts "\n"
 * in `text.slice(0, index)` directly, matching Python regardless of multi-byte
 * content elsewhere in the line.
 *
 * MISSING EXPORT (reported): markdown.py calls `common._compute_section_end_lines`
 * directly (a module-private helper that is NOT exported from common.ts). Per the
 * "do not edit common.ts" constraint, an exact local copy `_compute_section_end_lines`
 * is inlined below. If common.ts later exports it, this local copy should be
 * replaced with the import.
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";

const _LOG = getLogger("languages.markdown");

// ATX headings: ^#{1,6} followed by text. MULTILINE -> 'm'.
const _ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

// Setext underline patterns (matched against a single line, anchored at start).
const _SETEXT_H1_UNDERLINE_RE = /^=+\s*$/;
const _SETEXT_H2_UNDERLINE_RE = /^-+\s*$/;
// A horizontal rule (HR) — kept for parity with Python (unused there too beyond
// documentation; the setext disambiguation relies on the blank-line guard).
const _HR_RE = /^ {0,3}([-_*])(?:\s*\1){2,}\s*$/;

// Front-matter YAML: starts with --- and ends with --- (DOTALL -> [\s\S]).
// Anchored at string start via leading ^ (no 'm' flag, so ^ is start-of-string).
const _FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

// YAML key: value (simple extraction). MULTILINE -> 'm'.
const _YAML_TITLE_RE = /^\s*title\s*:\s*(.+?)\s*$/m;

// Fenced code-block delimiter at start of a line (matched per-line, anchored).
const _FENCE_RE = /^ {0,3}(```|~~~)/;

// Ordered list marker prefix (matched against a stripped line, anchored).
const _ORDERED_LIST_RE = /^\d{1,9}[.)]\s/;

// <details>/<summary> patterns (IGNORECASE; summary DOTALL via [\s\S]). The
// open/close patterns are global for finditer-style iteration.
const _DETAILS_OPEN_RE = /<details\b[^>]*>/gi;
const _DETAILS_CLOSE_RE = /<\/details\s*>/gi;
const _SUMMARY_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

// Inline tag / whitespace-run patterns used by _strip_inline_markup (global).
const _INLINE_TAG_RE = /<[^>]+>/g;
const _WS_RUN_RE = /\s+/g;

// Synthetic heading names + level constants.
export const FRONTMATTER_HEADING = "__frontmatter__";
export const DETAILS_NO_SUMMARY = "__details__";
export const DETAILS_LEVEL = 99;

// Reference _HR_RE so strict TS does not flag it as unused while preserving the
// 1:1 module-constant parity with markdown.py.
void _HR_RE;

/** Count "\n" occurrences in `s` (Python str.count("\n")). */
function _countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      n += 1;
    }
  }
  return n;
}

/** Python str.strip() (no args): strip leading/trailing ASCII+Unicode whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/, "").replace(/\s+$/, "");
}

/** Python str.lstrip(" "): strip only leading space characters. */
function _lstripSpace(s: string): string {
  let i = 0;
  while (i < s.length && s[i] === " ") {
    i += 1;
  }
  return s.slice(i);
}

/** Python str.strip(' "\'') — strip leading/trailing space, " and ' chars. */
function _stripQuotes(s: string): string {
  const chars = " \"'";
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start] as string)) {
    start += 1;
  }
  while (end > start && chars.includes(s[end - 1] as string)) {
    end -= 1;
  }
  return s.slice(start, end);
}

/**
 * Reproduce Python `re.Pattern.match(s)` (anchored at string start) for a
 * single-line pattern. The pattern must begin with `^`; we exec it and require
 * the match to start at index 0.
 */
function _matchAtStart(pattern: RegExp, s: string): RegExpExecArray | null {
  const flags = pattern.flags.replace(/[gy]/g, "") + "y";
  const re = new RegExp(pattern.source, flags);
  re.lastIndex = 0;
  return re.exec(s);
}

/**
 * Return the set of 1-based line numbers that fall inside a fenced code block.
 */
function _compute_fenced_line_set(lines: string[]): Set<number> {
  const inside: Set<number> = new Set();
  let fence_char: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const idx = i + 1;
    const line = lines[i] as string;
    const m = _matchAtStart(_FENCE_RE, line);
    if (m) {
      const delim = m[1] as string;
      if (fence_char === null) {
        // Opening fence
        fence_char = delim;
        inside.add(idx);
      } else if (fence_char === delim) {
        // Matching closing fence
        inside.add(idx);
        fence_char = null;
      } else {
        // A different delimiter while inside an open fence — still inside.
        inside.add(idx);
      }
    } else if (fence_char !== null) {
      inside.add(idx);
    }
  }
  return inside;
}

/** Return true if `line` starts with a blockquote (`>`) or list marker. */
function _is_blockquote_or_list_prefixed(line: string): boolean {
  const stripped = _lstripSpace(line);
  if (!stripped) {
    return false;
  }
  // Blockquote prefix.
  if (stripped.startsWith(">")) {
    return true;
  }
  // Unordered list markers: -, +, * (with at least one trailing space).
  if (
    stripped.length >= 2 &&
    "-+*".includes(stripped[0] as string) &&
    stripped[1] === " "
  ) {
    return true;
  }
  // Ordered list markers: `1.`, `42.`, `1)`, etc. (capped at 9 digits).
  const m = _matchAtStart(_ORDERED_LIST_RE, stripped);
  return m !== null;
}

/**
 * Scan `lines` for Setext headings, returning [line, level, text] tuples. The
 * returned line is the 1-indexed line of the heading TEXT, not the underline.
 */
function _find_setext_headings(
  lines: string[],
  fenced_lines: Set<number>,
  atx_lines: Set<number>,
): Array<[number, number, string]> {
  const results: Array<[number, number, string]> = [];
  const n = lines.length;
  for (let i = 1; i < n; i++) {
    const underline = lines[i] as string;
    if (fenced_lines.has(i + 1)) {
      continue;
    }
    const h1 = _matchAtStart(_SETEXT_H1_UNDERLINE_RE, underline) !== null;
    const h2 = _matchAtStart(_SETEXT_H2_UNDERLINE_RE, underline) !== null;
    if (!(h1 || h2)) {
      continue;
    }
    const text_line = lines[i - 1] as string;
    const text_lineno = i; // 1-indexed line of the text
    if (!_strip(text_line)) {
      continue;
    }
    if (fenced_lines.has(text_lineno)) {
      continue;
    }
    if (atx_lines.has(text_lineno)) {
      continue;
    }
    if (_is_blockquote_or_list_prefixed(text_line)) {
      continue;
    }
    const level = h1 ? 1 : 2;
    const text = _strip(text_line);
    if (!text) {
      continue;
    }
    results.push([text_lineno, level, text]);
  }
  return results;
}

/** Remove inline HTML tags / collapse whitespace from a `<summary>` body. */
function _strip_inline_markup(text: string): string {
  _INLINE_TAG_RE.lastIndex = 0;
  const no_tags = text.replace(_INLINE_TAG_RE, "");
  _WS_RUN_RE.lastIndex = 0;
  return _strip(no_tags.replace(_WS_RUN_RE, " "));
}

/**
 * Scan `text` for `<details>…</details>` blocks, returning
 * [start_line, end_line, summary_text] tuples for each well-formed outermost
 * block found outside fenced code regions.
 */
function _find_details_blocks(
  text: string,
  fenced_lines: Set<number>,
): Array<[number, number, string]> {
  const results: Array<[number, number, string]> = [];

  // Find all open / close positions in document order.
  const opens: Array<[number, number]> = [];
  _DETAILS_OPEN_RE.lastIndex = 0;
  let mo: RegExpExecArray | null;
  while ((mo = _DETAILS_OPEN_RE.exec(text)) !== null) {
    if (mo.index === _DETAILS_OPEN_RE.lastIndex) {
      _DETAILS_OPEN_RE.lastIndex += 1;
    }
    opens.push([mo.index, mo.index + mo[0].length]);
  }
  const closes: Array<[number, number]> = [];
  _DETAILS_CLOSE_RE.lastIndex = 0;
  let mc: RegExpExecArray | null;
  while ((mc = _DETAILS_CLOSE_RE.exec(text)) !== null) {
    if (mc.index === _DETAILS_CLOSE_RE.lastIndex) {
      _DETAILS_CLOSE_RE.lastIndex += 1;
    }
    closes.push([mc.index, mc.index + mc[0].length]);
  }
  if (opens.length === 0 || closes.length === 0) {
    return results;
  }

  // Merge into a single sorted timeline of [offset, kind, end_offset].
  // kind: 0 = open, 1 = close. Stable sort by (offset, kind).
  const events: Array<[number, number, number]> = [];
  for (const [s, e] of opens) {
    events.push([s, 0, e]);
  }
  for (const [s, e] of closes) {
    events.push([s, 1, e]);
  }
  // JS Array.sort is not guaranteed stable across all the comparison keys we
  // need, so include the full (offset, kind) compound key (Python's sort is
  // stable, but the explicit kind tiebreak makes the order identical).
  events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const open_stack: number[] = [];
  for (const [offset, kind, end] of events) {
    const line = _countNewlines(text.slice(0, offset)) + 1;
    if (fenced_lines.has(line)) {
      continue;
    }
    if (kind === 0) {
      // open
      open_stack.push(offset);
    } else {
      // close
      if (open_stack.length === 0) {
        // Stray </details> with no matching opener; ignore.
        continue;
      }
      const block_start = open_stack.pop() as number;
      // Only emit the outermost block.
      if (open_stack.length > 0) {
        continue;
      }
      const block_end_offset = end;
      const start_line = _countNewlines(text.slice(0, block_start)) + 1;
      const end_line = _countNewlines(text.slice(0, block_end_offset)) + 1;
      // First <summary>…</summary> inside this block.
      const inner = text.slice(block_start, block_end_offset);
      const sm = _SUMMARY_RE.exec(inner);
      let summary: string;
      if (sm) {
        summary = _strip_inline_markup(sm[1] as string);
        if (!summary) {
          summary = DETAILS_NO_SUMMARY;
        }
      } else {
        summary = DETAILS_NO_SUMMARY;
      }
      results.push([start_line, end_line, summary]);
    }
  }
  return results;
}

/**
 * Tighten each section's end_line by stepping back past trailing blank lines.
 * Mutates `sections` in-place.
 */
function _trim_trailing_blanks(sections: Section[], lines: string[]): void {
  const n = lines.length;
  for (const sec of sections) {
    if (sec.end_line === null) {
      continue;
    }
    let end = Math.min(sec.end_line, n);
    while (end > sec.line && !_strip(lines[end - 1] as string)) {
      end -= 1;
    }
    sec.end_line = end;
  }
}

/**
 * Local copy of common._compute_section_end_lines (a module-private helper not
 * exported from common.ts). Assign end_line to each Section based on the next
 * section of equal or lesser level. Mutates `sections` in-place; `lines` is used
 * only for the total line count (EOF).
 */
function _compute_section_end_lines(sections: Section[], lines: string[]): void {
  const total = lines.length;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i] as Section;
    let end_line = total;
    for (let j = i + 1; j < sections.length; j++) {
      if ((sections[j] as Section).level <= sec.level) {
        end_line = (sections[j] as Section).line - 1;
        break;
      }
    }
    sec.end_line = end_line;
  }
}

/**
 * Extract headings and front-matter from a Markdown file.
 *
 * Symbols: md_title (front-matter `title:`), heading (every ATX and Setext
 * heading; details-summary headings). Sections: ATX/Setext headings, a synthetic
 * __frontmatter__ section, and <details> blocks (level 99). Refs and imports are
 * always empty for Markdown.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  try {
    const text = source
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const symbols: Symbol[] = [];
    let sections: Section[] = [];

    const lines = text.split("\n");

    // --- Extract front-matter title + synthetic section ---
    const fm_match = _FRONTMATTER_RE.exec(text);
    if (fm_match && fm_match.index === 0) {
      const fm_content = fm_match[1] as string;
      const title_match = _YAML_TITLE_RE.exec(fm_content);
      if (title_match) {
        const title = _stripQuotes(title_match[1] as string);
        symbols.push(new Symbol({ name: title, kind: "md_title", line: 1 }));
      }
      const fm_end_offset = fm_match.index + fm_match[0].length;
      const fm_end_line = _countNewlines(text.slice(0, fm_end_offset));
      sections.push(
        new Section({
          heading: FRONTMATTER_HEADING,
          level: 0,
          line: 1,
          end_line: Math.max(1, fm_end_line),
        }),
      );
    }

    // --- Identify fenced code-block regions so we skip false-positive ATX ---
    const fenced_lines = _compute_fenced_line_set(lines);

    // Track which lines have an ATX heading so the setext pass doesn't
    // double-count a line that's already an ATX heading.
    const atx_lines: Set<number> = new Set();

    // --- Extract ATX headings (#-######), skipping those inside code fences ---
    _ATX_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = _ATX_RE.exec(text)) !== null) {
      if (am.index === _ATX_RE.lastIndex) {
        _ATX_RE.lastIndex += 1;
      }
      const level = (am[1] as string).length;
      const heading_text = _strip(am[2] as string);
      const line = _countNewlines(text.slice(0, am.index)) + 1;
      if (fenced_lines.has(line)) {
        continue;
      }
      const raw_line =
        0 <= line - 1 && line - 1 < lines.length ? (lines[line - 1] as string) : "";
      if (_is_blockquote_or_list_prefixed(raw_line)) {
        continue;
      }
      atx_lines.add(line);
      sections.push(new Section({ heading: heading_text, level, line }));
      symbols.push(new Symbol({ name: heading_text, kind: "heading", line }));
    }

    // --- Extract Setext headings (Title\n=== or Title\n---) ---
    for (const [s_line, s_level, s_text] of _find_setext_headings(
      lines,
      fenced_lines,
      atx_lines,
    )) {
      sections.push(
        new Section({ heading: s_text, level: s_level, line: s_line }),
      );
      symbols.push(new Symbol({ name: s_text, kind: "heading", line: s_line }));
    }

    // --- Extract <details><summary>…</summary>…</details> blocks ---
    const details_sections: Section[] = [];
    for (const [d_start, d_end, d_summary] of _find_details_blocks(
      text,
      fenced_lines,
    )) {
      details_sections.push(
        new Section({
          heading: d_summary,
          level: DETAILS_LEVEL,
          line: d_start,
          end_line: d_end,
        }),
      );
      if (d_summary !== DETAILS_NO_SUMMARY) {
        symbols.push(
          new Symbol({ name: d_summary, kind: "heading", line: d_start }),
        );
      }
    }

    // Sort sections by line so _compute_section_end_lines walks them in
    // document order. JS sort is stable for modern engines (V8), matching
    // Python's stable list.sort.
    sections.sort((a, b) => a.line - b.line);

    // --- Compute end_line for sections (skip front-matter; already set) ---
    const fm_sections = sections.filter((s) => s.heading === FRONTMATTER_HEADING);
    const body_sections = sections.filter(
      (s) => s.heading !== FRONTMATTER_HEADING,
    );
    _compute_section_end_lines(body_sections, lines);
    _trim_trailing_blanks(body_sections, lines);
    sections = [...fm_sections, ...body_sections, ...details_sections].sort(
      (a, b) => a.line - b.line,
    );

    return [symbols, [], [], sections];
  } catch (exc) {
    _LOG.debug(
      "parse failed for markdown source %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}
