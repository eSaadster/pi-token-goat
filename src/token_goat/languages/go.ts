/**
 * Go symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/go.py. Strict NodeNext ESM.
 *
 * -----
 * What the Python engine does, and how this reproduces it
 * -----
 * go.py calls common.collect_symbols_and_refs("go", …), which runs the OPAQUE
 * Rust processor (tree_sitter_language_pack.process). For Go the processor's
 * structure pass emits a StructureItem per function/method (with a signature);
 * its symbol pass (SymbolInfo) emits a record per package-level type/interface
 * (kind "type" / "interface", null signature). Because the two passes append in
 * sequence and dedup on (name, line), the OBSERVABLE Go symbol ordering is:
 * ALL functions/methods first (document order), THEN all types/interfaces
 * (document order). go.py then layers four regex post-passes:
 *   1. _extract_const_var — package-level const/var (single + block forms),
 *   2. add_imports over the import pass (one ImportInfo per import_declaration
 *      AND per import_spec; the block-header declaration is skipped),
 *   3. _extract_interface_methods — one Symbol per `MethodName(` line inside a
 *      `type Foo interface { … }` block (column-0 header only),
 *   4. _set_receiver_parents — back-fills parent_name on receiver methods.
 * Refs are call-site regex (common.CALL_RE) minus _CALL_NOISE.
 *
 * This adapter reproduces the structure + symbol-info + import passes by walking
 * the raw web-tree-sitter AST (the Rust processor is unavailable in the TS
 * port), then runs the four regex post-passes verbatim from go.py over the
 * UTF-8 source. Refs reuse common.extract_refs_from_source unchanged.
 *
 * Structure-walk fidelity (verified against the oracle):
 *  - PASS A (functions): every function_declaration / method_declaration in
 *    document order -> kind "function" / "method", signature = source[node.start
 *    : body.start] trimmed (null when the declaration has no body, e.g. an
 *    external `func noBody()`). parent_name is left null here; the receiver
 *    post-pass fills it. Nested func_literal nodes are NOT declarations and emit
 *    nothing.
 *  - PASS B (types): every type_spec in document order -> kind "interface" when
 *    its `type` child is an interface_type, else "type"; null signature. This
 *    covers both `type Foo …` and the `type ( … )` group form.
 *  - Both passes dedup on (name, line) via a shared seen-set, matching the
 *    engine's two-pass dedup.
 *  - Signatures slice the DECODED STRING by node start indices (UTF-16 units),
 *    via ts_engine.build_signature_str — byte-identical to the oracle's UTF-8
 *    byte slice for ASCII and multi-byte source alike.
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
  type ParseHandle,
} from "./ts_engine.js";

const _LOG = getLogger("languages.go");

// ===========================================================================
// Noise filter for call-site refs (port of go.py _CALL_NOISE)
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "make", "new", "len", "cap", "append", "copy", "delete",
  "panic", "recover", "print", "println", "close",
  "fmt", "fmt.Printf", "fmt.Println", "fmt.Errorf",
  "if", "for", "switch", "select", "go", "defer",
  "return", "func", "struct", "interface", "map", "chan",
  "string", "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64",
  "bool", "byte", "rune", "error",
]);

// ===========================================================================
// Go-specific regexes (ports of the go.py module-level patterns)
// ===========================================================================

/** Quoted import path from a Go import line. Python: r'"([^"]+)"'. */
const _GO_IMPORT_RE = /"([^"]+)"/;

/** Identifier in a const/var spec line. Python: r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|[A-Za-z_\(])". */
const _IDENT_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|[A-Za-z_(])/;

