/**
 * Ruby symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/ruby.py. Strict NodeNext ESM.
 *
 * -----
 * What the Python engine does, and how this reproduces it
 * -----
 * ruby.py runs two passes and merges them:
 *
 *  1. common.collect_symbols_and_refs("ruby", …, promote_methods=True) — the
 *     OPAQUE Rust processor's structure/symbol/import passes. Empirically (probed
 *     against the oracle) the Ruby processor emits ONLY `class` nodes as Structure
 *     items (kind Class). It does NOT surface modules, methods, singleton methods,
 *     constants, attr accessors, Struct.new assignments, or imports — those are
 *     all left to the regex pass below. The processor descends transparently
 *     through `module` / `singleton_class` / `method` bodies WITHOUT changing the
 *     parent, so a class's parent_name is its nearest ENCLOSING CLASS (a class
 *     directly inside `module Outer` has parent_name = null). `class << self`
 *     (singleton_class) has no `name` field and is skipped. The class signature is
 *     source[class_start : body_start] trimmed/<=200cp (e.g. "class Dog < Animal");
 *     a class with no body (`class Cat\nend`) has signature null. promote_methods
 *     never affects a class (only the "function" kind is promoted), so it is a
 *     no-op here but kept for faithful parity with the Python call.
 *
 *  2. _extract_extras — a line-by-line regex pass adding modules (as const),
 *     classes (deduped against pass 1), Struct.new assignments (as type), `def`
 *     methods (method when inside a class/module context, else function),
 *     ALL-CAPS constants (const), and attr_accessor/reader/writer members (var).
 *     Every extras symbol has end_line == line and a <=200cp signature, via
 *     common.make_add_fn. Dedup is on (name, line) shared with pass 1.
 *
 * Then `require` / `require_relative` lines become ImpExp import rows. Sections
 * are always empty for Ruby.
 *
 * The structure pass is reproduced by walking the raw web-tree-sitter AST
 * (ts_engine.walkStructure with a class-only classify); pass 2 and the imports
 * reuse the UNCHANGED common.ts helpers (make_add_fn) so the Ruby-specific
 * behaviour is shared bit-for-bit with the oracle's intent.
 */

import type { Node } from "web-tree-sitter";

import type { Extractor, Ref, Section, Symbol } from "../parser.js";
import { ImpExp } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";
import {
  getParser,
  parseToTree,
  walkStructure,
  type WalkConfig,
} from "./ts_engine.js";

const _LOG = getLogger("languages.ruby");

// ===========================================================================
// Call-site ref noise filter — port of ruby.py _CALL_NOISE
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "if", "unless", "while", "until", "for", "case", "when", "then",
  "do", "begin", "rescue", "ensure", "raise", "return", "break", "next", "retry",
  "yield", "super", "self", "nil", "true", "false",
  "puts", "print", "p", "pp", "require", "require_relative", "include", "extend",
  "attr_reader", "attr_writer", "attr_accessor", "private", "protected", "public",
  "new", "class", "module", "def", "end", "and", "or", "not",
  "Integer", "String", "Array", "Hash", "Symbol", "Float", "Numeric",
  "Object", "Class", "Module", "Kernel",
  "map", "each", "select", "reject", "find", "inject", "reduce",
  "push", "pop", "shift", "unshift", "first", "last", "length", "size",
  "empty", "any", "all", "none", "count",
  "to_s", "to_i", "to_f", "to_a", "to_h", "inspect",
]);

// ===========================================================================
// Regex tables for the _extract_extras pass (port of ruby.py module constants)
// ===========================================================================

// module/class/struct declaration
const _MODULE_RE = /^module\s+([A-Za-z_][A-Za-z0-9_:]*)/;
const _CLASS_RE = /^class\s+([A-Za-z_][A-Za-z0-9_:]*)(?:\s*<\s*[A-Za-z_][A-Za-z0-9_:]*)?/;
const _STRUCT_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Struct\.new\b/;

