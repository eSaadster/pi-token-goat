/**
 * Shared web-tree-sitter infrastructure for the Layer-7 GRAMMAR adapters.
 *
 * The Python engine (token_goat.languages.common.parse_source) delegates to an
 * OPAQUE Rust processor (tree_sitter_language_pack.process) that returns a
 * ProcessResult of StructureItem / SymbolInfo / ImportInfo records. There is no
 * Rust source to port; this module instead reproduces that processor's
 * OBSERVABLE OUTPUT by parsing with web-tree-sitter and walking the raw AST.
 * The per-language adapters (python.ts, …) layer their own node-type tables on
 * top of the generic scaffolding here.
 *
 * -----
 * web-tree-sitter API (v0.25)
 * -----
 *  - `await Parser.init()` must run ONCE per process (memoised here).
 *  - `await Language.load(wasmPath)` loads a grammar; cached per grammar key.
 *  - `new Parser(); p.setLanguage(lang); p.parse(text)` parses SYNCHRONOUSLY
 *    once the grammar is loaded. parse() requires a STRING (a Buffer throws).
 *  - Walk via node.type / node.childForFieldName(name) / node.namedChildren /
 *    node.startPosition.row (0-based) / node.startIndex / node.text.
 *
 * -----
 * Byte/line/offset reconciliation (THE parity-critical detail)
 * -----
 * The Python engine works in UTF-8 BYTE offsets and slices the UTF-8 source
 * bytes for signatures. web-tree-sitter's node.startIndex / node.endIndex are
 * UTF-16 CODE-UNIT indices into the decoded string (verified empirically:
 * for "café = 1\ndef …", the def node's startIndex is the UTF-16 length 9, not
 * the UTF-8 byte length 10). Therefore:
 *  - LINE numbers come from node.startPosition.row + 1 — encoding-independent
 *    and identical to the engine's span.start_line + 1.
 *  - SIGNATURE slices use the DECODED STRING sliced by startIndex/endIndex
 *    (UTF-16 units), NOT the Buffer sliced by bytes. Slicing the string by
 *    UTF-16 units yields the SAME visible characters the engine's byte-slice of
 *    the UTF-8 buffer yields, so the trimmed/200-codepoint-truncated signature
 *    is byte-identical to the oracle for both ASCII and multi-byte input. This
 *    is why adapters MUST use {@link build_signature_str} here and NOT
 *    common.ts's build_signature (which slices the Buffer by byte offset and
 *    would desync on multi-byte source).
 *
 * -----
 * Module-global caches
 * -----
 *  - `_initPromise` memoises Parser.init() (one global init).
 *  - `_LANG_CACHE` caches the loaded Language per grammar key.
 *  - `_PARSER_CACHE` caches one Parser per grammar key (setLanguage is sticky;
 *    a per-grammar Parser avoids re-setting the language on every file).
 * All three are registered with reset.ts so clearModuleCaches() (every test's
 * beforeEach) drops them back to a fresh state. Re-initialising is cheap (the
 * wasm is already in the module cache); dropping the handles is what the reset
 * contract guarantees, mirroring the flat get_tlp() degradation seam.
 */

import { createRequire } from "node:module";

import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";

import { Symbol } from "../parser.js";
import { registerReset } from "../reset.js";

// ===========================================================================
// Grammar key -> wasm basename map
// ===========================================================================

/**
 * Map a language key (as used by the parser registry) to the tree-sitter-wasms
 * grammar basename. Note csharp -> c_sharp. javascript and c are intentionally
 * absent here because the registry routes javascript->typescript and c->cpp;
 * an adapter that needs them resolves its own grammar key explicitly.
 */
export const WASM_GRAMMAR_BY_LANG: Record<string, string> = {
  python: "python",
  java: "java",
  typescript: "typescript",
  javascript: "javascript",
  cpp: "cpp",
  c: "c",
  csharp: "c_sharp",
  go: "go",
  ruby: "ruby",
  rust: "rust",
  php: "php",
  kotlin: "kotlin",
};

