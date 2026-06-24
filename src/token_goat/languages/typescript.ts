/**
 * TypeScript / TSX / JS / JSX symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/typescript.py. Strict NodeNext ESM.
 *
 * -----
 * What the Python engine does, and how this reproduces it
 * -----
 * typescript.py calls common.make_process_config(language=…, exports=True) and
 * runs the OPAQUE Rust processor (tree_sitter_language_pack.process), which
 * returns a ProcessResult with four passes:
 *
 *   1. STRUCTURE — a tree of StructureItem(name, kind, span, body_span, children)
 *      for declarations. Empirically (verified against the oracle) the TypeScript
 *      grammar's structure pass emits, in document order, depth-first:
 *        - function_declaration            -> Function (name from `name` field)
 *        - class_declaration               -> Class    (descends into methods)
 *        - abstract_class_declaration      -> Class but with name=None (so its
 *          methods are emitted with the SAME parent the class had, i.e. they are
 *          NOT nested under the abstract class)
 *        - interface_declaration           -> Interface (body NOT descended:
 *          method_signature is never emitted)
 *        - enum_declaration                -> Enum (variants NOT emitted)
 *        - method_definition               -> Method (class + object-literal)
 *        - arrow_function / function_expression -> Function with name=None
 *        - internal_module (namespace/module) -> descended transparently (the
 *          namespace itself is NOT emitted; its members appear at the parent's
 *          level)
 *      NOT emitted: generator_function_declaration, abstract_method_signature,
 *      method_signature, public_field_definition, type_alias_declaration,
 *      lexical/variable declarations.
 *      The promote_methods flag is FALSE for TypeScript, so a nested
 *      function_declaration keeps kind "function" (it is NOT promoted to method);
 *      only method_definition nodes are kind "method".
 *
 *   2. SYMBOLS (SymbolInfo) — a FLAT list (full-tree DFS) of named declarations:
 *        function_declaration -> Function, class_declaration -> Class,
 *        interface_declaration -> Interface, type_alias_declaration -> Type,
 *        enum_declaration -> Enum. Excludes generator/abstract-class/methods/
 *        anonymous/const-var. Deduped on (name, line) against the structure pass,
 *        so its only NET contribution is the type aliases the structure pass
 *        misses (and any named decl the structure pass dropped, e.g. inside a
 *        node the structure walk doesn't descend).
 *
 *   3. IMPORTS — one ImportInfo per import_statement with `.source` = the FULL
 *      statement text (multi-line statements keep their newlines). typescript.py
 *      maps each to a module path via _extract_module.
 *
 *   4. EXPORTS — one ExportInfo per export_statement with `.name` = the FIRST
 *      LINE of the statement text, `.kind` = ReExport when the statement has a
 *      `from "…"` source else Named, `.span.start_line` = the statement start.
 *      typescript.py derives a clean export identifier from `.name`, optionally
 *      adds a const/function Symbol, and records an "export"/"reexport" ImpExp.
 *
 * typescript.py then post-processes:
 *   - structure -> Symbols via make_add_symbol (no method promotion),
 *   - SymbolInfo -> extra Symbols via add_symbol_info,
 *   - exports -> clean names + const/function Symbols + ImpExp,
 *   - a raw-source arrow-const FALLBACK that surfaces `export const f = () => {}`
 *     the export pass may miss and UPGRADES a const symbol to function,
 *   - imports -> ImpExp via _extract_module,
 *   - call-site refs via _CALL_RE minus _CALL_NOISE,
 *   - the decorator start-line post-pass (bracket-balanced walk back over
 *     @Decorator lines).
 *   Plus an ABI fast path for large generated Solidity-ABI constant files.
 *
 * This adapter reproduces every pass by walking the raw web-tree-sitter AST and
 * applying the SAME string post-processing as typescript.py (ported verbatim),
 * reusing the shared common.ts helpers (extract_refs_from_source,
 * extend_starts_for_decorators) and ts_engine.build_signature_str for the
 * UTF-16-index-safe signature slice.
 */

import type { Node } from "web-tree-sitter";

