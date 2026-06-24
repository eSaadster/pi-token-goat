/**
 * YAML extractor — emits Sections for top-level keys and (optionally) nested ones.
 *
 * Faithful port of src/token_goat/languages/yaml_idx.py. Strict NodeNext ESM.
 *
 * Why a line-scanner rather than PyYAML:
 *
 * * PyYAML is not a token-goat dependency. Pulling it in just for source-line
 *   positions is disproportionate: the indexer already takes ~1 s on a fresh
 *   install and a YAML parse for every file would add measurable overhead.
 *
 * * The structure we need is shallow: top-level keys and (optionally) the keys
 *   one level below. Both can be detected by a line-by-line scan that tracks
 *   column-0 keys (top level) and configurable-indent keys (one level deep).
 *
 * What counts as a "section"
 * --------------------------
 * * A line of the form `^([A-Za-z_][\w-]*):` at column 0 starts a top-level
 *   section. Its content runs from that line through the line before the next
 *   column-0 key (or EOF for the last one).
 *
 * * Inside each section, lines indented with exactly the file's detected
 *   indent (almost always 2 spaces) of the form `<indent>([A-Za-z_][\w-]*):`
 *   are emitted as nested `parent.child` sections. This lets callers do
 *   `token-goat section deployment.yaml::spec.replicas` instead of pulling the
 *   whole spec block.
 *
 * What is intentionally skipped
 * -----------------------------
 * * List items (`- foo:`) — these are sequence entries, not keys, and would
 *   bloat the section table with positional noise.
 * * Multi-document YAML (`---`-separated streams) — we treat the file as a
 *   single logical document. In practice `---` is rarely used for source-
 *   code-adjacent YAML (CI configs, ansible playbooks, k8s manifests) where
 *   this hint matters; the rare multi-doc file simply gets its first document
 *   indexed and the rest fall through.
 * * Lines inside flow-style mappings (`{ ... }`) — the line scanner cannot
 *   reliably track flow scope without a full parse, so any line that starts
 *   inside a brace block is left to the read path to handle.
 * * Comments and blank lines.
 *
 * Safety
 * ------
 * A pathologically structured file (mixed indents, tabs, alternating styles)
 * may produce inaccurate end_line values for nested sections. This degrades
 * gracefully: the worst outcome is that `token-goat section` returns a slightly
 * larger or smaller slice than the user expected, never a crash.
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import { bom_strip_first_line, decode_source_text } from "./common.js";

export const __all__ = ["extract"] as const;

const _LOG = getLogger("languages.yaml_idx");

// Largest indent width (in spaces) we treat as a single nesting level. Above
// this the file is assumed to use an unusual style and we suppress nested
// section emission rather than guess wrong.
const _MAX_DETECTED_INDENT = 8;
// Maximum number of top-level + nested sections combined per file. A
// misbehaving generated YAML (thousands of leaf keys at column 0) could
// otherwise inflate the index without bound.
const _MAX_SECTIONS_PER_FILE = 400;
// Maximum length of a heading we accept. Real YAML keys are short (tens of
// characters); a giant captured "key" is almost certainly a pathological line
// and we drop it rather than store it.
const _MAX_HEADING_LEN = 200;

// Match a top-level key: column-0 anchor, ASCII identifier-ish characters,
// trailing colon. We allow hyphens and dots because those are common in
// real-world YAML (e.g. Kubernetes labels), but stop before `:` so the
// captured name does not include the value or inline annotation.
//
// Python: re.compile(r"^([A-Za-z_][A-Za-z0-9_\-.]*)\s*:(?:\s|$)")
const _TOP_KEY_RE = /^([A-Za-z_][A-Za-z0-9_\-.]*)\s*:(?:\s|$)/;

// A generic indented key — same body, but with leading spaces. The caller
// decides whether the indent matches a nesting level we are willing to emit.
//
// Python: re.compile(r"^( +)([A-Za-z_][A-Za-z0-9_\-.]*)\s*:(?:\s|$)")
const _INDENTED_KEY_RE = /^( +)([A-Za-z_][A-Za-z0-9_\-.]*)\s*:(?:\s|$)/;

/** Length of `s` in CODE POINTS (Python len(str)). */
function _lenCodepoints(s: string): number {
  let n = 0;
  for (const _ of s) {
    n += 1;
  }
  return n;
}

/**
 * Reproduce Python's `re.Pattern.match(s)` (anchored at string start) for the
 * column-0 top-level key pattern. Returns the match array or null.
 *
 * A sticky (`y`) clone anchored at lastIndex=0 reproduces Python's `.match`
 * (match must begin at the start of the string).
 */
