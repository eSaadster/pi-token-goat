/**
 * Shopify Liquid template extractor — includes, sections, renders, schema,
 * HTML headings.
 *
 * Faithful port of src/token_goat/languages/liquid.py. Strict NodeNext ESM.
 *
 * Byte-offset parity: common.build_line_index / common.offset_to_line are
 * BYTE-accurate in this port, so each regex match's UTF-16 index is converted to
 * a UTF-8 byte offset (via Buffer) before mapping to a line — reproducing
 * Python's character-offset → line mapping for any input.
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import {
  build_line_index,
  extract_and_finalize_html_sections,
  offset_to_line,
} from "./common.js";

const _LOG = getLogger("languages.liquid");

// Regex for {% include 'snippet-name' %}, {% section 'name' %},
// {% render 'name' %} (IGNORECASE). Global so finditer-style loops advance.
const _INCLUDE_RE = /{%\s*include\s+['"]([^'"]+)['"]/gi;
const _SECTION_RE = /{%\s*section\s+['"]([^'"]+)['"]/gi;
const _RENDER_RE = /{%\s*render\s+['"]([^'"]+)['"]/gi;

// {% schema %} ... {% endschema %} (IGNORECASE + DOTALL via [\s\S]).
const _SCHEMA_RE = /{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/gi;

// Liquid tag regex -> ImpExp kind triples (include/section/render share shape).
const _LIQUID_TAG_IMPORTS: ReadonlyArray<[RegExp, string]> = [
  [_INCLUDE_RE, "liquid_include"],
  [_SECTION_RE, "liquid_section"],
  [_RENDER_RE, "liquid_render"],
];

/** Convert a UTF-16 code-unit index in `text` to a UTF-8 BYTE offset. */
function _byteOffset(text: string, charIndex: number): number {
  return Buffer.byteLength(text.slice(0, charIndex), "utf-8");
}

/** Python str.strip(' "\'') — strip leading/trailing space, " and ' chars. */
function _stripChars(s: string, chars: string): string {
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
 * Python `Path(rel_path).stem`: the final path component with its last suffix
 * removed. Handles both POSIX and Windows separators (PurePath on the host OS;
 * tests run on POSIX, but Python's Path also splits "\\" on POSIX only when it
 * is a real separator — here rel_path is already a forward-slash repo path).
 */
function _pathStem(rel_path: string): string {
  // Split on the last forward slash (POSIX). Python's Path on POSIX treats only
  // "/" as a separator; the caller already normalises in rel_posix above but the
  // stem is taken from the original rel_path, matching Python exactly.
  const slash = rel_path.lastIndexOf("/");
  const name = slash === -1 ? rel_path : rel_path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  // Python stem keeps a leading-dot dotfile whole (".gitignore".stem == ".gitignore").
  if (dot <= 0) {
    return name;
  }
  return name.slice(0, dot);
}

/**
 * Extract symbols, imports, and sections from a Shopify Liquid template.
 *
 * Symbols: liquid_schema (the JSON `name` field of a {% schema %} block),
 * liquid_section_file (filename stem for files under sections/).
 * Imports: liquid_include / liquid_section / liquid_render tag targets.
 * Sections: <h1>-<h6> HTML headings (shared with html.py). Refs always empty.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  try {
    const text = source.toString("utf-8");
    const symbols: Symbol[] = [];
    const imports: ImpExp[] = [];
    const sections: Section[] = [];

    const lines = text.split("\n");

    // Build a line-start (byte) offset index once; all match-position -> line
    // conversions below use O(log n) binary search.
    const line_index = build_line_index(text);

    // --- Extract includes/sections/renders ---
    for (const [pattern, kind] of _LIQUID_TAG_IMPORTS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        if (m.index === pattern.lastIndex) {
          pattern.lastIndex += 1;
        }
        const target = m[1] as string;
        const line = offset_to_line(line_index, _byteOffset(text, m.index));
        imports.push(new ImpExp({ kind, target, line }));
      }
    }

    // --- Extract schema block ---
    _SCHEMA_RE.lastIndex = 0;
    let sm: RegExpExecArray | null;
    while ((sm = _SCHEMA_RE.exec(text)) !== null) {
      if (sm.index === _SCHEMA_RE.lastIndex) {
        _SCHEMA_RE.lastIndex += 1;
      }
      const schema_content = (sm[1] as string).trim();
      let schema_json: unknown;
      try {
        schema_json = JSON.parse(schema_content);
      } catch (exc) {
        _LOG.debug(
          "invalid JSON in schema block in %s: %s",
          rel_path,
          exc instanceof Error ? exc.message : String(exc),
        );
        continue;
      }
      if (
        schema_json !== null &&
        typeof schema_json === "object" &&
        !Array.isArray(schema_json) &&
        "name" in (schema_json as Record<string, unknown>)
      ) {
        const name = _pyStr((schema_json as Record<string, unknown>)["name"]);
        const line = offset_to_line(line_index, _byteOffset(text, sm.index));
        const end_line = offset_to_line(
          line_index,
          _byteOffset(text, sm.index + sm[0].length),
        );
        symbols.push(
          new Symbol({ name, kind: "liquid_schema", line, end_line }),
        );
      }
    }

    // --- Section-file symbol (if file is in sections/ directory) ---
    const rel_posix = rel_path.replace(/\\/g, "/");
    if (rel_posix.startsWith("sections/")) {
      const section_name = _pathStem(rel_path);
      symbols.push(
        new Symbol({ name: section_name, kind: "liquid_section_file", line: 1 }),
      );
    }

    // --- Extract HTML headings within Liquid and compute end_line ---
    extract_and_finalize_html_sections(text, sections, lines);

    return [symbols, [], imports, sections];
  } catch (exc) {
    _LOG.debug(
      "parse failed for liquid source: %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}

/**
 * Reproduce Python `str(value)` for the schema name. JSON-parsed values are
 * string/number/boolean/null/object/array; Python's str() of each differs from
 * JS String(). For dict/list it would emit Python repr, but Shopify schema names
 * are strings in practice. We cover the JSON scalar cases faithfully:
 *   - true/false -> "True"/"False" (Python bool repr)
 *   - null       -> "None"
 *   - number     -> Python str(int/float)
 *   - string     -> as-is
 */
function _pyStr(value: unknown): string {
  if (value === null) {
    return "None";
  }
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    // JSON numbers: integers print without ".0", floats keep their form, which
    // matches Python str() for the common cases (JSON has no int/float tag, but
    // a whole number parses to a JS number whose String() drops ".0" — same as
    // Python str(int)).
    return String(value);
  }
  // Objects/arrays: fall back to JSON; schema "name" is a string in practice.
  return String(value);
}