import type { Extractor, Ref, Section } from "../parser.js";
import { ImpExp, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";
import {
  build_signature_str,
  endLineOf,
  getParser,
  lineOf,
  parseToTree,
  symbolKey,
} from "./ts_engine.js";

const _LOG = getLogger("languages.typescript");

// ===========================================================================
// Decorator post-pass (TypeScript-specific, bracket-balanced)
// ===========================================================================

/**
 * Matches a TypeScript decorator line: optional indent, then `@Name` where Name
 * is a (possibly dotted) identifier. Port of python.py _TS_DECORATOR_LINE_RE.
 */
const _TS_DECORATOR_LINE_RE = /^\s*@[A-Za-z_$][A-Za-z0-9_$.]*/;

/** Count occurrences of a single character in a string (Python str.count). */
function _countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) {
      n += 1;
    }
  }
  return n;
}

/** Python `s.split("//", 1)[0]` — text before the first "//", or all of s. */
function _beforeLineComment(s: string): string {
  const idx = s.indexOf("//");
  return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Walk `def_line_1based` upward over a contiguous (possibly multi-line)
 * decorator block. Faithful port of python.py _decorator_block_start: tracks
 * bracket balance so a decorator whose argument list spans several lines
 * (`@Component({ … })`) is claimed in full.
 */
function _decorator_block_start(text_lines: string[], def_line_1based: number): number {
  const n = text_lines.length;
  if (def_line_1based <= 1 || def_line_1based > n) {
    return def_line_1based;
  }

  let new_start = def_line_1based;
  let i = def_line_1based - 2; // 0-based index of the line directly above the def
  let balance_paren = 0;
  let balance_brace = 0;
  let balance_bracket = 0;
  let saw_decorator = false;
  while (i >= 0) {
    const line = text_lines[i] as string;
    if (_TS_DECORATOR_LINE_RE.test(line)) {
      new_start = i + 1; // 1-based
      saw_decorator = true;
      // Reset balance: the decorator's own openers on this line account for
      // every closer we counted below.
      balance_paren = 0;
      balance_brace = 0;
      balance_bracket = 0;
      i -= 1;
      continue;
    }
    // Tolerate blank lines between stacked decorators, only after a decorator
    // has been locked onto above.
    if (saw_decorator && line.trim() === "") {
      i -= 1;
      continue;
    }
    // Strip line comments before counting brackets.
    const sanitized = _beforeLineComment(line);
    balance_paren += _countChar(sanitized, ")") - _countChar(sanitized, "(");
    balance_brace += _countChar(sanitized, "}") - _countChar(sanitized, "{");
    balance_bracket += _countChar(sanitized, "]") - _countChar(sanitized, "[");
    if (balance_paren > 0 || balance_brace > 0 || balance_bracket > 0) {
      // Inside an unclosed decorator-arg literal — keep walking up.
      i -= 1;
      continue;
    }
    // Non-negative balance, not a decorator: left the decorator block.
    break;
  }
  return new_start;
}

/** Eligible kinds for the decorator start-line walk. */
const _TS_ELIGIBLE_KINDS: ReadonlySet<string> = new Set([
  "class",
  "interface",
  "function",
  "method",
]);

/**
 * Walk each class/interface/function/method symbol's start_line back over
 * leading decorators. Port of python.py _extend_starts_for_decorators.
 */
function _extend_starts_for_decorators(symbols: Symbol[], source: Buffer): void {
  common.extend_starts_for_decorators(symbols, source, {
    eligible_kinds: _TS_ELIGIBLE_KINDS,
    walk_fn: _decorator_block_start,
  });
}

// ===========================================================================
// ABI special-case config (port of python.py)
// ===========================================================================

const _ABI_SIZE_THRESHOLD = 100_000; // bytes
const _ABI_MAX_SYMBOLS = 500;

// Top-level export extraction for ABI mode. Python re.MULTILINE -> `m` flag.
const _ABI_EXPORT_RE =
  /^export\s+(?:const|default|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

/** Python os.path.basename for a possibly-backslashed rel path. */
function _basename(rel_path: string): string {
  const norm = rel_path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/** Port of python.py _looks_like_abi_filename. */
function _looks_like_abi_filename(name: string, parts: string[]): boolean {
  return (
    name.endsWith("abi.ts") ||
    name.endsWith("abi.d.ts") ||
    name.endsWith(".abi.ts") ||
    (parts.length >= 2 && (parts[parts.length - 2] as string).toLowerCase() === "abi")
  );
}

/** Count non-overlapping occurrences of `needle` in `s` (Python str.count). */
function _countSubstr(s: string, needle: string): number {
  if (needle === "") {
    return 0;
  }
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = s.indexOf(needle, from);
    if (idx === -1) {
      break;
    }
    n += 1;
    from = idx + needle.length;
  }
  return n;
}

/**
 * Return True if this file should be treated as a generated ABI file. Port of
 * python.py _is_abi_file (size gate -> filename heuristic -> content heuristic).
 */
function _is_abi_file(source: Buffer, rel_path: string, threshold: number): boolean {
  if (source.length < threshold) {
    return false;
  }
  const name = _basename(rel_path).toLowerCase();
  const parts = rel_path.replace(/\\/g, "/").split("/");
  if (_looks_like_abi_filename(name, parts)) {
    return true;
  }
  // First 2 KB for autogenerated headers (decode bytes -> lowercase).
  const head = source.subarray(0, 2048).toString("utf-8").toLowerCase();
  for (const marker of ["// generated", "// auto-generated", "// autogenerated"]) {
    if (head.includes(marker)) {
      return true;
    }
  }
  // as const + many abi inputs/outputs in first 8 KB.
  const text_sample = source.subarray(0, 8192).toString("utf-8");
  if (text_sample.includes("as const")) {
    const n_inputs =
      _countSubstr(text_sample, '"inputs": [') + _countSubstr(text_sample, '"inputs":[');
    const n_outputs =
      _countSubstr(text_sample, '"outputs": [') + _countSubstr(text_sample, '"outputs":[');
    if (n_inputs + n_outputs > 5) {
      return true;
    }
  }
  return false;
}

/** Take the first `n` code points (Python `s[:n]`). */
function _sliceCp(s: string, n: number): string {
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

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python str.splitlines() for `\n`-delimited text (drops trailing empty). */
function _splitlines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Fast path for generated ABI files: index top-level exports only, no refs.
 * Port of python.py _extract_abi.
 */
function _extract_abi(source: Buffer): [Symbol[], Ref[], ImpExp[], Section[]] {
  const text = source.toString("utf-8");
  const lines = _splitlines(text);
  const symbols: Symbol[] = [];
  const seen: Set<string> = new Set();

  _ABI_EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _ABI_EXPORT_RE.exec(text)) !== null) {
    if (m.index === _ABI_EXPORT_RE.lastIndex) {
      _ABI_EXPORT_RE.lastIndex += 1;
    }
    const name = m[1] as string;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const line = _countChar(text.slice(0, m.index), "\n") + 1;
    const sig =
      line <= lines.length ? _sliceCp(_rstrip(lines[line - 1] as string), 150) : null;
    symbols.push(
      new Symbol({ name, kind: "abi_export", line, end_line: line, signature: sig }),
    );
    if (symbols.length >= _ABI_MAX_SYMBOLS) {
      break;
    }
  }

  return [symbols, [], [], []];
}

// ===========================================================================
// Call-site ref noise filter + regex (port of python.py)
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  // JS builtins and globals
  "console", "Object", "Array", "Math", "JSON", "Promise", "Error",
  "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Proxy", "Reflect",
  "String", "Number", "Boolean", "BigInt", "RegExp", "Date",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "setTimeout",
  "setInterval", "clearTimeout", "clearInterval", "fetch", "require",
  // Keywords that can be followed by (
  "if", "for", "while", "switch", "catch", "return", "throw",
  "typeof", "instanceof", "void", "delete", "yield", "await",
  "new", "super",
]);