// ===========================================================================
// Module-global caches (registered with reset.ts)
// ===========================================================================

/** Memoised Parser.init() promise. Resolves once per process. */
let _initPromise: Promise<void> | null = null;

/** grammar-key -> loaded Language. */
const _LANG_CACHE: Map<string, Language> = new Map();

/** grammar-key -> Parser with that language already set. */
const _PARSER_CACHE: Map<string, Parser> = new Map();

// Drop the caches on clearModuleCaches() (every test beforeEach). The wasm
// stays in Node's module cache, so a subsequent loadGrammar re-init/re-load is
// cheap; this only guarantees no stale Parser/Language handle leaks across
// tests, mirroring the parser.ts _EXTRACTOR_CACHE reset registration.
registerReset(() => {
  _initPromise = null;
  _LANG_CACHE.clear();
  _PARSER_CACHE.clear();
});

// ===========================================================================
// Parser.init / loadGrammar / parseToTree
// ===========================================================================

const _require = createRequire(import.meta.url);

/**
 * Resolve the absolute filesystem path of a tree-sitter-wasms grammar wasm.
 *
 * Uses createRequire(import.meta.url).resolve so the path is found whether the
 * code runs from src/ (vitest/tsx), build/ (compiled), or a bundle — the
 * resolution is anchored at the installed `tree-sitter-wasms` package, not at a
 * relative dist path.
 *
 * @param grammar wasm basename (e.g. "python", "c_sharp").
 */
