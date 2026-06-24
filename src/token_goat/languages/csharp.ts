/**
 * C# symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/csharp.py. Strict NodeNext ESM.
 *
 * -----
 * What the Python engine does, and how this reproduces it
 * -----
 * csharp.py calls common.collect_symbols_and_refs("csharp", …, promote_methods=
 * True), which runs the OPAQUE Rust processor (tree_sitter_language_pack.process).
 * For C# the processor's structure pass emits a StructureItem per
 * class / interface / struct / enum / method declaration (records, delegates,
 * namespaces, constructors, properties and fields are NOT surfaced); its
 * SymbolInfo pass re-emits the same records (deduped on (name, line) — adds
 * nothing new). csharp.py then:
 *   1. computes the set of class/enum/interface/type names,
 *   2. runs a SECONDARY regex scan (_extract_extras) that adds namespaces (kind
 *      "const"), delegates (kind "interface"), and — inside a recognised class,
 *      tracked by brace depth — constructors (kind "method") and properties
 *      (kind "var"); merged with dedup on (name, line),
 *   3. adds one ImpExp per `using …;` directive (NOT `global using`, NOT alias
 *      `using X = …`).
 *
 * This adapter reproduces the structure pass by walking the raw web-tree-sitter
 * AST (ts_engine.walkStructure with a C#-specific classify/bodyOf), then ports
 * the _extract_extras regex scan and the using loop line-for-line, reusing the
 * UNCHANGED common.ts helpers (merge_extra_symbols, safe_regex_parse, refs).
 *
 * Structure-walk fidelity (verified against the oracle):
 *  - class_declaration -> "class"; interface_declaration -> "interface";
 *    struct_declaration -> "type"; enum_declaration -> "enum";
 *    method_declaration -> "method".  (Mirrors _BASE_KIND_STR_MAPPING:
 *    Struct->type, the rest direct.)
 *  - record_declaration / delegate_declaration / namespace_declaration /
 *    constructor_declaration / property_declaration / field_declaration are NOT
 *    classified — they are not surfaced by the Rust structure pass.
 *  - Methods are ALWAYS "method" (the Method StructureKind maps directly; the
 *    promote_methods flag is a no-op for C# because methods are never reported
 *    as "function").  parent_name follows the enclosing type chain; a type
 *    nested in a type keeps its own kind with parent set.
 *  - signature = source[decl_start : body_start], trimmed, <= 200 cp, where the
 *    body is the node's "body" field (declaration_list / enum_member_declaration_
 *    list / block / arrow_expression_clause).  An un-bodied method (interface /
 *    abstract method, no block) has body field == null -> signature null.
 */

import type { Node } from "web-tree-sitter";

import type { Extractor, Ref, Section, Symbol as SymbolType } from "../parser.js";
import { ImpExp, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";
import {
  getParser,
  parseToTree,
  walkStructure,
  WASM_GRAMMAR_BY_LANG,
  type WalkConfig,
} from "./ts_engine.js";

const _LOG = getLogger("languages.csharp");

// ===========================================================================
// Call-site ref noise filter (port of csharp.py _CALL_NOISE)
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "if", "for", "foreach", "while", "switch", "catch", "return", "throw", "new",
  "base", "this", "typeof", "sizeof", "default", "is", "as", "in", "out", "ref",
  "break", "continue", "try", "else", "finally", "using", "await", "async",
  "int", "long", "double", "float", "bool", "char", "byte", "short", "void", "string",
  "var", "object", "dynamic", "decimal", "uint", "ulong", "ushort", "sbyte",
  "String", "Object", "Console", "Math", "Task", "List", "Dictionary", "Array",
  "Enumerable", "Linq", "Exception", "Convert", "Type", "Enum", "Nullable",
  "IEnumerable", "IList", "ICollection", "IDictionary",
  "null", "true", "false",
  "ToString", "Equals", "GetHashCode", "GetType",
  "Add", "Remove", "Contains", "Count", "Length", "First", "Last",
  "Where", "Select", "OrderBy", "GroupBy", "Join",
  "WriteLine", "Write", "ReadLine", "Format",
]);

// ===========================================================================
// Regex tables (ported from csharp.py) — Python re.match semantics (anchored
// at string start). JS RegExp.exec on a non-/g pattern with `^` is equivalent.
// ===========================================================================

/** using directive (NOT `global using`, NOT `using X = …`). Tested on raw line. */
const _USING_RE = /^using\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*;/;

/** namespace declaration. Tested on the stripped line. */
const _NAMESPACE_RE = /^(?:namespace\s+)([A-Za-z_][A-Za-z0-9_.]*)/;

/** property: optional modifiers + type + Name + { …get|set… }. Tested on raw line. */
const _PROPERTY_RE =
  /^\s+(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>?,[\]\s]*?)\s+([A-Z][A-Za-z0-9_]*)\s*\{[^}]*(?:get|set)/;