// Identifier NOT preceded by . or word-char, immediately followed by (. The TS
// identifier set extends the shared one with `$`. Compiled with `u` so the
// `\p{…}` lookbehind classes (Unicode `\w` parity, see common.ts) are valid.
// Python: r"(?<![.\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\("
const _CALL_RE = /(?<![.\p{L}\p{N}_])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu;

// ===========================================================================
// Import/export name extraction (port of python.py)
// ===========================================================================

// Module path from an import/export `from "…"` line. NON-multiline default JS
// RegExp matches Python re.compile without flags. Python: from\s+['"]([^'"]+)['"]
const _FROM_RE = /from\s+['"]([^'"]+)['"]/;
// Python: ^import\s+.*?['"]([^'"]+)['"]  (applied to a .strip()ped line).
const _IMPORT_RE = /^import\s+[\s\S]*?['"]([^'"]+)['"]/;

// Export name extraction patterns — each `.match`ed (anchored at start) against
// the export statement's first line. Order matters (first hit wins).
const _EXPORT_NAME_RES: RegExp[] = [
  /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^export\s+(?:type\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
];

// const/let/var export symbol extraction (anchored at start).
const _EXPORT_CONST_RE = /^export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

// Assignment '=' that is NOT ==, ===, !=, <=, >=, or '=>'.
const _ASSIGN_RE = /(?<![=!<>])=(?![=>])/g;

// Arrow-function value head (anchored at RHS start).
const _ARROW_HEAD_RE =
  /^(?:async\s+)?(?:<[^>]*>\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=]+?)?\s*=>/;