/** Interface block header `type Foo interface {`. */
const _IFACE_HEADER_RE = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\s*\{/;

/**
 * Interface method signature line: an indented identifier followed by `(`.
 * Group 1 = method name; group 2 = `(`…end-of-line. Python: r"^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(.*)".
 */
const _IFACE_METHOD_RE = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(.*)/;

/**
 * Receiver method declaration `func (recv ReceiverType) MethodName`.
 * Group 1 = receiver type (pointer stripped); group 2 = method name.
 * Python: r"^func\s*\(\s*\w+\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+([A-Za-z_][A-Za-z0-9_]*)".
 */
const _RECEIVER_RE =
  /^func\s*\(\s*\w+\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+([A-Za-z_][A-Za-z0-9_]*)/;

// Package-level const/var declaration patterns (hoisted, like go.py).
const _CONST_SINGLE_RE = /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s/;
const _CONST_BLOCK_RE = /^const\s*\($/;
const _VAR_SINGLE_RE = /^var\s+([A-Za-z_][A-Za-z0-9_]*)\s/;
const _VAR_BLOCK_RE = /^var\s*\($/;

// ===========================================================================
// splitlines / small string helpers (Python str semantics)
// ===========================================================================

// Python str.splitlines() line-boundary code points (escape-only — no literal
// control bytes in this source). Covers the universal-newline set: LF, CR, VT,
// FF, FS, GS, RS, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR. "\r\n" is one
// boundary, handled specially in _splitlines.
const _LINE_BREAK_CHARS: ReadonlySet<string> = new Set([
  "\n", "\r", "\v", "\f",
  "\u001c", "\u001d", "\u001e",
  "\u0085", "\u2028", "\u2029",
]);

/**
 * Port of Python str.splitlines(): split on universal newlines and DROP a
 * trailing empty final element (no boundary kept). A single empty string -> [].
 */
function _splitlines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === "\r" && i + 1 < n && text[i + 1] === "\n") {
      out.push(buf);
      buf = "";
      i += 2;
      continue;
    }
    if (_LINE_BREAK_CHARS.has(ch)) {
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf !== "") {
    out.push(buf);
  }
  return out;
}

/** Python str.strip() — trim leading/trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.rstrip() — trim trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python str.lstrip() — trim leading whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/u, "");
}

/** Python `s[:200]` on code points. Go regex slices are ASCII-prefixed. */
function _slice200(s: string): string {
  if (s.length <= 200) {
    return s;
  }
  let out = "";
  let count = 0;
  for (const ch of s) {
    if (count >= 200) {
      break;
    }
    out += ch;
    count += 1;
  }
  return out;
}

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

// ===========================================================================
// AST structure passes
// ===========================================================================

const _FUNC_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "method_declaration",
]);

/**
 * PASS A — collect every function_declaration / method_declaration in document
 * order. kind "function" / "method"; signature = source[node.start : body.start]
 * trimmed (null when no body). parent_name left null (receiver pass fills it).
 */
