/**
 * Makefile extractor — target names and `define` blocks.
 *
 * Faithful port of src/token_goat/languages/makefile_idx.py.
 *
 * Surfaces target names and `define … endef` variable blocks so
 * `token-goat symbol test` jumps to the `test:` target and
 * `token-goat section Makefile::build` returns just the build recipe.
 *
 * What is extracted
 * -----------------
 * Symbols:
 *  - `makefile_target` — any target declared at column 0 matching `target:` or
 *    `target::` (phony targets, double-colon rules). Variable-expansion targets
 *    (`$(foo):`) and pattern rules (`%.o:`) are included when the whole
 *    expression precedes the colon. POSIX-special internal targets (`.PHONY`,
 *    etc.) are NOT emitted.
 *  - `makefile_define` — `define VARNAME … endef` multi-line variable blocks.
 *
 * Sections: each target and define block also becomes a Section. Section
 * end-lines follow the flat algorithm.
 *
 * Pure-regex scanner, no tree-sitter. Comment stripping runs as a pre-pass
 * (`# …` to end-of-line). Column-0 anchoring is mandatory for both patterns.
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import {
  assign_flat_end_lines,
  decode_source_text,
  propagate_section_end_lines_to_symbols,
} from "./common.js";

export const __all__ = ["extract"] as const;

const _LOG = getLogger("languages.makefile_idx");

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

// A Makefile comment is ``# …`` to end-of-line. We preserve the newline so that
// line numbers stay accurate. Global so .replace replaces every occurrence.
// Python: re.compile(r"#[^\n]*")
const _COMMENT_RE = /#[^\n]*/g;

/** Length of `s` in CODE POINTS (Python len(str)). */
function _lenCodepoints(s: string): number {
  let n = 0;
  for (const _ of s) {
    n += 1;
  }
  return n;
}

/** Count occurrences of "\n" in `s` (Python str.count("\n")). */
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
 * Replace comment regions with blanks, preserving line numbers.
 *
 * Python: `_COMMENT_RE.sub(lambda m: " " * len(m.group()), text)` — each match
 * is replaced with as many spaces as the match's code-point length. A `#…`
 * comment contains no newlines, so this preserves newline positions exactly.
 */
function _strip_comments(text: string): string {
  _COMMENT_RE.lastIndex = 0;
  return text.replace(_COMMENT_RE, (m) => " ".repeat(_lenCodepoints(m)));
}

// ---------------------------------------------------------------------------
// Extraction regexes
// ---------------------------------------------------------------------------

// Target rule: column-0 non-whitespace characters followed by a colon (single
// or double), optionally followed by prerequisites on the same line.
// Python: re.compile(r"^([^\t\n#:=][^:\n#=]*?):{1,2}\s*(?:[^=\n]|$)", re.MULTILINE)
const _TARGET_RE = /^([^\t\n#:=][^:\n#=]*?):{1,2}\s*(?:[^=\n]|$)/gm;

// ``define VARNAME`` at column 0.
// Python: re.compile(r"^define\s+([\w./%$()\-]+)", re.MULTILINE)
//
// Python \w (no re.UNICODE needed in py3 str patterns -> Unicode by default)
// matches [A-Za-z0-9_] plus Unicode word chars. The JS source below uses a bare
// \w (ASCII word chars). Makefile variable names are ASCII in practice; to stay
// closest to Python's Unicode \w we add the `u` flag is NOT used here because
// the rest of the patterns rely on ASCII semantics and define names are ASCII —
// matching the practical behaviour of the Python extractor.
const _DEFINE_RE = /^define\s+([\w./%$()\-]+)/gm;

// Internal (special) targets that GNU make reserves — never emitted as symbols.
const _SPECIAL_TARGETS: ReadonlySet<string> = new Set<string>([
  ".PHONY",
  ".DEFAULT",
  ".SUFFIXES",
  ".SILENT",
  ".PRECIOUS",
  ".IGNORE",
  ".NOTPARALLEL",
  ".ONESHELL",
  ".EXPORT_ALL_VARIABLES",
  ".INTERMEDIATE",
  ".SECONDARY",
  ".DELETE_ON_ERROR",
  ".LOW_RESOLUTION_TIME",
  ".POSIX",
  ".MAKEFLAGS",
]);

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

const _MAX_SYMBOLS = 500;
const _MAX_HEADING_LEN = 120;

/**
 * Python str.strip(): trim leading/trailing whitespace. JS `\s` (no `u` flag)
 * covers the ASCII whitespace plus the Unicode space separators / BOM that
 * Python's str.strip() also removes, which is sufficient for Makefile target
 * names (the captured group never contains tabs or newlines).
 */
function _strip(s: string): string {
  return s.replace(/^\s+/, "").replace(/\s+$/, "");
}

/**
 * Extract Makefile targets and `define` blocks as symbols and sections.
 *
 * Returns `(symbols, refs, imports, sections)`. Refs and imports are always
 * empty.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const text = decode_source_text(source, _LOG, "makefile_idx");
  if (text === null) {
    return [[], [], [], []];
  }

  try {
    const stripped = _strip_comments(text);
    const lines = text.split("\n");
    const total_lines = lines.length;

    const symbols: Symbol[] = [];
    const sections: Section[] = [];
    const seen: Set<string> = new Set();

    const _emit = (name: string, kind: string, line: number): void => {
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

    // Targets
    _TARGET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = _TARGET_RE.exec(stripped)) !== null) {
      if (m.index === _TARGET_RE.lastIndex) {
        _TARGET_RE.lastIndex += 1;
      }
      const raw_target = _strip(m[1] as string);
      // Skip purely whitespace or empty targets (defensive).
      if (!raw_target) {
        continue;
      }
      // Skip internal special targets.
      if (_SPECIAL_TARGETS.has(raw_target)) {
        continue;
      }
      const line = _countNewlines(stripped.slice(0, m.index)) + 1;
      _emit(raw_target, "makefile_target", line);
    }

    // define blocks
    _DEFINE_RE.lastIndex = 0;
    while ((m = _DEFINE_RE.exec(stripped)) !== null) {
      if (m.index === _DEFINE_RE.lastIndex) {
        _DEFINE_RE.lastIndex += 1;
      }
      const name = _strip(m[1] as string);
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, "makefile_define", line);
      }
    }

    // Sort sections by line then assign end-lines using the flat algorithm.
    sections.sort((a, b) => a.line - b.line);
    assign_flat_end_lines(sections, total_lines);
    // Propagate computed end_lines to Symbol objects.
    propagate_section_end_lines_to_symbols(symbols, sections);

    return [symbols, [], [], sections];
  } catch (exc) {
    _LOG.debug(
      "makefile_idx: parse failed for %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}