/** delegate declaration. Tested on the stripped line. */
const _DELEGATE_RE =
  /^\s*(?:public|protected|private|internal)?\s*delegate\s+(?:[A-Za-z_][A-Za-z0-9_<>?,[\]\s]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/;

/** constructor: (modifiers)+ ClassName( . Tested on raw line. */
const _CONSTRUCTOR_RE =
  /^\s+(?:(?:public|protected|private|internal|static)\s+)+([A-Z][A-Za-z0-9_]*)\s*\(/;

/** class/struct/interface/enum header. Tested on the stripped line. */
const _CLASS_HEADER_RE =
  /^(?:(?:public|protected|private|internal|abstract|sealed|static|partial)\s+)*(?:class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;

// ===========================================================================
// Python string helpers (str.strip / str.rstrip / str.splitlines / s[:n])
// ===========================================================================

/** Codepoints Python str.strip() removes by default (str.isspace()). */
const _PY_WS: ReadonlySet<number> = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python str.strip() with the default whitespace class. */
function _pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && _PY_WS.has(s.codePointAt(start) as number)) {
    start += 1;
  }
  while (end > start && _PY_WS.has(s.codePointAt(end - 1) as number)) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Python str.rstrip() with the default whitespace class. */
function _pyRStrip(s: string): string {
  let end = s.length;
  while (end > 0 && _PY_WS.has(s.codePointAt(end - 1) as number)) {
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * Reproduce Python str.splitlines() (no keepends): split on the full Python
 * line-boundary set, yielding no empty trailing element after a final separator.
 */
function _pySplitlines(text: string): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp === 0x0d) {
      lines.push(cur);
      cur = "";
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) {
        i += 1;
      }
      continue;
    }
    if (
      cp === 0x0a || cp === 0x0b || cp === 0x0c ||
      cp === 0x1c || cp === 0x1d || cp === 0x1e ||
      cp === 0x85 || cp === 0x2028 || cp === 0x2029
    ) {
      lines.push(cur);
      cur = "";
      continue;
    }
    cur += text[i];
  }
  if (cur !== "") {
    lines.push(cur);
  }
  return lines;
}

/**
 * Python `s[:200]`. The captured names / single-line headers fed here are ASCII
 * identifiers and short header lines well under 200 chars, so a UTF-16 slice is
 * identical to a code-point slice in practice.
 */
function _slice200(s: string): string {
  return s.slice(0, 200);
}

/** Count occurrences of a single character in a string (Python str.count). */
function _count(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) {
      n += 1;
    }
  }
  return n;
}

// ===========================================================================
// Secondary regex scan — port of csharp.py _extract_extras_inner
// ===========================================================================

/**
 * Faithful port of csharp.py _extract_extras_inner.
 *
 * Scans every line and emits:
 *  - namespaces (kind "const", signature = stripped line, end_line = line);
 *  - delegates (kind "interface", signature = stripped line);
 *  - constructors and properties, but ONLY while inside a class whose name is in
 *    `class_names`, tracked by brace depth (depth_in_class == 1), with the
 *    constructor signature taken from the RAW line up to the first "{" (rstrip,
 *    leading whitespace preserved) and the property signature from the stripped
 *    line.
 *
 * Note the gating quirks reproduced bit-for-bit: only the FIRST matching class
 * becomes `current_class` (a later class header is ignored until braces close),
 * and the constructor/property regexes are matched against the RAW line.
 */
function _extract_extras_inner(source: Buffer, class_names: ReadonlySet<string>): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _pySplitlines(text);

  let current_class: string | null = null;
  let brace_depth = 0;
  let class_start_depth = 0;

  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const i = idx0 + 1; // 1-based (Python enumerate(..., 1))
    const line = lines[idx0] as string;
    const stripped = _pyStrip(line);

    // namespace
    const ns_m = _NAMESPACE_RE.exec(stripped);
    if (ns_m !== null) {
      symbols.push(new Symbol({
        name: ns_m[1] as string,
        kind: "const",
        line: i,
        end_line: i,
        signature: _slice200(stripped),
      }));
    }

    // delegate
    const del_m = _DELEGATE_RE.exec(stripped);
    if (del_m !== null) {
      symbols.push(new Symbol({
        name: del_m[1] as string,
        kind: "interface",
        line: i,
        end_line: i,
        signature: _slice200(stripped),
      }));
    }

    // track class context for constructor/property detection
    const cm = _CLASS_HEADER_RE.exec(stripped);
    if (cm !== null) {
      const cname = cm[1] as string;
      if (class_names.has(cname) && current_class === null) {
        current_class = cname;
        class_start_depth = brace_depth;
      }
    }

    if (current_class !== null) {
      const depth_in_class = brace_depth - class_start_depth;
      if (depth_in_class === 1) {
        // constructor (matched against the RAW line)
        const ctor_m = _CONSTRUCTOR_RE.exec(line);
        if (ctor_m !== null && ctor_m[1] === current_class) {
          const sig_end = line.indexOf("{");
          const sig = sig_end >= 0 ? _pyRStrip(line.slice(0, sig_end)) : _pyRStrip(line);
          symbols.push(new Symbol({
            name: current_class,
            kind: "method",
            line: i,
            end_line: i,
            signature: sig ? _slice200(sig) : null,
            parent_name: current_class,
          }));
        }
        // property (matched against the RAW line)
        const prop_m = _PROPERTY_RE.exec(line);
        if (prop_m !== null) {
          symbols.push(new Symbol({
            name: prop_m[1] as string,
            kind: "var",
            line: i,
            end_line: i,
            signature: _slice200(stripped),
            parent_name: current_class,
          }));
        }
      }
    }

    brace_depth += _count(line, "{") - _count(line, "}");
    if (current_class !== null && brace_depth <= class_start_depth) {
      current_class = null;
    }
  }

  return symbols;
}

