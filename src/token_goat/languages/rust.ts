/**
 * Rust symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/rust.py. Strict NodeNext ESM.
 *
 * -----
 * What the Python engine does, and how this reproduces it
 * -----
 * rust.py calls common.collect_symbols_and_refs("rust", …, promote_methods=True),
 * which runs the OPAQUE Rust processor (tree_sitter_language_pack.process). For
 * Rust the processor's STRUCTURE pass emits a StructureItem per
 * struct/enum/trait/mod/fn/impl; its SYMBOL pass (SymbolInfo) re-emits those AND
 * additionally surfaces top-level `const`/`type` declarations (deduped on
 * (name, line) against the structure pass — so it adds ONLY const/type items at
 * any nesting depth, always with parent_name = null). rust.py then:
 *   1. expands each `use …;` import `.source` via _parse_use_target,
 *   2. adds trait-method SIGNATURES via a secondary regex pass (the bodyless
 *      `fn name(…);` inside a `trait { … }` — the processor does not surface
 *      these individually),
 *   3. adds `static [mut] NAME: …` declarations via a third regex pass (the
 *      processor surfaces neither static_item in structure nor symbol passes),
 *   4. extracts call-site refs by regex (common.CALL_RE) minus _CALL_NOISE.
 *
 * This adapter reproduces the structure + symbol-info + import passes by walking
 * the raw web-tree-sitter AST (ts_engine.walkStructure for structure, a local
 * symbol-info walk for const/type, walkImports for `use`), then reuses the
 * UNCHANGED common.ts helpers for refs, the trait-method regex pass, and the
 * statics regex pass — so the Rust-specific behaviour is shared bit-for-bit with
 * the oracle's intent.
 *
 * Structure-walk fidelity (verified against the oracle):
 *  - struct_item -> "type"; enum_item -> "enum"; trait_item -> "interface";
 *    mod_item -> "module"; function_item -> "function"; impl_item -> "impl".
 *    (union_item, const_item, static_item, type_item are NOT in the structure
 *    pass; function_signature_item — the bodyless trait `fn …;` — is NOT either,
 *    it is handled by the trait-method regex pass.)
 *  - A function nested inside ANOTHER declaration is promoted to "method"
 *    (promote_methods: function with non-null parent -> method); every other
 *    kind keeps its kind even when nested (only function is promoted).
 *  - The processor descends through any container WITHOUT changing the parent
 *    and sets a new parent only when crossing a declaration boundary.
 *  - impl naming: name = simple-identifier of the `trait` field if it resolves
 *    to a plain type_identifier, else the simple-identifier of the `type` field;
 *    a generic_type / scoped_type_identifier / reference_type does NOT yield a
 *    name, so e.g. `impl std::fmt::Display for Wrapper<i32>` is NOT surfaced and
 *    its methods are treated as top-level functions (parent_name = null).
 *  - signature = source[item_start : body_block_start], trimmed, <= 200 cp; a
 *    bodyless declaration (e.g. `struct D;`) yields signature null.
 *
 * Symbol-info walk fidelity (verified against the oracle):
 *  - emits const_item -> "const" and type_item -> "type", in document order,
 *    AFTER the whole structure pass, deduped on (name, line), always with
 *    signature null / parent_name null. associated_type (the bodyless `type X;`
 *    inside a trait) is NOT a type_item and is NOT emitted.
 */

import type { Node } from "web-tree-sitter";

import type { Extractor, Ref, Section, Symbol } from "../parser.js";
import { ImpExp, Symbol as SymbolCls } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";
import {
  getParser,
  lineOf,
  endLineOf,
  parseToTree,
  walkImports,
  walkStructure,
  build_signature_str,
  symbolKey,
  type WalkConfig,
} from "./ts_engine.js";

const _LOG = getLogger("languages.rust");

// ===========================================================================
// Rust-specific node-type tables
// ===========================================================================

