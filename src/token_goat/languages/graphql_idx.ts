/**
 * GraphQL schema / document extractor — types, queries, mutations, subscriptions, fragments.
 *
 * Faithful port of src/token_goat/languages/graphql_idx.py. Strict NodeNext ESM.
 *
 * GraphQL files (.graphql, .gql) can be large schemas with hundreds of type
 * definitions. Agents typically need only one type, resolver, or field
 * definition. This extractor gives `token-goat section schema.graphql::User` the
 * ability to return a 30-line type block instead of a 1000-line schema.
 *
 * Pure-regex scanner, no tree-sitter. Comment stripping runs as a pre-pass (`#`
 * line comments only — GraphQL has no block-comment syntax) to avoid false
 * positives inside comments. Import extraction runs BEFORE comment stripping
 * because `#import` pragmas are represented as comments in the source text and
 * would be erased by the pre-pass.
 *
 * Line numbers are derived by counting "\n" in the character prefix before each
 * match (Python `text[:m.start()].count("\n") + 1`); this is character-based and
 * matches Python regardless of byte width.
 */

import { ImpExp, type Ref, type Section, type Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";

const _LOG = getLogger("languages.graphql_idx");

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

// GraphQL uses `# comment` line comments only — no block comments.
const _LINE_COMMENT_RE = /#[^\n]*/g;

/** Replace `#` comment regions with whitespace, preserving line numbers. */
function _strip_comments(text: string): string {
  _LINE_COMMENT_RE.lastIndex = 0;
  return text.replace(_LINE_COMMENT_RE, "");
}

// ---------------------------------------------------------------------------
// Extraction regexes
// ---------------------------------------------------------------------------

// GraphQL type/interface/input/enum/union/scalar definitions, with optional
// leading `extend`. Captures only the Name.
const _TYPE_RE =
  /^[ \t]*(extend\s+)?(type|interface|input|enum|union|scalar)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

// `directive @name` definitions. The `@` is not captured into the name.
const _DIRECTIVE_RE = /^[ \t]*directive\s+@([A-Za-z_][A-Za-z0-9_]*)/gm;

// `fragment FragmentName on TypeName` definitions.
const _FRAGMENT_RE = /^[ \t]*fragment\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+/gm;

// Named operations: `query Name`, `mutation Name`, `subscription Name`.
const _OPERATION_RE =
  /^[ \t]*(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

// The root `schema { }` declaration. Emitted as the symbol "schema".
const _SCHEMA_RE = /^[ \t]*schema\s*\{/gm;

// ---------------------------------------------------------------------------
// Import pragma extraction
// ---------------------------------------------------------------------------

// `# import FragmentName from "path.graphql"` (graphql-tag / graphql-code-generator
// pragma). Matches both path-only and with-from-clause forms. Single and double
// quotes accepted. Faithful translation of the Python VERBOSE pattern:
//   ^[ \t]*\#[ \t]*import\b (?:[^"'\n]*)? ['"]([^'"]+)['"]
const _GRAPHQL_IMPORT_RE = /^[ \t]*#[ \t]*import\b(?:[^"'\n]*)?['"]([^'"]+)['"]/gm;

// ---------------------------------------------------------------------------
// Map GraphQL keyword -> symbol kind.
// ---------------------------------------------------------------------------

const _KIND_MAP: Record<string, string> = {
  type: "graphql_type",
  interface: "graphql_interface",
  input: "graphql_input",
  enum: "graphql_enum",
  union: "graphql_union",
  scalar: "graphql_scalar",
};

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

/**
 * Extract GraphQL symbols, imports, and sections from `source`.
 *
 * Return signature matches every other language extractor:
 * `(symbols, refs, imports, sections)`. `# import` pragmas are returned as
 * ImpExp entries with kind="import". Import extraction runs on the raw text
 * before comment stripping so the pragma lines are not erased.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const text = common.decode_source_text(source, _LOG, "graphql_idx");
  if (text === null) {
    return [[], [], [], []];
  }

  try {
    // Extract imports BEFORE stripping comments — #import pragmas live in
    // comment-like lines and would be erased by the pre-pass.
    const imp_exp: ImpExp[] = [];
    _GRAPHQL_IMPORT_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = _GRAPHQL_IMPORT_RE.exec(text)) !== null) {
      if (im.index === _GRAPHQL_IMPORT_RE.lastIndex) {
        _GRAPHQL_IMPORT_RE.lastIndex += 1;
      }
      const path = (im[1] ?? "").trim();
      if (path) {
        const line = _countNewlines(text.slice(0, im.index)) + 1;
        imp_exp.push(new ImpExp({ kind: "import", target: path, line }));
      }
    }

    const stripped = _strip_comments(text);
    const total_lines = _countNewlines(text) + 1;

    const symbols: Symbol[] = [];
    const sections: Section[] = [];
    const seen: Set<string> = new Set();

    const _emit = common.make_symbol_emitter(symbols, sections, seen);

    // type / interface / input / enum / union / scalar (+ extend variants)
    _TYPE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = _TYPE_RE.exec(stripped)) !== null) {
      if (m.index === _TYPE_RE.lastIndex) {
        _TYPE_RE.lastIndex += 1;
      }
      const keyword = m[2] as string;
      const name = (m[3] ?? "").trim();
      const is_extend = Boolean(m[1]);
      if (name) {
        const kind = is_extend
          ? "graphql_extend"
          : _KIND_MAP[keyword] ?? "graphql_type";
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, kind, line);
      }
    }

    // directive @name
    _DIRECTIVE_RE.lastIndex = 0;
    while ((m = _DIRECTIVE_RE.exec(stripped)) !== null) {
      if (m.index === _DIRECTIVE_RE.lastIndex) {
        _DIRECTIVE_RE.lastIndex += 1;
      }
      const name = (m[1] ?? "").trim();
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(`@${name}`, "graphql_directive", line);
      }
    }

    // fragment FragmentName on ...
    _FRAGMENT_RE.lastIndex = 0;
    while ((m = _FRAGMENT_RE.exec(stripped)) !== null) {
      if (m.index === _FRAGMENT_RE.lastIndex) {
        _FRAGMENT_RE.lastIndex += 1;
      }
      const name = (m[1] ?? "").trim();
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, "graphql_fragment", line);
      }
    }

    // query/mutation/subscription Name
    _OPERATION_RE.lastIndex = 0;
    while ((m = _OPERATION_RE.exec(stripped)) !== null) {
      if (m.index === _OPERATION_RE.lastIndex) {
        _OPERATION_RE.lastIndex += 1;
      }
      const op = m[1] as string;
      const name = (m[2] ?? "").trim();
      if (name) {
        const kind = `graphql_${op}`;
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, kind, line);
      }
    }

    // schema { }
    _SCHEMA_RE.lastIndex = 0;
    while ((m = _SCHEMA_RE.exec(stripped)) !== null) {
      if (m.index === _SCHEMA_RE.lastIndex) {
        _SCHEMA_RE.lastIndex += 1;
      }
      const line = _countNewlines(stripped.slice(0, m.index)) + 1;
      _emit("schema", "graphql_schema", line);
    }

    // Sort sections by line then assign end_lines.
    sections.sort((a, b) => a.line - b.line);
    common.assign_flat_end_lines(sections, total_lines);
    // Propagate computed end_lines to Symbol objects so that
    // `token-goat scope` can match enclosing GraphQL definitions.
    common.propagate_section_end_lines_to_symbols(symbols, sections);

    return [symbols, [], imp_exp, sections];
  } catch (exc) {
    _LOG.debug(
      "graphql_idx: parse failed for %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}
