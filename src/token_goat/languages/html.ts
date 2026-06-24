/**
 * HTML extractor — headings, id/class attributes, link/script imports.
 *
 * Faithful port of src/token_goat/languages/html.py. Strict NodeNext ESM.
 *
 * Byte-offset parity: Python's html.py uses common.build_line_index +
 * common.offset_to_line, which in this port are BYTE-accurate. The match
 * positions fed to offset_to_line (`match.start()` in Python) are CHARACTER
 * offsets into the decoded str in Python, but build_line_index/offset_to_line in
 * the TS common.ts work in UTF-8 byte offsets. To preserve the exact Python
 * mapping we therefore convert each JS match index (UTF-16 code-unit position)
 * into a BYTE offset before calling offset_to_line — mirroring what the Core
 * agent encoded into the byte-accurate helpers (the flat adapters compute byte
 * offsets via Buffer).
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import {
  build_line_index,
  extract_and_finalize_html_sections,
  offset_to_line,
} from "./common.js";

const _LOG = getLogger("languages.html");

// id and class attributes (IGNORECASE). Global so finditer-style loops advance.
const _ID_RE = /id=["']([^"']+)["']/gi;
const _CLASS_RE = /class=["']([^"']+)["']/gi;

// Links and scripts (IGNORECASE).
const _LINK_RE = /<link[^>]*href=["']([^"']+)["']/gi;
const _SCRIPT_RE = /<script[^>]*src=["']([^"']+)["']/gi;

// Common HTML classes/ids to skip (noise filter).
const _NOISE_IDS_CLASSES: ReadonlySet<string> = new Set([
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p",
  "container", "wrapper", "row", "col", "main", "content", "header", "footer",
  "nav", "navbar", "menu", "button", "link", "text", "box", "section", "page",
]);

/** Return true if this is a common/noisy id or class. */
function _is_noise(name: string): boolean {
  return _NOISE_IDS_CLASSES.has(name.toLowerCase());
}

/**
 * Convert a UTF-16 code-unit index in `text` to a UTF-8 BYTE offset. The
 * byte-accurate common.offset_to_line expects byte offsets; Python's match.start
 * was a character offset that the byte index happened to equal for ASCII. We
 * compute the byte length of the prefix to be exact for any input.
 */
function _byteOffset(text: string, charIndex: number): number {
  return Buffer.byteLength(text.slice(0, charIndex), "utf-8");
}

/** Python str.split() (no args): split on runs of whitespace, drop empties. */
function _splitWhitespace(s: string): string[] {
  return s.split(/\s+/).filter((x) => x.length > 0);
}

/**
 * Extract symbols, imports, and sections from an HTML file.
 *
 * Symbols: html_id (id="..." values), html_class (individual class tokens).
 * Imports: html_link (<link href>), html_script (<script src>).
 * Sections: <h1>-<h6> headings (with computed end_line; anchor sections for
 * id-bearing headings). Refs are always empty for HTML.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  try {
    const text = source.toString("utf-8");
    const symbols: Symbol[] = [];
    const sections: Section[] = [];
    const imports: ImpExp[] = [];

    const lines = text.split("\n");

    // Build a line-start (byte) offset index once; reuse it for all O(log n)
    // lookups instead of the O(n) slice-and-count pattern per match.
    const line_index = build_line_index(text);

    // --- Extract headings and compute end_line for each section ---
    extract_and_finalize_html_sections(text, sections, lines);

    // --- Extract id attributes (with noise filter) ---
    _ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = _ID_RE.exec(text)) !== null) {
      if (m.index === _ID_RE.lastIndex) {
        _ID_RE.lastIndex += 1;
      }
      const id_val = m[1] as string;
      if (!_is_noise(id_val)) {
        const line = offset_to_line(line_index, _byteOffset(text, m.index));
        symbols.push(new Symbol({ name: id_val, kind: "html_id", line }));
      }
    }

    // --- Extract class attributes (with noise filter) ---
    _CLASS_RE.lastIndex = 0;
    while ((m = _CLASS_RE.exec(text)) !== null) {
      if (m.index === _CLASS_RE.lastIndex) {
        _CLASS_RE.lastIndex += 1;
      }
      const class_val = m[1] as string;
      const tokens = _splitWhitespace(class_val);
      if (tokens.some((cls) => !_is_noise(cls))) {
        const line = offset_to_line(line_index, _byteOffset(text, m.index));
        for (const cls of tokens) {
          if (!_is_noise(cls)) {
            symbols.push(new Symbol({ name: cls, kind: "html_class", line }));
          }
        }
      }
    }

    // --- Extract link href ---
    _LINK_RE.lastIndex = 0;
    while ((m = _LINK_RE.exec(text)) !== null) {
      if (m.index === _LINK_RE.lastIndex) {
        _LINK_RE.lastIndex += 1;
      }
      const href = m[1] as string;
      const line = offset_to_line(line_index, _byteOffset(text, m.index));
      imports.push(new ImpExp({ kind: "html_link", target: href, line }));
    }

    // --- Extract script src ---
    _SCRIPT_RE.lastIndex = 0;
    while ((m = _SCRIPT_RE.exec(text)) !== null) {
      if (m.index === _SCRIPT_RE.lastIndex) {
        _SCRIPT_RE.lastIndex += 1;
      }
      const src = m[1] as string;
      const line = offset_to_line(line_index, _byteOffset(text, m.index));
      imports.push(new ImpExp({ kind: "html_script", target: src, line }));
    }

    return [symbols, [], imports, sections];
  } catch (exc) {
    _LOG.debug(
      "parse failed for html source: %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}