function _matchTopKey(s: string): RegExpMatchArray | null {
  const re = new RegExp(_TOP_KEY_RE.source, "y");
  re.lastIndex = 0;
  return re.exec(s);
}

/** Same as `_matchTopKey` but for the indented-key pattern. */
function _matchIndentedKey(s: string): RegExpMatchArray | null {
  const re = new RegExp(_INDENTED_KEY_RE.source, "y");
  re.lastIndex = 0;
  return re.exec(s);
}

/**
 * Heuristically detect the file's per-level indent width (in spaces).
 *
 * Returns the smallest non-zero indent observed on a key-shaped line, capped at
 * `_MAX_DETECTED_INDENT`. Falls back to `2` when no indented key is found —
 * that is the default for nearly every modern YAML style guide. Tabs are not
 * supported as indent leaders (rare in modern YAML; the spec technically
 * forbids them for indentation though some parsers accept them).
 */
function _detectIndent(lines: ReadonlyArray<string>): number {
  let smallest = 0;
  for (const line of lines) {
    if (!line || line[0] !== " ") {
      continue;
    }
    // Skip pure comment/empty lines.
    // Python: line.lstrip(" ")
    const stripped = line.replace(/^ +/, "");
    if (!stripped || stripped.startsWith("#")) {
      continue;
    }
    const m = _matchIndentedKey(line);
    if (m === null) {
      continue;
    }
    const width = (m[1] as string).length;
    if (0 < width && width <= _MAX_DETECTED_INDENT && (smallest === 0 || width < smallest)) {
      smallest = width;
      if (smallest === 1) {
        break;
      }
    }
  }
  return smallest || 2;
}

/**
 * Extract top-level (and one-level-nested) YAML keys as `Section` entries.
 *
 * Symbols mirror the section headings as `yaml_key` (top level) and
 * `yaml_nested_key` (one level deep). Refs and imports are always empty.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const text = decode_source_text(source, _LOG, "yaml_idx");
  if (text === null) {
    return [[], [], [], []];
  }

  const lines = text.split("\n");
  if (lines.length === 0) {
    return [[], [], [], []];
  }

  const indentUnit = _detectIndent(lines);

  const sections: Section[] = [];
  const symbols: Symbol[] = [];
  // Tracks the most recent top-level section so we can prefix nested keys with
  // their parent name (`spec.replicas` rather than just `replicas`).
  let currentTop: Section | null = null;

  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const idx = idx0 + 1;
    const line = lines[idx0] as string;
    // Strip a UTF-8 BOM if present on line 1; otherwise the column-0 regex
    // anchor would miss the first key.
    const candidate = bom_strip_first_line(line, idx);
    if (!candidate || candidate.startsWith("#")) {
      continue;
    }
    // Multi-document marker resets the parser state for the next doc.
    if (candidate.startsWith("---") || candidate.startsWith("...")) {
      currentTop = null;
      continue;
    }

    // Top-level key (column 0)
    const topM = _matchTopKey(candidate);
    if (topM !== null) {
      const name = topM[1] as string;
      if (!name || _lenCodepoints(name) > _MAX_HEADING_LEN) {
        continue;
      }
      const sec = new Section({ heading: name, level: 1, line: idx });
      sections.push(sec);
      symbols.push(new Symbol({ name, kind: "yaml_key", line: idx }));
      currentTop = sec;
      if (sections.length >= _MAX_SECTIONS_PER_FILE) {
        break;
      }
      continue;
    }

    // Nested key at exactly one indent level deep.
    const indM = _matchIndentedKey(candidate);
    if (indM === null || currentTop === null) {
      continue;
    }
    const leading = indM[1] as string;
    if (leading.length !== indentUnit) {
      continue;
    }
    const childName = indM[2] as string;
    if (!childName || _lenCodepoints(childName) > _MAX_HEADING_LEN) {
      continue;
    }
    const fullName = `${currentTop.heading}.${childName}`;
    if (_lenCodepoints(fullName) > _MAX_HEADING_LEN) {
      continue;
    }
    sections.push(new Section({ heading: fullName, level: 2, line: idx }));
    symbols.push(new Symbol({ name: fullName, kind: "yaml_nested_key", line: idx }));
    if (sections.length >= _MAX_SECTIONS_PER_FILE) {
      break;
    }
  }

  // End-line computation. Each section runs until the line before the next
  // section at the *same or shallower* level — same logic as Markdown's heading
  // nesting. The last section runs to EOF.
  const total = lines.length;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i] as Section;
    let endLine = total;
    for (let j = i + 1; j < sections.length; j++) {
      if ((sections[j] as Section).level <= sec.level) {
        endLine = Math.max(sec.line, (sections[j] as Section).line - 1);
        break;
      }
    }
    sec.end_line = endLine;
  }

  return [symbols, [], [], sections];
}