/** safe_regex_parse wrapper, mirroring csharp.py _extract_extras. */
function _extract_extras(source: Buffer, class_names: ReadonlySet<string>): Symbol[] {
  return common.safe_regex_parse(
    (...args: unknown[]) =>
      _extract_extras_inner(args[0] as Buffer, args[1] as ReadonlySet<string>),
    [source, class_names],
    { log: _LOG, label: "_extract_extras", empty: [] as Symbol[] },
  );
}

// ===========================================================================
// Structure-walk configuration
// ===========================================================================

/** Declaration node types -> emitted kind (mirrors _BASE_KIND_STR_MAPPING). */
const _DECL_KIND: Record<string, string> = {
  class_declaration: "class",
  interface_declaration: "interface",
  struct_declaration: "type",
  enum_declaration: "enum",
  method_declaration: "method",
};

/** Body node ends the signature span (field "body"), or null when un-bodied. */
function _bodyOf(node: Node): Node | null {
  return node.childForFieldName("body");
}

/**
 * Classify a node as a C# declaration. Returns null for any node not in
 * {@link _DECL_KIND} (records / delegates / namespaces / constructors /
 * properties / fields are not surfaced by the Rust structure pass).
 *
 * The kind is fixed by node type (methods are always "method"); the
 * function->method promotion is a no-op here because no C# declaration maps to
 * "function".
 */
function _classify(
  node: Node,
  _parentName: string | null,
): { name: string; kind: string } | null {
  const kind = _DECL_KIND[node.type];
  if (kind === undefined) {
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
  return { name, kind };
}

const _WALK_CONFIG: WalkConfig = {
  classify: _classify,
  bodyOf: _bodyOf,
};

// ===========================================================================
// extract
// ===========================================================================

/** Kinds that contribute names to the `class_names` set (csharp.py). */
const _CLASS_NAME_KINDS: ReadonlySet<string> = new Set([
  "class", "enum", "interface", "type",
]);

function _extract(
  parser: Awaited<ReturnType<typeof getParser>>,
  source: Buffer,
  rel_path: string,
): [SymbolType[], Ref[], ImpExp[], Section[]] {
  const handle = parseToTree(source, parser);
  if (handle === null) {
    _LOG.debug("csharp: parse failed for %s — no symbols", rel_path);
    return [[], [], [], []];
  }

  const symbols: Symbol[] = [];
  const seen_names: Set<string> = new Set();

  // --- structure pass (class/interface/struct/enum/method) ---
  walkStructure(handle.root, handle.text, symbols, seen_names, _WALK_CONFIG);
  // The engine's SymbolInfo pass re-emits the same records, which dedup on
  // (name, line) and add nothing new for C#, so there is no separate pass.

  // --- refs: call-site regex minus _CALL_NOISE ---
  const refs: Ref[] = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);

  // --- secondary regex scan: namespaces / delegates / ctors / properties ---
  const class_names: Set<string> = new Set();
  for (const s of symbols) {
    if (_CLASS_NAME_KINDS.has(s.kind) && s.name) {
      class_names.add(s.name);
    }
  }
  common.merge_extra_symbols(symbols, seen_names, _extract_extras(source, class_names));

  // --- using imports (one ImpExp per `using …;` directive) ---
  const imp_exp: ImpExp[] = [];
  const lines = _pySplitlines(source.toString("utf-8"));
  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const i = idx0 + 1;
    const m = _USING_RE.exec(lines[idx0] as string);
    if (m !== null) {
      const target = _pyStrip(m[1] as string);
      if (target) {
        imp_exp.push(new ImpExp({ kind: "import", target, line: i }));
      }
    }
  }

  _LOG.debug(
    "csharp extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );

  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the C# extractor. Awaits Parser.init() + the c_sharp grammar load
 * (via ts_engine.getParser), then returns a SYNCHRONOUS extract(source, rel)
 * closure. get_extractor (parser.ts) awaits this; index_file stays synchronous.
 */
export async function getExtractor(): Promise<Extractor> {
  // csharp -> "c_sharp" wasm basename (getParser takes the GRAMMAR basename).
  const grammar = WASM_GRAMMAR_BY_LANG["csharp"] as string;
  const parser = await getParser(grammar);
  return (source: Buffer, rel_path: string) => _extract(parser, source, rel_path);
}
