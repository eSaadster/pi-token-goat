/**
 * Python symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/python.py. Strict NodeNext ESM.
 *
 * -----
 * What the Python engine does, and how this reproduces it
 * -----
 * python.py calls common.collect_symbols_and_refs("python", …), which runs the
 * OPAQUE Rust processor (tree_sitter_language_pack.process). For Python the
 * processor's structure pass emits a StructureItem per function/class/method;
 * its symbol pass (SymbolInfo) re-emits the SAME function/class/method records
 * (deduped on (name, line), so it adds nothing new — module-level `X = 1`
 * assignments are NOT surfaced as symbols); its import pass emits one ImportInfo
 * per `import`/`from … import` statement with `.source` = the full statement
 * text. python.py then:
 *   1. expands each import `.source` per-name via _parse_import_source,
 *   2. post-processes start_line back over leading @decorator lines via
 *      _extend_starts_for_decorators (common.extend_starts_for_decorators with
 *      the Python-specific _py_decorator_walk),
 *   3. extracts call-site refs by regex (common.CALL_RE) minus _CALL_NOISE.
 *
 * This adapter reproduces the structure + import passes by walking the raw
 * web-tree-sitter AST (ts_engine.walkStructure / walkImports), then reuses the
 * UNCHANGED common.ts helpers for refs, import expansion, and the decorator
 * post-pass — so the Python-specific behaviour (the decorator walker, the
 * _CALL_NOISE set, the import regex) is shared bit-for-bit with the oracle's
 * intent.
 *
 * Structure-walk fidelity (verified against the oracle):
 *  - function_definition -> kind "function"; class_definition -> kind "class".
 *  - A function/class nested inside ANOTHER function/class is promoted to
 *    "method" (parent_name != null and kind == "function" -> "method"); a class
 *    nested in a class stays "class" with parent_name set. This matches
 *    make_add_symbol(promote_methods=True): the promotion is function-only.
 *  - The processor descends through if/try/with/else/except blocks WITHOUT
 *    changing the parent, so a `def` inside `if True:` at module level has
 *    parent_name = null. Only function/class boundaries change the parent.
 *  - decorated_definition is transparent: the walk recurses into the wrapped
 *    definition, which reports the inner `def`/`class` line; the decorator
 *    post-pass then extends start_line back over the `@` lines.
 *  - signature = source[def_start : body_block_start], trimmed, <= 200 cp —
 *    computed on the RAW def span (before the decorator post-pass), so it does
 *    NOT include decorator lines.
 */

import type { Node } from "web-tree-sitter";

import type { Extractor, Ref, Section, Symbol } from "../parser.js";
import { ImpExp } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";
import {
  getParser,
  parseToTree,
  walkImports,
  walkStructure,
  type WalkConfig,
} from "./ts_engine.js";

const _LOG = getLogger("languages.python");

// ===========================================================================
// Python-specific node-type tables
// ===========================================================================

/** Declaration node types and their base kind. */
const _DEF_KIND: Record<string, string> = {
  function_definition: "function",
  class_definition: "class",
};

/** Import statement node types (full-statement `.source` analogue). */
const _IMPORT_TYPES: ReadonlySet<string> = new Set([
  "import_statement",
  "import_from_statement",
]);

// ---------------------------------------------------------------------------
// Decorator post-pass (Python-specific) — shared with python.py via common.ts
// ---------------------------------------------------------------------------

/**
 * Matches a decorator line (possibly indented) at the start of trimmed content.
 * Port of python.py _DECORATOR_LINE_RE (`^\s*@[A-Za-z_]`). Used by
 * {@link _py_decorator_walk}.
 */
const _DECORATOR_LINE_RE = /^\s*@[A-Za-z_]/;

/** Eligible kinds for the decorator start-line walk (never var/const). */
const _PY_ELIGIBLE_KINDS: ReadonlySet<string> = new Set(["function", "method", "class"]);

/**
 * Walk `def_line_1based` upward over consecutive Python decorator lines.
 *
 * Faithful port of python.py _py_decorator_walk: tolerates at most one blank
 * line between stacked decorators but stops at any non-decorator, non-blank
 * line. Returns the earliest 1-based line including all preceding `@decorator`
 * lines, or `def_line_1based` itself when none precede the definition.
 */