function _walkFunctions(
  handle: ParseHandle,
  symbols: Symbol[],
  seen_names: Set<string>,
): void {
  const visit = (node: Node): void => {
    // The Rust engine's structure pass surfaces every named
    // function_declaration / method_declaration node, INCLUDING ones whose
    // subtree contains a parse error (verified against the oracle: a malformed
    // `func broken( {` is emitted with name "broken", end_line at the node's
    // last row, and signature = source[node.start : body.start]). The grammar
    // still recovers the `name` field and a `body` block on such error nodes.
    if (_FUNC_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      const name = nameNode !== null ? nameNode.text : "";
      if (name) {
        const line = lineOf(node);
        const key = symbolKey(name, line);
        if (!seen_names.has(key)) {
          seen_names.add(key);
          const body = node.childForFieldName("body");
          const kind = node.type === "method_declaration" ? "method" : "function";
          symbols.push(
            new Symbol({
              name,
              kind,
              line,
              end_line: endLineOf(node),
              signature: build_signature_str(handle.text, node, body),
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
  visit(handle.root);
}

/**
 * PASS B — collect every type_spec in document order. kind "interface" when its
 * `type` child is an interface_type, else "type"; null signature. Covers both
 * `type Foo …` and `type ( … )` group declarations.
 */
function _walkTypes(
  handle: ParseHandle,
  symbols: Symbol[],
  seen_names: Set<string>,
): void {
  const visit = (node: Node): void => {
    // Only type_spec (`type X struct/interface/…`) is surfaced by the engine's
    // symbol-info pass. type_alias (`type X = Y`) is NOT emitted. Error-laden
    // specs ARE emitted (verified against the oracle: a malformed
    // `type Bad struct { …` is surfaced as kind "type"/"interface" with null
    // signature and end_line at the node's last recovered row).
    if (node.type === "type_spec") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode !== null ? nameNode.text : "";
      if (name) {
        const line = lineOf(node);
        const key = symbolKey(name, line);
        if (!seen_names.has(key)) {
          seen_names.add(key);
          const typeNode = node.childForFieldName("type");
          const kind = typeNode !== null && typeNode.type === "interface_type"
            ? "interface"
            : "type";
          symbols.push(
            new Symbol({
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
  visit(handle.root);
}

/**
 * Import pass — collect import_declaration and import_spec nodes in document
 * order (the engine emits one ImportInfo per node). Hands node.text to
 * {@link _extract_go_import_target}; block-header declarations are skipped.
 */
function _walkImports(handle: ParseHandle, imp_exp: ImpExp[]): void {
  const visit = (node: Node): void => {
    if (node.type === "import_declaration" || node.type === "import_spec") {
      const target = _extract_go_import_target(node.text);
      if (target) {
        imp_exp.push(new ImpExp({ kind: "import", target, line: lineOf(node) }));
      }
    }
    for (const c of node.namedChildren) {
      if (c !== null) {
        visit(c);
      }
    }
  };
  visit(handle.root);
}

/**
 * Extract the bare import path from a Go import node's source text (port of
 * go.py _extract_go_import_target). The block-level `import (…` header is
 * skipped (its specs are emitted separately); named imports (`alias "path"`)
 * are normalised to the path.
 */
function _extract_go_import_target(src_raw: string): string {
  const src = _strip(src_raw);
  if (src.startsWith("import (")) {
    return "";
  }
  const m = _GO_IMPORT_RE.exec(src);
  return m !== null ? (m[1] as string) : "";
}

// ===========================================================================
// const/var regex pass (port of go.py _extract_const_var)
// ===========================================================================

/**
 * Consume lines inside a Go `const (` / `var (` block. `start` is the index of
 * the first line AFTER the opening `(`. Returns [symbols, next_i] where next_i
 * is the index of the line after the closing `)`.
 */
function _scan_decl_block(
  lines: string[],
  start: number,
  kind: string,
): [Symbol[], number] {
  const symbols: Symbol[] = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line_stripped = _strip(lines[i] as string);
    if (line_stripped === ")") {
      break;
    }
    if (line_stripped && !line_stripped.startsWith("//")) {
      const ident_match = _IDENT_RE.exec(line_stripped);
      if (ident_match !== null && ident_match.index === 0) {
        const name = ident_match[1] as string;
        symbols.push(
          new Symbol({
            name,
            kind,
            line: i + 1,
            end_line: i + 1,
            signature: _slice200(line_stripped),
          }),
        );
      }
    }
    i += 1;
  }
  return [symbols, i + 1]; // skip past the closing ')'
}

/** Inner implementation of the const/var pass (port of _extract_const_var_inner). */
function _extract_const_var_inner(source: Buffer): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);
  const n_lines = lines.length;
  let i = 0;
  while (i < n_lines) {
    const line = lines[i] as string;
    // Only package-level declarations (not indented).
    if (line.startsWith(" ") || line.startsWith("\t")) {
      i += 1;
      continue;
    }
    const stripped = _lstrip(line);

    let matched = false;
    for (const [single_re, block_re, kind] of [
      [_CONST_SINGLE_RE, _CONST_BLOCK_RE, "const"],
      [_VAR_SINGLE_RE, _VAR_BLOCK_RE, "var"],
    ] as [RegExp, RegExp, string][]) {
      // Single-line: const/var Foo = …
      const m = single_re.exec(stripped);
      if (m !== null && m.index === 0) {
        symbols.push(
          new Symbol({
            name: m[1] as string,
            kind,
            line: i + 1,
            end_line: i + 1,
            signature: _slice200(_rstrip(line)),
          }),
        );
        i += 1;
        matched = true;
        break;
      }
      // Block: const/var (
      const bm = block_re.exec(stripped);
      if (bm !== null && bm.index === 0) {
        const [block_syms, next_i] = _scan_decl_block(lines, i + 1, kind);
        for (const s of block_syms) {
          symbols.push(s);
        }
        i = next_i;
        matched = true;
        break;
      }
    }
    if (!matched) {
      i += 1;
    }
  }
  return symbols;
}

/** Extract package-level const/var declarations (error-boundaried). */
function _extract_const_var(source: Buffer): Symbol[] {
  return common.safe_regex_parse(
    () => _extract_const_var_inner(source),
    [],
    { log: _LOG, label: "_extract_const_var", empty: [] as Symbol[] },
  );
}

// ===========================================================================
// interface-method regex pass (port of go.py _extract_interface_methods)
// ===========================================================================

function _extract_interface_methods_inner(source: Buffer): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const m = _IFACE_HEADER_RE.exec(lines[i] as string);
    if (m !== null && m.index === 0) {
      const iface_name = m[1] as string;
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const line = lines[j] as string;
        depth += _countChar(line, "{") - _countChar(line, "}");
        if (depth > 0) {
          const mm = _IFACE_METHOD_RE.exec(line);
          if (mm !== null && mm.index === 0) {
            const method_name = mm[1] as string;
            const sig_tail = _strip(mm[2] as string);
            const sig = sig_tail.startsWith("(")
              ? _slice200(`${method_name}(${sig_tail.slice(1)}`)
              : null;
            symbols.push(
              new Symbol({
                name: method_name,
                kind: "method",
                line: j + 1,
                end_line: j + 1,
                signature: sig,
                parent_name: iface_name,
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

/** Extract interface-body method signatures as Symbols (error-boundaried). */
function _extract_interface_methods(source: Buffer): Symbol[] {
  return common.safe_regex_parse(
    () => _extract_interface_methods_inner(source),
    [],
    { log: _LOG, label: "_extract_interface_methods", empty: [] as Symbol[] },
  );
}

// ===========================================================================
// receiver-parent back-fill (port of go.py _set_receiver_parents)
// ===========================================================================

/**
 * Set parent_name on receiver methods tree-sitter left unparented. Scans the
 * source for `func (recv Type) Method` declarations and matches each against the
 * symbol list by (name, line).
 */
function _set_receiver_parents(symbols: Symbol[], source: Buffer): void {
  let text: string;
  try {
    text = source.toString("utf-8");
  } catch {
    return;
  }
  const lines = _splitlines(text);
  const receiver_by_name: Map<string, string> = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = _RECEIVER_RE.exec(lines[i] as string);
    if (m !== null && m.index === 0) {
      const receiver_type = m[1] as string;
      const method_name = m[2] as string;
      receiver_by_name.set(symbolKey(method_name, i + 1), receiver_type);
    }
  }
  for (const sym of symbols) {
    if (sym.kind === "method" && sym.parent_name === null) {
      const parent = receiver_by_name.get(symbolKey(sym.name, sym.line));
      if (parent) {
        sym.parent_name = parent;
      }
    }
  }
}

// ===========================================================================
// extract
// ===========================================================================

function _extract(
  parser: Awaited<ReturnType<typeof getParser>>,
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const handle = parseToTree(source, parser);
  if (handle === null) {
    _LOG.debug("go: parse failed for %s — no symbols", rel_path);
    return [[], [], [], []];
  }

  const symbols: Symbol[] = [];
  const seen_names: Set<string> = new Set();

  // --- structure pass (functions/methods) then symbol-info pass (types) ---
  _walkFunctions(handle, symbols, seen_names);
  _walkTypes(handle, symbols, seen_names);

  // --- refs: call-site regex minus _CALL_NOISE ---
  const refs: Ref[] = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);

  // --- const/var (not surfaced by the structure/symbol passes) ---
  common.merge_extra_symbols(symbols, seen_names, _extract_const_var(source));

  // --- imports ---
  const imp_exp: ImpExp[] = [];
  _walkImports(handle, imp_exp);

  // --- interface methods (not surfaced by the structure/symbol passes) ---
  common.merge_extra_symbols(symbols, seen_names, _extract_interface_methods(source));

  // --- receiver method parent tracking ---
  _set_receiver_parents(symbols, source);

  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the Go extractor. Awaits Parser.init() + the go grammar load, then
 * returns a SYNCHRONOUS extract(source, rel) closure.
 */
export async function getExtractor(): Promise<Extractor> {
  const parser = await getParser("go");
  return (source: Buffer, rel_path: string) => _extract(parser, source, rel_path);
}