export function resolveWasmPath(grammar: string): string {
  return _require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

/**
 * Initialise web-tree-sitter exactly once per process (memoised). All adapters
 * await this before loading a grammar. Safe to call concurrently — the second
 * caller awaits the same in-flight promise.
 */
export async function initParser(): Promise<void> {
  if (_initPromise === null) {
    _initPromise = Parser.init();
  }
  await _initPromise;
}

/**
 * Load (and cache) the Language for a grammar key, initialising the runtime
 * first. The grammar key is the wasm basename (python/java/c_sharp/…), NOT
 * necessarily the parser language key — callers map language->grammar via
 * {@link WASM_GRAMMAR_BY_LANG} or pass the basename directly.
 *
 * @param grammar wasm basename.
 */
export async function loadGrammar(grammar: string): Promise<Language> {
  await initParser();
  const cached = _LANG_CACHE.get(grammar);
  if (cached !== undefined) {
    return cached;
  }
  const wasmPath = resolveWasmPath(grammar);
  const lang = await Language.load(wasmPath);
  _LANG_CACHE.set(grammar, lang);
  return lang;
}

/**
 * Return a Parser whose language is set to `grammar` (cached per grammar). The
 * runtime is initialised and the grammar loaded on first use.
 */
export async function getParser(grammar: string): Promise<Parser> {
  const cached = _PARSER_CACHE.get(grammar);
  if (cached !== undefined) {
    return cached;
  }
  const lang = await loadGrammar(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  _PARSER_CACHE.set(grammar, parser);
  return parser;
}

/**
 * A parse handle: the parsed Tree plus the exact decoded string that was
 * parsed. Adapters slice `text` (UTF-16 units) by node.startIndex/endIndex for
 * signatures — never the original Buffer by byte offset (see the byte/line
 * reconciliation note at the top of this module).
 */
export interface ParseHandle {
  /** The web-tree-sitter root node. */
  root: Node;
  /** The decoded UTF-8 -> JS string that was parsed (UTF-16 internally). */
  text: string;
}

/**
 * Parse `source` (UTF-8 bytes) with the given grammar, returning the root node
 * and the decoded text. Decodes the Buffer to a string first (parse() requires
 * a string; a Buffer throws). Returns null on any failure so callers degrade to
 * empty extraction, matching the Python engine's "indexed without symbols" path
 * when parsing fails.
 *
 * @param source  raw file bytes.
 * @param grammar wasm basename.
 * @param parser  a Parser already bound to `grammar` (from {@link getParser}).
 */
export function parseToTree(
  source: Buffer,
  parser: Parser,
): ParseHandle | null {
  let text: string;
  try {
    text = source.toString("utf-8");
  } catch {
    return null;
  }
  let tree;
  try {
    tree = parser.parse(text);
  } catch {
    return null;
  }
  if (tree === null) {
    return null;
  }
  return { root: tree.rootNode, text };
}

// ===========================================================================
// Shared walk helpers
// ===========================================================================

/**
 * 1-based line number of a node's start. node.startPosition.row is 0-based, so
 * +1 reproduces the engine's `span.start_line + 1`. Encoding-independent.
 */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * 1-based line number of a node's end (last line the node spans). Mirrors the
 * engine's `span.end_line + 1`, where the Rust processor's `span.end_line` is
 * the 0-based line of the node's LAST byte (inclusive).
 *
 * web-tree-sitter's `node.endPosition` is the EXCLUSIVE end — the position just
 * after the last byte. When a node's last byte is a line break, that exclusive
 * position lands at column 0 of the FOLLOWING line, so `endPosition.row` is one
 * line too high relative to the Rust inclusive convention. We detect that case
 * (column 0 on a non-empty node) and report the line of the last byte instead,
 * matching the oracle. On well-formed code the last byte is a `}`/identifier
 * (column > 0), so this only ever fires on error-recovery nodes whose missing
 * closing brace lets them run past a trailing newline.
 */
export function endLineOf(node: Node): number {
  if (node.endPosition.column === 0 && node.endIndex > node.startIndex) {
    return node.endPosition.row;
  }
  return node.endPosition.row + 1;
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

/** Length of `s` in CODE POINTS (Python len(str)). */
function _lenCodepoints(s: string): number {
  let n = 0;
  for (const _ of s) {
    n += 1;
  }
  return n;
}

/**
 * Build a declaration signature by slicing the DECODED STRING between two node
 * start indices (UTF-16 units), trimming, and truncating to 200 code points —
 * the string-based analogue of common.ts's build_signature.
 *
 * The engine computes `source_bytes[item.span.start_byte : body.span.start_byte]`
 * (UTF-8 byte slice), trims, truncates to 200 codepoints. Slicing the decoded
 * string by web-tree-sitter's UTF-16 startIndex values yields the SAME visible
 * characters, so the result is byte-identical to the oracle for ASCII and
 * multi-byte source alike. Returns null when the body node is absent (an
 * un-bodied declaration), matching build_signature(body_span=None) -> None.
 *
 * @param text       the full decoded source string (from {@link ParseHandle}).
 * @param item       the declaration node (signature starts at its startIndex).
 * @param body       the body node (signature ends at its startIndex), or null.
 */
export function build_signature_str(
  text: string,
  item: Node,
  body: Node | null,
): string | null {
  if (body === null) {
    return null;
  }
  const startIdx = item.startIndex;
  const endIdx = body.startIndex;
  if (startIdx === undefined || endIdx === undefined) {
    return null;
  }
  let sig = text.slice(startIdx, endIdx).trim();
  if (_lenCodepoints(sig) > 200) {
    sig = _sliceCodepoints(sig, 200);
  }
  return sig || null;
}

/** Build the `(name, line)` tuple key used by the dedup sets (string form). */
export function symbolKey(name: string, line: number): string {
  return `${name}\n${line}`;
}

/**
 * A configurable, generic structure-walk scaffold. Adapters describe their
 * language with node-type predicates; this walks the tree once, depth-first in
 * document order, emitting a Symbol per declaration with the correct parent
 * chain — the faithful reproduction of the Rust processor's structure pass.
 *
 * The processor descends through arbitrary container statements (if / try /
 * with / module / block) WITHOUT changing the parent, and only sets a new
 * parent when crossing a function/class boundary. Decorator wrappers are
 * transparent: the walk recurses into the wrapped definition, which keeps the
 * wrapper's parent (so the start line reported is the inner `def`/`class` line;
 * a separate decorator post-pass extends it back over `@` lines).
 */
export interface WalkConfig {
  /**
   * Map a declaration node to its emitted [name, kind] pair, or null if the
   * node is not a declaration the adapter emits. Receives the node and its
   * current parent name (so a kind can be promoted, e.g. function->method when
   * nested). The returned `kind` is the FINAL kind string.
   */
  classify: (node: Node, parentName: string | null) => { name: string; kind: string } | null;
  /**
   * Given a declaration node, return the node whose start index ends the
   * signature (typically the body block), or null for un-bodied declarations.
   */
  bodyOf: (node: Node) => Node | null;
  /**
   * Given a declaration node, return the node to use as the new parent NAME's
   * source and the subtree to recurse into for nested declarations. By default
   * the walk recurses into the same node's named children; override `childrenOf`
   * to redirect (e.g. into the body block only). Most languages can recurse
   * over all named children safely because only declaration nodes emit.
   */
  childrenOf?: (node: Node) => Node[];
  /**
   * When a declaration node emits, this is the parent name handed to its
   * descendants. Defaults to the emitted name. (Decorator wrappers, which do
   * NOT emit, never call this — they just pass the current parent through.)
   */
  isDeclaration?: (node: Node) => boolean;
}

/**
 * Default children accessor: all named children. Adapters whose grammar nests
 * non-declaration nodes that must NOT be descended can override childrenOf.
 */
function _defaultChildren(node: Node): Node[] {
  const out: Node[] = [];
  for (const c of node.namedChildren) {
    if (c !== null) {
      out.push(c);
    }
  }
  return out;
}

/**
 * Walk `root` with `cfg`, appending Symbols to `symbols` (deduped on (name,
 * line) via `seenNames`). `text` is the decoded source for signature slicing.
 *
 * Depth-first, document order. For each node:
 *  - classify(node, parent): if it returns a declaration, emit the Symbol
 *    (with signature from build_signature_str(text, node, bodyOf(node))) and
 *    recurse into its children with the emitted name as the new parent.
 *  - otherwise recurse into its children with the SAME parent (container /
 *    decorator-wrapper pass-through).
 */
export function walkStructure(
  root: Node,
  text: string,
  symbols: Symbol[],
  seenNames: Set<string>,
  cfg: WalkConfig,
): void {
  const childrenOf = cfg.childrenOf ?? _defaultChildren;

  const visit = (node: Node, parentName: string | null): void => {
    const cls = cfg.classify(node, parentName);
    if (cls !== null) {
      const line = lineOf(node);
      const end_line = endLineOf(node);
      const body = cfg.bodyOf(node);
      const sig = build_signature_str(text, node, body);
      const key = symbolKey(cls.name, line);
      if (!seenNames.has(key)) {
        seenNames.add(key);
        symbols.push(
          new Symbol({
            name: cls.name,
            kind: cls.kind,
            line,
            end_line,
            signature: sig,
            parent_name: parentName,
          }),
        );
      }
      // Recurse into this declaration with its name as the new parent.
      for (const child of childrenOf(node)) {
        visit(child, cls.name);
      }
      return;
    }
    // Non-declaration (container or decorator wrapper): pass parent through.
    for (const child of childrenOf(node)) {
      visit(child, parentName);
    }
  };

  visit(root, null);
}

/**
 * Walk `root` collecting nodes whose type is in `importTypes`, in document
 * order, and hand each to `onImport(node)`. The faithful analogue of the
 * engine's import pass (which surfaces each import statement as one ImportInfo
 * with `.source` = the full statement text). Adapters parse the per-name
 * targets from node.text themselves.
 */
export function walkImports(
  root: Node,
  importTypes: ReadonlySet<string>,
  onImport: (node: Node) => void,
): void {
  const visit = (node: Node): void => {
    if (importTypes.has(node.type)) {
      onImport(node);
    }
    for (const c of node.namedChildren) {
      if (c !== null) {
        visit(c);
      }
    }
  };
  visit(root);
}