/** Structure-pass declaration node types and their base kind. */
const _DEF_KIND: Record<string, string> = {
  struct_item: "type",
  enum_item: "enum",
  trait_item: "interface",
  mod_item: "module",
  function_item: "function",
  // impl_item handled specially (name resolution below).
};

/** Symbol-info-pass node types and their kind (added after the structure pass). */
const _SYMBOL_INFO_KIND: Record<string, string> = {
  const_item: "const",
  type_item: "type",
};

/** Import statement node types (full-statement `.source` analogue). */
const _IMPORT_TYPES: ReadonlySet<string> = new Set(["use_declaration"]);

// ---------------------------------------------------------------------------
// Noise filter for call-site refs — port of rust.py _CALL_NOISE
// ---------------------------------------------------------------------------

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "println", "print", "eprintln", "eprint", "format", "write", "writeln",
  "vec", "Vec", "String", "Some", "None", "Ok", "Err", "Box", "Arc", "Rc",
  "Option", "Result",
  "if", "for", "while", "loop", "match", "let", "fn", "mut", "impl", "trait",
  "return", "break", "continue", "self", "Self", "super", "crate",
  "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize",
  "f32", "f64", "bool", "char", "str",
]);

// ---------------------------------------------------------------------------
// `use …;` import target — port of rust.py _parse_use_target / _USE_PATH_RE
// ---------------------------------------------------------------------------