function _py_decorator_walk(text_lines: string[], def_line_1based: number): number {
  const n_lines = text_lines.length;
  if (def_line_1based <= 1 || def_line_1based > n_lines) {
    return def_line_1based;
  }
  let new_start = def_line_1based;
  let i = def_line_1based - 2; // 0-based index of the line directly above the def
  let saw_decorator = false;
  while (i >= 0) {
    const line = text_lines[i] as string;
    if (_DECORATOR_LINE_RE.test(line)) {
      new_start = i + 1; // 1-based line number
      saw_decorator = true;
      i -= 1;
      continue;
    }
    if (saw_decorator && line.trim() === "") {
      // blank gap between decorators — keep looking one line further
      i -= 1;
      continue;
    }
    break;
  }
  return new_start;
}

/**
 * Walk each function/class/method symbol's start_line back over leading
 * decorators. Faithful port of python.py _extend_starts_for_decorators:
 * delegates to common.extend_starts_for_decorators with the Python walker.
 * Mutates symbols in-place. Only function/method/class kinds are eligible.
 */
function _extend_starts_for_decorators(symbols: Symbol[], source: Buffer): void {
  common.extend_starts_for_decorators(symbols, source, {
    eligible_kinds: _PY_ELIGIBLE_KINDS,
    walk_fn: _py_decorator_walk,
  });
}

// ---------------------------------------------------------------------------
// Call-site ref noise filter (Python-specific) — port of python.py _CALL_NOISE
// ---------------------------------------------------------------------------

const _CALL_NOISE: ReadonlySet<string> = new Set([
  // Python builtins
  "print", "len", "range", "str", "int", "float", "bool", "list",
  "dict", "set", "tuple", "type", "isinstance", "issubclass",
  "hasattr", "getattr", "setattr", "delattr", "callable", "iter",
  "next", "enumerate", "zip", "map", "filter", "sorted", "reversed",
  "min", "max", "sum", "abs", "round", "pow", "divmod",
  "open", "repr", "hash", "id", "vars", "dir", "help",
  "super", "object", "property", "staticmethod", "classmethod",
  "raise", "assert", "return", "yield", "lambda",
  "if", "for", "while", "with", "except",
  // Common decorators when used with ()
  "wraps",
]);

// ---------------------------------------------------------------------------
// Import parsing — port of python.py _parse_import_source
// ---------------------------------------------------------------------------

// Compiled once. NON-dotall, NON-multiline (default JS RegExp): `.` does not
// span newlines and `^`/`$` anchor at string start/end — matching Python's
// re.compile without re.DOTALL/re.MULTILINE. A multi-line import `.source`
// (e.g. `from x import (\n A,\n B\n)`) therefore FAILS both patterns and falls
// through to `[line]`, exactly like python.py (verified against the oracle).
const _FROM_IMPORT_RE = /^from\s+(\S+)\s+import\s+(.+)$/;
const _PLAIN_IMPORT_RE = /^import\s+(.+)$/;

/** Python str.strip("()") — strip leading/trailing `(` and `)` runs. */
function _stripParens(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === "(" || s[start] === ")")) {
    start += 1;
  }
  while (end > start && (s[end - 1] === "(" || s[end - 1] === ")")) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Python `s.partition(" as ")[0]` — text before the first " as ", or all of s. */