// Function-expression value head.
const _FUNC_EXPR_HEAD_RE = /^(?:async\s+)?function\b/;

// Source-level fallback for arrow-const exports. Python re.MULTILINE -> `m`.
const _EXPORT_ARROW_FALLBACK_RE =
  /^[ \t]*export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:<[^>]*>\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:[^=]+?)?\s*=>/gm;

// Template-literal body matcher (DOTALL -> [\s\S]). Global so .replace replaces
// every backtick body. Python: `([^`]*?)` re.DOTALL.
const _TEMPLATE_LITERAL_RE = /`([\s\S]*?)`/g;

/**
 * Replace backtick template-literal bodies with same-height blank spans. Port of
 * python.py _blank_template_literals: keeps each body's newline count so line
 * numbers of later matches are unchanged.
 */
function _blank_template_literals(source: string): string {
  _TEMPLATE_LITERAL_RE.lastIndex = 0;
  return source.replace(_TEMPLATE_LITERAL_RE, (_m, body: string) => {
    return "`" + "\n".repeat(_countChar(body, "\n")) + "`";
  });
}

/**
 * Reproduce Python `re.Pattern.match(s)` (anchored at start) for a non-global
 * pattern that begins with `^`. The patterns here all start with `^`, so a plain
 * `.exec` against the candidate matches only at position 0.
 */
function _matchStart(pattern: RegExp, s: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(s);
}

/**
 * Classify a const/let/var export value as "function" or "const". Port of
 * python.py _const_export_kind. `stmt` is the export first-line text; `name_end`
 * is the offset just past the declared identifier.
 */
function _const_export_kind(stmt: string, name_end: number): string {
  _ASSIGN_RE.lastIndex = name_end;
  const assign = _ASSIGN_RE.exec(stmt);
  if (assign === null) {
    return "const";
  }
  const rhs = stmt.slice(assign.index + assign[0].length).replace(/^\s+/u, "");
  if (_ARROW_HEAD_RE.test(rhs) || _FUNC_EXPR_HEAD_RE.test(rhs)) {
    return "function";
  }
  return "const";
}

/**
 * Extract the module string from an import/export source text. Port of
 * python.py _extract_module.
 */
function _extract_module(source_line: string): string {
  const m = _FROM_RE.exec(source_line);
  if (m !== null) {
    return m[1] as string;
  }
  const stripped = source_line.trim();
  const m2 = _IMPORT_RE.exec(stripped);
  if (m2 !== null) {
    return m2[1] as string;
  }
  return stripped;
}

// ===========================================================================
// AST -> ProcessResult: pass reproductions
// ===========================================================================

/**
 * A structure-pass emit decision: the symbol [name, kind] (name=null when the
 * engine drops it — anonymous arrow/function-expr, abstract class) plus the body
 * subtree to descend (null = no descent: interface/enum bodies).
 */
interface StructEmit {
  name: string | null;
  kind: string;
  body: Node | null;
}

/** Return the `name`-field text of a node, or null. */
function _nameText(node: Node): string | null {
  const n = node.childForFieldName("name");
  return n === null ? null : n.text;
}

/** Return the `body`-field node, or null. */
function _bodyField(node: Node): Node | null {
  return node.childForFieldName("body");
}