// method declaration: def name or def self.name
const _DEF_RE = /^(\s*)def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)\s*(?:\(|$)/;

// constant (all-caps identifier at start of line or after module depth). The
// negative lookahead `(?!=)` mirrors Python's `=(?!=)` — a single `=` not part
// of `==`.
const _CONST_RE = /^(?:\s+)?([A-Z][A-Z0-9_]{2,})\s*=(?!=)/;

// require/require_relative
const _REQUIRE_RE = /^require(?:_relative)?\s+['"]([^'"]+)['"]/;

// attr_accessor/reader/writer: attr_accessor :name, :other
const _ATTR_RE = /^\s+attr_(?:accessor|reader|writer)\s+(.+)$/;
const _SYMBOL_RE = /:([A-Za-z_][A-Za-z0-9_?!]*)/g;

// ===========================================================================
// String helpers (Python parity)
// ===========================================================================

/**
 * Reproduce Python str.splitlines() for the `\n`/`\r` cases the regex pass
 * feeds it: split on \r\n, \r, \n and drop the trailing empty element that a
 * final newline would otherwise produce. The extras pass decodes raw bytes and
 * iterates lines 1-based, so a trailing "" must not be yielded as an extra line.
 */
function _splitlines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python str.lstrip() — strip leading whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/u, "");
}

/** Take the first `n` CODE POINTS of `s` (Python `s[:n]` semantics). */
function _sliceCodepoints(s: string, n: number): string {
  if (n <= 0) {
    return "";
  }
  let out = "";
  let count = 0;
  for (const ch of s) {
    if (count >= n) {
      break;
    }
    out += ch;
    count += 1;
  }
  return out;
}

/** Last "::"-separated segment (Python `s.split("::")[-1]`). */
function _lastNamespaceSegment(s: string): string {
  const idx = s.lastIndexOf("::");
  return idx === -1 ? s : s.slice(idx + 2);
}

// ===========================================================================
// Structure-walk configuration (class-only)
// ===========================================================================

/** Return the body block of a class definition (field "body"), or null. */
function _bodyOf(node: Node): Node | null {
  return node.childForFieldName("body");
}

/**
 * Classify a node as a Ruby `class` declaration. Returns null for every other
 * node type so the walk recurses with the SAME parent — reproducing the Rust
 * processor's transparent descent through module / singleton_class / method
 * bodies (which never change the class parent chain). The kind is always
 * "class"; promote_methods is a no-op for classes.
 *
 * `singleton_class` (`class << self`) has no `name` field — classify returns
 * null and the walk descends transparently, matching the oracle (the engine
 * emits a Class node with name None, which make_add_symbol drops).
 */
function _classify(
  node: Node,
  _parentName: string | null,
): { name: string; kind: string } | null {
  if (node.type !== "class") {
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
  return { name, kind: "class" };
}

const _WALK_CONFIG: WalkConfig = {
  classify: _classify,
  bodyOf: _bodyOf,
};

// ===========================================================================
// _extract_extras — line-by-line regex pass (port of ruby.py)
// ===========================================================================

/**
 * Run the secondary regex pass over the raw source, appending Ruby symbols not
 * surfaced by the tree-sitter structure pass (modules, methods, constants,
 * attr_* members, Struct.new assignments, and any class the structure pass
 * missed). Deduped against `seen_names` (shared with the structure pass) via
 * common.make_add_fn. Returns the freshly-collected extras list.
 *
 * Faithful port of ruby.py _extract_extras / _extract_extras_inner, wrapped in
 * common.safe_regex_parse so a malformed pattern never aborts extraction.
 */
function _extract_extras(source: Buffer, seen_names: Set<string>): Symbol[] {
  return common.safe_regex_parse<Symbol[]>(
    (...args: unknown[]) =>
      _extract_extras_inner(args[0] as Buffer, args[1] as Set<string>),
    [source, seen_names],
    { log: _LOG, label: "_extract_extras", empty: [] },
  );
}

function _extract_extras_inner(source: Buffer, seen_names: Set<string>): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);

  // context stack: list of (name, indent_level) pairs
  const context_stack: Array<[string, number]> = [];

  const current_class = (): string | null => {
    // Python iterates reversed and returns the first entry (i.e. the top of
    // the stack).
    if (context_stack.length > 0) {
      return (context_stack[context_stack.length - 1] as [string, number])[0];
    }
    return null;
  };

  const add = common.make_add_fn(symbols, seen_names);

  for (let i0 = 0; i0 < lines.length; i0++) {
    const i = i0 + 1; // 1-based line number
    const raw_line = lines[i0] as string;
    const line = _rstrip(raw_line);
    const stripped = _lstrip(line);
    if (!stripped || stripped.startsWith("#")) {
      continue;
    }

    const indent = raw_line.length - _lstrip(raw_line).length;

    // pop context when we're back to or above the class/module level
    while (
      context_stack.length > 0 &&
      indent <= (context_stack[context_stack.length - 1] as [string, number])[1] &&
      stripped === "end"
    ) {
      context_stack.pop();
    }

    // module
    const mod_m = _MODULE_RE.exec(stripped);
    if (mod_m !== null) {
      const name = _lastNamespaceSegment(mod_m[1] as string);
      add(name, "const", i, _sliceCodepoints(stripped, 200));
      context_stack.push([name, indent]);
      continue;
    }

    // class
    const cls_m = _CLASS_RE.exec(stripped);
    if (cls_m !== null) {
      const name = _lastNamespaceSegment(cls_m[1] as string);
      add(name, "class", i, _sliceCodepoints(stripped, 200));
      context_stack.push([name, indent]);
      continue;
    }

    // Struct.new assignment
    const st_m = _STRUCT_RE.exec(line);
    if (st_m !== null) {
      add(st_m[1] as string, "type", i, _sliceCodepoints(stripped, 200));
      continue;
    }

    // method
    const def_m = _DEF_RE.exec(raw_line);
    if (def_m !== null) {
      const name = def_m[2] as string;
      const sig_end = stripped.indexOf(")");
      const sig = sig_end >= 0 ? stripped.slice(0, sig_end + 1) : stripped;
      const parent = current_class();
      const kind = parent ? "method" : "function";
      add(name, kind, i, _sliceCodepoints(sig, 200), parent);
      continue;
    }

    // constant
    const const_m = _CONST_RE.exec(line);
    if (const_m !== null) {
      const name = const_m[1] as string;
      if (!_CALL_NOISE.has(name)) {
        add(name, "const", i, _sliceCodepoints(stripped, 200), current_class());
      }
      continue;
    }

    // attr_accessor/reader/writer — emit as property (var) symbols
    const attr_m = _ATTR_RE.exec(line);
    if (attr_m !== null) {
      const parent = current_class();
      const body = attr_m[1] as string;
      _SYMBOL_RE.lastIndex = 0;
      let sym_m: RegExpExecArray | null;
      while ((sym_m = _SYMBOL_RE.exec(body)) !== null) {
        if (sym_m.index === _SYMBOL_RE.lastIndex) {
          _SYMBOL_RE.lastIndex += 1;
        }
        const attr_name = sym_m[1] as string;
        add(attr_name, "var", i, null, parent);
      }
    }
  }

  return symbols;
}