function _beforeAs(s: string): string {
  const idx = s.indexOf(" as ");
  return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Return qualified import targets from one Python import statement source line.
 *
 * Faithful port of python.py _parse_import_source:
 *  - `from foo.bar import A, B as C` -> ["foo.bar.A", "foo.bar.B"]
 *  - `import os, pathlib.Path as P`  -> ["os", "pathlib.Path"]
 *  - Parenthesized single-line `from x import (A, B)` -> strip the `()`.
 *  - Unrecognised / multi-line lines -> the raw stripped line, verbatim.
 */
function _parse_import_source(source_line: string): string[] {
  const line = source_line.trim();
  const mFrom = _FROM_IMPORT_RE.exec(line);
  if (mFrom !== null) {
    const moduleName = mFrom[1] as string;
    let names_raw = mFrom[2] as string;
    names_raw = _stripParens(names_raw);
    const names = names_raw.split(",").map((n) => _beforeAs(n.trim()));
    return names.filter((n) => n && n !== "*").map((n) => `${moduleName}.${n}`);
  }
  const mPlain = _PLAIN_IMPORT_RE.exec(line);
  if (mPlain !== null) {
    const names_raw = mPlain[1] as string;
    const names = names_raw.split(",").map((n) => _beforeAs(n.trim()));
    return names.filter((n) => n);
  }
  return [line];
}

// ===========================================================================
// Structure-walk configuration
// ===========================================================================

/**
 * Return the body block of a function/class definition (field "body"), or null.
 * The signature is sliced from the def start to this node's start.
 */
function _bodyOf(node: Node): Node | null {
  return node.childForFieldName("body");
}

/**
 * Classify a node as a Python declaration, applying the function->method
 * promotion. Returns null for any non-def/class node (the walk then recurses
 * with the same parent — the container / decorator-wrapper pass-through).
 *
 * Promotion rule (matches make_add_symbol(promote_methods=True)): a `function`
 * with a non-null parent becomes a `method`. A `class` keeps its kind even when
 * nested (only the function kind is promoted).
 */
function _classify(
  node: Node,
  parentName: string | null,
): { name: string; kind: string } | null {
  const baseKind = _DEF_KIND[node.type];
  if (baseKind === undefined) {
    return null;
  }
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) {
    return null;
  }
  const name = nameNode.text;
  if (!name) {
    return null;
  }
  let kind = baseKind;
  if (parentName !== null && kind === "function") {
    kind = "method";
  }
  return { name, kind };
}

const _WALK_CONFIG: WalkConfig = {
  classify: _classify,
  bodyOf: _bodyOf,
};

// ===========================================================================
// extract
// ===========================================================================

/**
 * Extract symbols, refs, and imports from a Python source file.
 *
 * Mirrors python.py extract: structure walk (functions/classes/methods) +
 * per-name import expansion + call-site refs + the decorator start-line
 * post-pass. Sections are always empty for Python. Returns the synchronous
 * extractor's 4-tuple. `parser` must be a Parser already bound to the python
 * grammar (built once by getExtractor).
 */
function _extract(
  parser: Awaited<ReturnType<typeof getParser>>,
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const handle = parseToTree(source, parser);
  if (handle === null) {
    _LOG.debug("python: parse failed for %s — no symbols", rel_path);
    return [[], [], [], []];
  }

  const symbols: Symbol[] = [];
  const seen_names: Set<string> = new Set();

  // --- structure pass (functions / classes / methods) ---
  walkStructure(handle.root, handle.text, symbols, seen_names, _WALK_CONFIG);
  // NOTE: the engine's SymbolInfo pass re-emits the same def/class records,
  // which dedup on (name, line) against the structure pass and add nothing for
  // Python (module-level assignments are not surfaced). So there is no separate
  // symbol-info pass here — the structure walk is complete.

  // --- imports: one ImpExp per expanded name, in document order ---
  const imp_exp: ImpExp[] = [];
  walkImports(handle.root, _IMPORT_TYPES, (node) => {
    const line = node.startPosition.row + 1;
    for (const target of _parse_import_source(node.text)) {
      if (target) {
        imp_exp.push(new ImpExp({ kind: "import", target, line }));
      }
    }
  });

  // --- refs: call-site regex minus _CALL_NOISE ---
  const refs: Ref[] = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);

  // --- post-pass: extend start_line over preceding decorator lines ---
  _extend_starts_for_decorators(symbols, source);

  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the Python extractor.
 *
 * Awaits Parser.init() + the python grammar load (via ts_engine.getParser),
 * then returns a SYNCHRONOUS extract(source, rel) closure that parses + walks
 * the AST. get_extractor (parser.ts) awaits this; index_file stays synchronous
 * thereafter.
 */
export async function getExtractor(): Promise<Extractor> {
  const parser = await getParser("python");
  return (source: Buffer, rel_path: string) => _extract(parser, source, rel_path);
}