/**
 * The engine names an `arrow_function` after the FIRST of its named children
 * whose type is `identifier`, else None. Reverse-engineered against the oracle:
 *  - `(a) => b`     -> "b"     (first child is formal_parameters, then id `b`)
 *  - `a => b`       -> "a"     (bare-identifier param is the first id child)
 *  - `(a) => a`     -> "a"     (param wrapped; body id `a` is the first id child)
 *  - `(a) => b + 1` -> None    (no identifier child: params + binary_expression)
 *  - `() => 1`      -> None    (no identifier child)
 *  - `({x}) => x`   -> "x"     (object-pattern param, then body id `x`)
 */
function _arrowBodyName(node: Node): string | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === "identifier") {
      return child.text;
    }
  }
  return null;
}

/**
 * Classify a node for the STRUCTURE pass (reverse-engineered against the oracle;
 * see module docstring). Anonymous functions/arrows and abstract classes emit
 * with name=null; method_definition emits "method". Returns null for any node
 * the structure pass does not emit (containers, namespaces, decorator/export
 * wrappers) — the walk then descends transparently with the same parent.
 */
function _classifyStructure(node: Node): StructEmit | null {
  switch (node.type) {
    case "function_declaration":
      return { name: _nameText(node), kind: "function", body: _bodyField(node) };
    case "class_declaration":
    case "class":
      // `class` is a class EXPRESSION (`const C = class Named {}`); the engine
      // treats it exactly like a class_declaration: name from the `name` field
      // (null for an anonymous `class {}`), descend the body for methods.
      return { name: _nameText(node), kind: "class", body: _bodyField(node) };
    case "abstract_class_declaration":
      // Engine reports the abstract class with name=None: emit a nameless record
      // and descend into the body WITHOUT becoming the parent.
      return { name: null, kind: "class", body: _bodyField(node) };
    case "interface_declaration":
      // Body NOT descended (interface method_signature is never emitted).
      return { name: _nameText(node), kind: "interface", body: null };
    case "enum_declaration":
      // Body NOT descended (enum variants are not symbols).
      return { name: _nameText(node), kind: "enum", body: null };
    case "method_definition":
      return { name: _nameText(node), kind: "method", body: _bodyField(node) };
    case "arrow_function":
      // Quirk reproduced from the oracle: an arrow whose BODY is a single bare
      // identifier (`(a) => b`) is emitted as a Function named after that body
      // identifier; any other body (block, call, binary, member, …) -> name=None.
      return { name: _arrowBodyName(node), kind: "function", body: _bodyField(node) };
    case "function_expression":
      // Engine drops the inner name; descend into the body.
      return { name: null, kind: "function", body: _bodyField(node) };
    default:
      return null;
  }
}

/**
 * Walk the AST reproducing the structure pass, appending Symbols (deduped on
 * (name, line)). `parentName` threads the enclosing declaration name. A nameless
 * emit does not change the parent (descendants keep `parentName`), matching
 * make_add_symbol's behaviour for empty-name nodes.
 */
function _walkStructure(
  node: Node,
  parentName: string | null,
  text: string,
  symbols: Symbol[],
  seen: Set<string>,
): void {
  const emit = _classifyStructure(node);
  if (emit !== null) {
    const name = emit.name;
    if (name) {
      const line = lineOf(node);
      const end_line = endLineOf(node);
      const sig = build_signature_str(text, node, _bodyField(node));
      const key = symbolKey(name, line);
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push(
          new Symbol({
            name,
            kind: emit.kind,
            line,
            end_line,
            signature: sig,
            parent_name: parentName,
          }),
        );
      }
      // Descend into the declaration body with this name as the new parent.
      if (emit.body !== null) {
        for (const child of emit.body.namedChildren) {
          if (child !== null) {
            _walkStructure(child, name, text, symbols, seen);
          }
        }
      }
      return;
    }
    // Nameless declaration (anonymous arrow/function-expr, abstract class):
    // emit nothing, descend into the body keeping the SAME parent.
    if (emit.body !== null) {
      for (const child of emit.body.namedChildren) {
        if (child !== null) {
          _walkStructure(child, parentName, text, symbols, seen);
        }
      }
    }
    return;
  }
  // Container / namespace / decorator-wrapper / export wrapper: descend with the
  // same parent over all named children.
  for (const child of node.namedChildren) {
    if (child !== null) {
      _walkStructure(child, parentName, text, symbols, seen);
    }
  }
}