// Regex to extract target path from a `use ...;` line. NON-multiline so `^`
// anchors at string start (mirrors Python re.match). Captures everything up to
// the first `;` or `{`.
const _USE_PATH_RE = /^use\s+([^;{]+)/;

/** Python str.rstrip(";") — strip trailing `;` runs. */
function _rstripSemicolons(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ";") {
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * Return the import target from one `use …;` statement source line.
 *
 * Faithful port of rust.py _parse_use_target:
 *  - `use foo::bar::Baz;` -> "foo::bar::Baz"
 *  - `use a::b::{c, d};`  -> "a::b::" (stops at the `{`)
 *  - `pub use std::fmt;`  -> the raw stripped line (the `^use` anchor fails)
 */
function _parse_use_target(source_line: string): string {
  const line = source_line.trim();
  const m = _USE_PATH_RE.exec(line);
  if (m !== null) {
    return _rstripSemicolons((m[1] as string).trim()).trim();
  }
  return line;
}

// ---------------------------------------------------------------------------
// Trait method signatures — port of rust.py _extract_trait_methods
// ---------------------------------------------------------------------------

// Trait block header: `pub trait Foo {` or `trait Foo<T> {`
const _TRAIT_HEADER_RE = /^(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/;

// Trait method signature line: `fn method_name(` — may be indented, may have
// modifiers. Group 1 is the name, group 2 is the `(…)` tail.
const _TRAIT_METHOD_RE =
  /^\s+(?:(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(\(.*)/;

/** Python str.splitlines() for `\n` text (drops a single trailing ""). */
function _splitlines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Count occurrences of `ch` in `s` (Python str.count). */
function _count(s: string, ch: string): number {
  let n = 0;
  let i = s.indexOf(ch);
  while (i !== -1) {
    n += 1;
    i = s.indexOf(ch, i + 1);
  }
  return n;
}

/** Take the first 200 CODE POINTS of `s` (Python `s[:200]` semantics). */
function _slice200(s: string): string {
  let out = "";
  let count = 0;
  for (const c of s) {
    if (count >= 200) {
      break;
    }
    out += c;
    count += 1;
  }
  return out;
}

function _extract_trait_methods_inner(source: Buffer): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const headerLine = lines[i] as string;
    const m = _matchStart(_TRAIT_HEADER_RE, headerLine);
    if (m !== null) {
      const trait_name = m[1] as string;
      let depth = _count(headerLine, "{") - _count(headerLine, "}");
      let j = i + 1;
      while (j < n && depth > 0) {
        const line = lines[j] as string;
        depth += _count(line, "{") - _count(line, "}");
        if (depth > 0) {
          const mm = _matchStart(_TRAIT_METHOD_RE, line);
          if (mm !== null) {
            const method_name = mm[1] as string;
            const sig_tail = (mm[2] as string).trim();
            const sig_text = sig_tail.startsWith("(")
              ? _slice200(`fn ${method_name}(${sig_tail.slice(1)}`)
              : null;
            symbols.push(
              new SymbolCls({
                name: method_name,
                kind: "method",
                line: j + 1,
                end_line: j + 1,
                signature: sig_text,
                parent_name: trait_name,
              }),
            );
          }
        }
        j += 1;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return symbols;
}

function _extract_trait_methods(source: Buffer): Symbol[] {
  return common.safe_regex_parse<Symbol[]>(
    (s) => _extract_trait_methods_inner(s as Buffer),
    [source],
    { log: _LOG, label: "_extract_trait_methods", empty: [] },
  );
}

// ---------------------------------------------------------------------------
// Static declarations — port of rust.py _extract_statics / _STATIC_RE
// ---------------------------------------------------------------------------

// Top-level static declaration: `pub static [mut] NAME: ...` or `static [mut] NAME: ...`
const _STATIC_RE =
  /^(?:pub(?:\s*\([^)]*\))?\s+)?static\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/;

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

function _extract_statics_inner(source: Buffer): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] as string;
    // line.startswith((" ", "\t")) — skip indented (non-top-level) lines.
    if (line.startsWith(" ") || line.startsWith("\t")) {
      continue;
    }
    const m = _matchStart(_STATIC_RE, line);
    if (m !== null) {
      symbols.push(
        new SymbolCls({
          name: m[1] as string,
          kind: "const",
          line: idx + 1,
          end_line: idx + 1,
          signature: _slice200(_rstrip(line)),
        }),
      );
    }
  }
  return symbols;
}

function _extract_statics(source: Buffer): Symbol[] {
  return common.safe_regex_parse<Symbol[]>(
    (s) => _extract_statics_inner(s as Buffer),
    [source],
    { log: _LOG, label: "_extract_statics", empty: [] },
  );
}

/**
 * Reproduce Python `re.Pattern.match(s)` (anchored at string start) for a
 * pattern that already begins with `^`. JS `.exec` is unanchored, so we use a
 * fresh non-global exec — the leading `^` confines the match to position 0.
 */
function _matchStart(pattern: RegExp, s: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(s);
}

// ===========================================================================
// Structure-walk configuration
// ===========================================================================

/**
 * Return the simple identifier name of a type-position node, or null when it is
 * not a plain identifier (generic_type / scoped_type_identifier / reference_type
 * etc.). Used for impl name resolution — only a bare `type_identifier` yields a
 * usable name (verified against the oracle).
 */
function _simpleTypeName(node: Node | null): string | null {
  if (node === null) {
    return null;
  }
  if (node.type === "type_identifier") {
    const t = node.text;
    return t ? t : null;
  }
  return null;
}

/**
 * Resolve the emitted name for an impl_item: the `trait` field's simple name if
 * present, else the `type` field's simple name; null when neither resolves to a
 * plain identifier (then the impl is not surfaced).
 */
function _implName(node: Node): string | null {
  const traitName = _simpleTypeName(node.childForFieldName("trait"));
  if (traitName !== null) {
    return traitName;
  }
  return _simpleTypeName(node.childForFieldName("type"));
}

/**
 * Return the body block of a declaration (field "body"), or null. The signature
 * is sliced from the declaration start to this node's start.
 */
function _bodyOf(node: Node): Node | null {
  return node.childForFieldName("body");
}

/**
 * Classify a node as a Rust structure-pass declaration, applying the
 * function->method promotion. Returns null for any non-declaration node (the
 * walk then recurses with the same parent — the container pass-through).
 */
function _classify(
  node: Node,
  parentName: string | null,
): { name: string; kind: string } | null {
  if (node.type === "impl_item") {
    const name = _implName(node);
    if (name === null) {
      return null;
    }
    return { name, kind: "impl" };
  }
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
// Symbol-info walk (const_item / type_item, document order, parent null)
// ===========================================================================

/**
 * Walk the whole tree in document order, appending a Symbol per const_item /
 * type_item not already in `seenNames`. Reproduces the engine's SymbolInfo pass
 * for Rust (which surfaces ONLY const/type beyond the structure pass), with
 * signature null and parent_name null at any nesting depth.
 */
function _walkSymbolInfo(
  root: Node,
  symbols: Symbol[],
  seenNames: Set<string>,
): void {
  const visit = (node: Node): void => {
    const kind = _SYMBOL_INFO_KIND[node.type];
    if (kind !== undefined) {
      const nameNode = node.childForFieldName("name");
      const name = nameNode !== null ? nameNode.text : "";
      if (name) {
        const line = lineOf(node);
        const key = symbolKey(name, line);
        if (!seenNames.has(key)) {
          seenNames.add(key);
          symbols.push(
            new SymbolCls({
              name,
              kind,
              line,
              end_line: endLineOf(node),
              signature: null,
              parent_name: null,
            }),
          );
        }
      }
    }
    for (const c of node.namedChildren) {
      if (c !== null) {
        visit(c);
      }
    }
  };
  visit(root);
}

// ===========================================================================
// extract
// ===========================================================================

/**
 * Extract symbols, refs, and imports from a Rust source file.
 *
 * Mirrors rust.py extract: structure walk + symbol-info (const/type) walk +
 * `use` import expansion + trait-method regex pass + statics regex pass +
 * call-site refs. Sections are always empty for Rust.
 */
function _extract(
  parser: Awaited<ReturnType<typeof getParser>>,
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const handle = parseToTree(source, parser);
  if (handle === null) {
    _LOG.debug("rust: parse failed for %s — no symbols", rel_path);
    return [[], [], [], []];
  }

  const symbols: Symbol[] = [];
  const seen_names: Set<string> = new Set();

  // --- structure pass (struct/enum/trait/mod/fn/impl) ---
  walkStructure(handle.root, handle.text, symbols, seen_names, _WALK_CONFIG);

  // --- symbol-info pass (const/type, document order, dedup on (name, line)) ---
  _walkSymbolInfo(handle.root, symbols, seen_names);

  // --- imports: one ImpExp per `use …;` declaration, in document order ---
  const imp_exp: ImpExp[] = [];
  walkImports(handle.root, _IMPORT_TYPES, (node) => {
    const line = node.startPosition.row + 1;
    const target = _parse_use_target(node.text);
    if (target) {
      imp_exp.push(new ImpExp({ kind: "import", target, line }));
    }
  });

  // --- refs: call-site regex minus _CALL_NOISE ---
  const refs: Ref[] = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);

  // --- trait method signatures (tree-sitter doesn't surface these) ---
  common.merge_extra_symbols(symbols, seen_names, _extract_trait_methods(source));

  // --- static declarations (tree-sitter misses `static [mut] NAME: ...`) ---
  common.merge_extra_symbols(symbols, seen_names, _extract_statics(source));

  _LOG.debug(
    "rust extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );

  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the Rust extractor.
 *
 * Awaits Parser.init() + the rust grammar load (via ts_engine.getParser), then
 * returns a SYNCHRONOUS extract(source, rel) closure that parses + walks the
 * AST. get_extractor (parser.ts) awaits this; index_file stays synchronous
 * thereafter.
 */
export async function getExtractor(): Promise<Extractor> {
  const parser = await getParser("rust");
  return (source: Buffer, rel_path: string) => _extract(parser, source, rel_path);
}
