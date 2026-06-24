/**
 * Java symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/java.py. Strict NodeNext ESM.
 *
 * -----
 * What the Python engine does, and how this reproduces it
 * -----
 * java.py calls common.collect_symbols_and_refs("java", …), which runs the
 * OPAQUE Rust processor (tree_sitter_language_pack.process). For Java the
 * processor's structure pass emits a StructureItem per
 * package/class/interface/enum/method (NOT constructors, fields, records, or
 * annotation-type declarations — those are surfaced by the secondary regex pass
 * below); its symbol pass (SymbolInfo) re-emits the SAME records (deduped on
 * (name, line), so it adds nothing new); its import pass emits one ImportInfo
 * per `import` statement with `.source` = the full statement text. java.py then:
 *   1. computes the set of class/enum/interface names from the structure pass,
 *   2. runs _extract_java_extras — a brace-depth regex scan that adds
 *      `@interface` annotation types, ALL-CAPS `static final` constants, and
 *      constructors (kind "method") that the structure pass omits, MERGED via
 *      common.merge_extra_symbols (deduped on (name, line), APPENDED after the
 *      structure symbols),
 *   3. expands each import `.source` via _extract_import_target (_IMPORT_RE),
 *   4. extracts call-site refs by regex (common.CALL_RE) minus _CALL_NOISE.
 * Sections are always empty for Java.
 *
 * This adapter reproduces the structure + import passes by walking the raw
 * web-tree-sitter AST (ts_engine.walkStructure / walkImports), then reuses the
 * UNCHANGED common.ts helpers for refs, import expansion, and the extras merge
 * — so the Java-specific behaviour (the _CALL_NOISE set, the import/const/ctor
 * regexes) is shared bit-for-bit with the oracle's intent.
 *
 * Structure-walk fidelity (verified against the oracle):
 *  - package_declaration -> kind "const" (engine StructureKind Module -> const).
 *    package_declaration has no `name` field; the name is the text of its single
 *    named child (a scoped_identifier / identifier). It has no body -> signature
 *    null. It never nests declarations, so its parent pass-through is moot.
 *  - class_declaration -> "class"; interface_declaration -> "interface";
 *    enum_declaration -> "enum"; method_declaration -> "method". The method kind
 *    is constant (no function->method promotion needed — Java method nodes are
 *    always methods).
 *  - parent_name = the nearest enclosing class/interface/enum name (the walk sets
 *    a new parent only on these declaration boundaries; method/enum bodies are
 *    descended transparently).
 *  - constructor_declaration, field_declaration, record_declaration, and
 *    annotation_type_declaration are NOT emitted by the structure walk (they are
 *    not declarations the engine surfaces). annotation types + constructors are
 *    re-added by the regex extras pass; records are intentionally never emitted.
 *  - signature = source[node_start : body_block_start], trimmed, <= 200 cp. The
 *    method node's start covers its leading @annotations/modifiers, so the
 *    signature naturally includes a leading `@Override\n  …` exactly like the
 *    oracle — NO decorator post-pass is required for Java. An un-bodied method
 *    (interface method / abstract method ending in `;`) has body == null ->
 *    signature null.
 */

import type { Node } from "web-tree-sitter";

import type { Extractor, Ref, Section, Symbol as SymbolType } from "../parser.js";
import { ImpExp, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";
import {
  getParser,
  parseToTree,
  walkImports,
  walkStructure,
  type WalkConfig,
} from "./ts_engine.js";

const _LOG = getLogger("languages.java");

// ===========================================================================
// Call-site ref noise filter (Java-specific) — port of java.py _CALL_NOISE
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "super", "this",
  "instanceof", "assert", "break", "continue", "finally", "try", "else",
  "int", "long", "double", "float", "boolean", "char", "byte", "short", "void",
  "String", "Object", "Class", "System", "Math", "Arrays", "Collections",
  "List", "Map", "Set", "Optional", "Stream",
  "null", "true", "false",
  "println", "print", "printf", "format",
  "equals", "hashCode", "toString", "getClass",
  "get", "set", "add", "remove", "size", "isEmpty", "contains",
  "length", "charAt", "substring", "indexOf", "startsWith", "endsWith",
]);

// ===========================================================================
// Regex patterns — ports of java.py module/inner regexes
// ===========================================================================

/** Port of java.py _IMPORT_RE. */
const _IMPORT_RE =
  /^import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)/;

/** Port of java.py _CONST_RE (an ALL-CAPS `static final` field). */
const _CONST_RE =
  /^\s+(?:public\s+|protected\s+|private\s+)?static\s+final\s+(?:[A-Za-z_][A-Za-z0-9_<>[\],\s]*?)\s+([A-Z_][A-Z0-9_]*)\s*[=;]/;