/** SymbolInfo declaration node types -> kind. */
const _SYMBOL_INFO_KIND: Record<string, string> = {
  function_declaration: "function",
  class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

/**
 * Walk the full AST reproducing the SymbolInfo pass: a flat DFS collecting named
 * function/class/interface/type/enum declarations (excludes generator, abstract
 * class, methods, anonymous, const/var). Deduped on (name, line) against the
 * structure pass via `seen`.
 */
function _walkSymbolInfo(node: Node, symbols: Symbol[], seen: Set<string>): void {
  const kind = _SYMBOL_INFO_KIND[node.type];
  if (kind !== undefined) {
    const name = _nameText(node);
    if (name) {
      const line = lineOf(node);
      const key = symbolKey(name, line);
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push(
          new Symbol({
            name,
            kind,
            line,
            end_line: line,
            signature: null,
            parent_name: null,
          }),
        );
      }
    }
  }
  for (const child of node.namedChildren) {
    if (child !== null) {
      _walkSymbolInfo(child, symbols, seen);
    }
  }
}

/** An export-pass record: first-line text, line, and whether it is a re-export. */
interface ExportRecord {
  nameRaw: string;
  line: number;
  reexport: boolean;
}

/** Walk the AST collecting export_statement records in document order. */
function _walkExports(node: Node, out: ExportRecord[]): void {
  if (node.type === "export_statement") {
    const firstLine = node.text.split("\n")[0] as string;
    const reexport = node.childForFieldName("source") !== null;
    out.push({ nameRaw: firstLine, line: lineOf(node), reexport });
  }
  for (const child of node.namedChildren) {
    if (child !== null) {
      _walkExports(child, out);
    }
  }
}

/** Walk the AST collecting import_statement records (full text + line). */
function _walkImports(node: Node, out: Array<{ source: string; line: number }>): void {
  if (node.type === "import_statement") {
    out.push({ source: node.text, line: lineOf(node) });
  }
  for (const child of node.namedChildren) {
    if (child !== null) {
      _walkImports(child, out);
    }
  }
}

// ===========================================================================
// extract
// ===========================================================================

/**
 * Pick the tree-sitter grammar key for a rel path, mirroring python.py's
 * language detection: `.tsx`/`.jsx` -> tsx, `.ts` -> typescript, else
 * javascript. The tsx grammar parses JSX (the typescript grammar treats `<…>`
 * as type assertions and errors on JSX), so a `.tsx` file MUST use it or the
 * structure walk loses every JSX-containing declaration.
 */
function _grammarFor(rel_path: string): string {
  const lower = rel_path.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
    return "tsx";
  }
  if (lower.endsWith(".ts")) {
    return "typescript";
  }
  return "javascript";
}