// ===========================================================================
// extract
// ===========================================================================

/**
 * Extract symbols, refs, and imports from a Ruby source file.
 *
 * Mirrors ruby.py extract: the class-only structure walk + the regex extras
 * pass (merged via shared dedup) + call-site refs + require/require_relative
 * imports. Sections are always empty for Ruby. `parser` must be a Parser already
 * bound to the ruby grammar (built once by getExtractor).
 */
function _extract(
  parser: Awaited<ReturnType<typeof getParser>>,
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const handle = parseToTree(source, parser);
  if (handle === null) {
    _LOG.debug("ruby: parse failed for %s — no symbols", rel_path);
    return [[], [], [], []];
  }

  const symbols: Symbol[] = [];
  const seen_names: Set<string> = new Set();

  // --- pass 1: structure walk (classes only) ---
  walkStructure(handle.root, handle.text, symbols, seen_names, _WALK_CONFIG);

  // --- refs: call-site regex minus _CALL_NOISE ---
  const refs: Ref[] = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);

  // --- pass 2: regex extras (modules/methods/consts/attrs/structs/classes) ---
  for (const extra of _extract_extras(source, seen_names)) {
    symbols.push(extra);
  }

  // --- imports: require / require_relative ---
  const imp_exp: ImpExp[] = [];
  const text = source.toString("utf-8");
  const importLines = _splitlines(text);
  for (let i0 = 0; i0 < importLines.length; i0++) {
    const i = i0 + 1;
    const m = _REQUIRE_RE.exec((importLines[i0] as string).trim());
    if (m !== null) {
      imp_exp.push(new ImpExp({ kind: "import", target: m[1] as string, line: i }));
    }
  }

  _LOG.debug(
    "ruby extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );
  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the Ruby extractor.
 *
 * Awaits Parser.init() + the ruby grammar load (via ts_engine.getParser), then
 * returns a SYNCHRONOUS extract(source, rel) closure. get_extractor (parser.ts)
 * awaits this; index_file stays synchronous thereafter.
 */
export async function getExtractor(): Promise<Extractor> {
  const parser = await getParser("ruby");
  return (source: Buffer, rel_path: string) => _extract(parser, source, rel_path);
}