/** Port of java.py _CONSTRUCTOR_RE. */
const _CONSTRUCTOR_RE = /^\s+(?:public\s+|protected\s+|private\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/;

/** Port of java.py _ANNOTATION_TYPE_RE. */
const _ANNOTATION_TYPE_RE = /^(?:public\s+)?@interface\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** Port of the inner _CLASS_HEADER_RE in _extract_java_extras_inner. */
const _CLASS_HEADER_RE =
  /^(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*(?:class|enum|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/;

// ===========================================================================
// String helpers (Python parity)
// ===========================================================================

/** Take the first `n` CODE POINTS of `s` (Python `s[:n]`). */
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

/**
 * Reproduce Python str.splitlines() for the `\n`-delimited case: split on "\n"
 * and drop a single trailing empty element. Java source from these tests is
 * `\n`-delimited; the const/ctor regex scan is per visible line, so this matches
 * the Python enumerate(text.splitlines(), 1) iteration exactly.
 */
function _splitlines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Python str.count(sub) for single-char substrings (non-overlapping). */
function _countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) {
      n += 1;
    }
  }
  return n;
}

/** Python `str.rstrip()` — strip trailing ASCII whitespace (and common unicode). */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python `str.strip()`. */
function _strip(s: string): string {
  return s.replace(/^\s+|\s+$/gu, "");
}

// ===========================================================================
// Regex extras — port of _extract_java_extras_inner
// ===========================================================================

/**
 * Brace-depth regex scan that surfaces symbols the structure pass omits:
 *  - `@interface` annotation types (kind "interface"),
 *  - ALL-CAPS `static final` constants directly in a known class body
 *    (kind "const", parent = that class),
 *  - constructors whose name == the enclosing class (kind "method").
 *
 * Faithful port of java.py _extract_java_extras_inner: tracks the FIRST class
 * whose name is in `class_names` as `current_class`, only emits const/ctor at
 * brace-depth 1 relative to that class, and resets when the brace depth returns
 * to the class-start depth. Wrapped by {@link _extract_java_extras} in a
 * safe-regex guard matching java.py's common.safe_regex_parse.
 */
function _extract_java_extras_inner(source: Buffer, class_names: ReadonlySet<string>): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);
  let current_class: string | null = null;
  let brace_depth = 0;
  let class_start_depth = 0;

  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const i = idx0 + 1; // 1-based line number
    const line = lines[idx0] as string;
    const stripped = _strip(line);

    const m = _ANNOTATION_TYPE_RE.exec(line);
    if (m !== null) {
      symbols.push(
        new Symbol({
          name: m[1] as string,
          kind: "interface",
          line: i,
          end_line: i,
          signature: _sliceCodepoints(_rstrip(line), 200),
        }),
      );
    }

    const cm = _CLASS_HEADER_RE.exec(line);
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
        const const_m = _CONST_RE.exec(line);
        if (const_m !== null) {
          symbols.push(
            new Symbol({
              name: const_m[1] as string,
              kind: "const",
              line: i,
              end_line: i,
              signature: _sliceCodepoints(stripped, 200),
              parent_name: current_class,
            }),
          );
        }

        const ctor_m = _CONSTRUCTOR_RE.exec(line);
        if (ctor_m !== null && ctor_m[1] === current_class) {
          const sig_end = line.indexOf("{");
          const sig = sig_end >= 0 ? _rstrip(line.slice(0, sig_end)) : _rstrip(line);
          symbols.push(
            new Symbol({
              name: current_class,
              kind: "method",
              line: i,
              end_line: i,
              signature: sig ? _sliceCodepoints(sig, 200) : null,
              parent_name: current_class,
            }),
          );
        }
      }
    }

    brace_depth += _countChar(line, "{") - _countChar(line, "}");

    if (current_class !== null && brace_depth <= class_start_depth) {
      current_class = null;
    }
  }

  return symbols;
}

/** Port of java.py _extract_java_extras (safe-regex wrapper). */
function _extract_java_extras(source: Buffer, class_names: ReadonlySet<string>): Symbol[] {
  return common.safe_regex_parse(
    (...args: unknown[]) =>
      _extract_java_extras_inner(args[0] as Buffer, args[1] as ReadonlySet<string>),
    [source, class_names],
    { log: _LOG, label: "_extract_java_extras", empty: [] as Symbol[] },
  );
}

// ===========================================================================
// Import target parsing — port of java.py _extract_import_target
// ===========================================================================