function _extract(
  parsers: Record<string, Awaited<ReturnType<typeof getParser>>>,
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  // ABI fast path: skip the structure walk for huge generated type files.
  if (
    source.length >= _ABI_SIZE_THRESHOLD &&
    _is_abi_file(source, rel_path, _ABI_SIZE_THRESHOLD)
  ) {
    const [syms, refs, ie] = _extract_abi(source);
    const capped = syms.slice(0, _ABI_MAX_SYMBOLS);
    return [capped, refs, ie, []];
  }

  const parser = parsers[_grammarFor(rel_path)] as Awaited<ReturnType<typeof getParser>>;
  const handle = parseToTree(source, parser);
  if (handle === null) {
    _LOG.warning(
      "tree-sitter parse failed for %s (typescript) — file will be indexed without symbols",
      rel_path,
    );
    return [[], [], [], []];
  }
  const text = handle.text;

  const symbols: Symbol[] = [];
  const imp_exp: ImpExp[] = [];
  const seen_names: Set<string> = new Set();

  // --- structure pass (functions / classes / methods, with parents) ---
  _walkStructure(handle.root, null, text, symbols, seen_names);

  // --- SymbolInfo pass (type aliases, plus any missed named decls) ---
  _walkSymbolInfo(handle.root, symbols, seen_names);

  // --- exports: clean names + const/function symbols + ImpExp ---
  const exportRecords: ExportRecord[] = [];
  _walkExports(handle.root, exportRecords);
  for (const exp of exportRecords) {
    const name_raw = exp.nameRaw;
    const line = exp.line;

    let export_name: string | null = null;
    for (const pattern of _EXPORT_NAME_RES) {
      const m = _matchStart(pattern, name_raw);
      if (m !== null) {
        export_name = m[1] as string;
        break;
      }
    }
    if (export_name === null) {
      const tokens = name_raw.trim().split(/\s+/u).filter((t) => t.length > 0);
      export_name = tokens.length > 1 ? (tokens[1] as string) : _sliceCp(name_raw, 80);
    }

    // const/let/var export -> add a symbol (function for arrow/func-expr).
    const const_m = _matchStart(_EXPORT_CONST_RE, name_raw);
    if (const_m !== null) {
      const cname = const_m[1] as string;
      const key = symbolKey(cname, line);
      if (!seen_names.has(key)) {
        seen_names.add(key);
        const ckind = _const_export_kind(name_raw, const_m.index + const_m[0].length);
        symbols.push(
          new Symbol({ name: cname, kind: ckind, line, end_line: line, signature: null }),
        );
      }
    }

    // Record as ImpExp.
    const ie_kind = exp.reexport ? "reexport" : "export";
    imp_exp.push(new ImpExp({ kind: ie_kind, target: export_name, line }));
  }

  // --- source fallback: arrow-const exports the export pass missed ---
  const by_name: Map<string, Symbol> = new Map();
  for (const s of symbols) {
    if (!by_name.has(s.name) || s.kind === "const") {
      by_name.set(s.name, s);
    }
  }
  const scan_text = _blank_template_literals(text);
  _EXPORT_ARROW_FALLBACK_RE.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = _EXPORT_ARROW_FALLBACK_RE.exec(scan_text)) !== null) {
    if (fm.index === _EXPORT_ARROW_FALLBACK_RE.lastIndex) {
      _EXPORT_ARROW_FALLBACK_RE.lastIndex += 1;
    }
    const fname = fm[1] as string;
    const existing = by_name.get(fname);
    if (existing !== undefined) {
      if (existing.kind === "const") {
        existing.kind = "function";
      }
      continue;
    }
    const fline = _countChar(scan_text.slice(0, fm.index), "\n") + 1;
    const new_sym = new Symbol({
      name: fname,
      kind: "function",
      line: fline,
      end_line: fline,
      signature: null,
    });
    by_name.set(fname, new_sym);
    symbols.push(new_sym);
  }

  // --- imports ---
  const importRecords: Array<{ source: string; line: number }> = [];
  _walkImports(handle.root, importRecords);
  for (const imp of importRecords) {
    const target = _extract_module(imp.source);
    if (target) {
      imp_exp.push(new ImpExp({ kind: "import", target, line: imp.line }));
    }
  }

  // --- refs via regex ---
  const refs: Ref[] = common.extract_refs_from_source(source, _CALL_RE, _CALL_NOISE);

  // --- post-pass: extend start_line over preceding decorator lines ---
  _extend_starts_for_decorators(symbols, source);

  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the TypeScript/JavaScript extractor.
 *
 * Awaits Parser.init() + the typescript grammar load (via ts_engine.getParser),
 * then returns a SYNCHRONOUS extract(source, rel) closure. The registry routes
 * javascript -> typescript and tsx/jsx -> typescript grammar, so a single
 * grammar serves all four; the TypeScript grammar parses JS/JSX/TSX faithfully
 * for the structure/symbol shapes this adapter reproduces.
 */
export async function getExtractor(): Promise<Extractor> {
  // Load all three grammars up front (cached per key by ts_engine) so the sync
  // extract() can route by file extension without awaiting.
  const [typescript, tsx, javascript] = await Promise.all([
    getParser("typescript"),
    getParser("tsx"),
    getParser("javascript"),
  ]);
  const parsers = { typescript, tsx, javascript };
  return (source: Buffer, rel_path: string) => _extract(parsers, source, rel_path);
}