/**
 * Return the fully-qualified import target from one Java import statement.
 *
 * Faithful port of java.py _extract_import_target operating on the import
 * node's full statement text (the engine's ImportInfo `.source` analogue):
 * strips and runs _IMPORT_RE, returning the captured dotted path (with an
 * optional trailing `.*`), or "" when it does not match.
 */
function _extract_import_target(source: string): string {
  const src = _strip(source);
  if (!src) {
    return "";
  }
  const m = _IMPORT_RE.exec(src);
  return m !== null ? (m[1] as string) : "";
}

// ===========================================================================
// Structure-walk configuration
// ===========================================================================

/** Declaration node types the structure pass emits, and their base kind. */
const _DEF_KIND: Record<string, string> = {
  package_declaration: "const",
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  method_declaration: "method",
};

/** Import statement node type (full-statement `.source` analogue). */
const _IMPORT_TYPES: ReadonlySet<string> = new Set(["import_declaration"]);

/**
 * Return the body block of a declaration (field "body"), or null. The signature
 * is sliced from the declaration start to this node's start. package_declaration
 * has no body -> null -> signature null; an un-bodied method (interface/abstract
 * `;`) also has no body -> signature null.
 */
function _bodyOf(node: Node): Node | null {
  return node.childForFieldName("body");
}

/**
 * Classify a node as a Java declaration the structure pass emits. Returns null
 * for any other node (the walk then recurses with the same parent — the
 * container pass-through), which is how constructors, fields, records, and
 * annotation-type declarations are skipped here (annotation types + ctors are
 * re-added by the regex extras pass).
 *
 * package_declaration has no `name` field; its name is the text of its single
 * named child (a scoped_identifier / identifier). All other declarations use the
 * `name` field.
 */
function _classify(node: Node, _parentName: string | null): { name: string; kind: string } | null {
  const kind = _DEF_KIND[node.type];
  if (kind === undefined) {
    return null;
  }
  if (node.type === "package_declaration") {
    // No name field — the dotted package path is the single named child's text.
    let nameNode: Node | null = null;
    for (const c of node.namedChildren) {
      if (c !== null) {
        nameNode = c;
        break;
      }
    }
    const name = nameNode !== null ? nameNode.text : "";
    if (!name) {
      return null;
    }
    return { name, kind };
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

/**
 * Extract symbols, refs, and imports from a Java source file.
 *
 * Mirrors java.py extract: structure walk (package/class/interface/enum/method)
 * + regex extras merge (annotation types / consts / constructors) + per-import
 * target expansion + call-site refs. Sections are always empty for Java.
 */
function _extract(
  parser: Awaited<ReturnType<typeof getParser>>,
  source: Buffer,
  rel_path: string,
): [SymbolType[], Ref[], ImpExp[], Section[]] {
  const handle = parseToTree(source, parser);
  if (handle === null) {
    _LOG.debug("java: parse failed for %s — no symbols", rel_path);
    return [[], [], [], []];
  }

  const symbols: SymbolType[] = [];
  const seen_names: Set<string> = new Set();

  // --- structure pass (package / classes / interfaces / enums / methods) ---
  walkStructure(handle.root, handle.text, symbols, seen_names, _WALK_CONFIG);

  // --- regex extras: @interface types, ALL-CAPS consts, constructors ---
  const class_names: Set<string> = new Set();
  for (const s of symbols) {
    if ((s.kind === "class" || s.kind === "enum" || s.kind === "interface") && s.name) {
      class_names.add(s.name);
    }
  }
  common.merge_extra_symbols(symbols, seen_names, _extract_java_extras(source, class_names));

  // --- imports: one ImpExp per import statement, in document order ---
  const imp_exp: ImpExp[] = [];
  walkImports(handle.root, _IMPORT_TYPES, (node) => {
    const line = node.startPosition.row + 1;
    const target = _extract_import_target(node.text);
    if (target) {
      imp_exp.push(new ImpExp({ kind: "import", target, line }));
    }
  });

  // --- refs: call-site regex minus _CALL_NOISE ---
  const refs: Ref[] = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);

  _LOG.debug(
    "java extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );

  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the Java extractor.
 *
 * Awaits Parser.init() + the java grammar load (via ts_engine.getParser), then
 * returns a SYNCHRONOUS extract(source, rel) closure that parses + walks the
 * AST. get_extractor (parser.ts) awaits this; index_file stays synchronous
 * thereafter.
 */
export async function getExtractor(): Promise<Extractor> {
  const parser = await getParser("java");
  return (source: Buffer, rel_path: string) => _extract(parser, source, rel_path);
}
