/**
 * PHP symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful port of src/token_goat/languages/php.py. Strict NodeNext ESM.
 *
 * -----
 * Two passes, exactly like php.py
 * -----
 * php.py is a HYBRID: extract() first runs the OPAQUE Rust engine via
 * common.collect_symbols_and_refs(source, "php", …) (structure + symbol + ref
 * passes over the tree-sitter AST), THEN appends a regex post-pass
 * (_extract_php_symbols) that surfaces the constructs the engine omits
 * (namespace / use / require / class-const / property / trait / global const /
 * define). The two passes share one seen_names dedup set, so a regex symbol that
 * lands on the SAME (name, line) as an engine symbol is suppressed.
 *
 * This adapter reproduces:
 *  - PASS 1 (engine) by walking the raw web-tree-sitter AST with the shared
 *    ts_engine.walkStructure scaffold + extract_refs_from_source. The engine's
 *    PHP structure pass emits ONLY these declaration nodes:
 *        function_definition  -> function
 *        method_declaration   -> method
 *        class_declaration    -> class
 *        interface_declaration-> interface
 *        enum_declaration     -> enum
 *    and sets parent_name for descendants = the node's own name. It does NOT
 *    treat trait_declaration / namespace_definition as declarations: it descends
 *    through them transparently (so a method inside a trait reports the trait's
 *    ENCLOSING parent, typically null — verified against the oracle). PHP does
 *    NOT promote functions to methods, so a function nested in a function/method
 *    keeps kind "function" with the enclosing name as parent. The engine emits
 *    NO imports for PHP (all imports come from the regex pass below).
 *  - PASS 2 (regex) by a faithful line-scan port of _extract_php_symbols_inner:
 *    block-comment + brace-depth context tracking, the same compiled patterns,
 *    and common.make_add_fn (end_line = line, signature truncated to 200 cp).
 *
 * Signatures (engine pass) are sliced from the declaration node start to its
 * `body` field start (build_signature_str, UTF-16-unit slice == oracle's UTF-8
 * byte slice for the visible characters). Un-bodied declarations (abstract /
 * interface methods) -> null, matching build_signature(body=None).
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

const _LOG = getLogger("languages.php");

// ===========================================================================
// Call-site ref noise filter — port of php.py _CALL_NOISE
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "if", "else", "elseif", "while", "for", "foreach", "switch", "case",
  "do", "break", "continue", "return", "yield", "throw", "try", "catch",
  "finally", "match", "echo", "print", "die", "exit",
  "isset", "empty", "unset", "list", "array", "null", "true", "false",
  "new", "clone", "instanceof", "class", "interface", "trait", "enum",
  "extends", "implements", "abstract", "final", "static", "public",
  "protected", "private", "function", "fn", "namespace", "use", "as",
  "require", "require_once", "include", "include_once",
  "self", "parent", "this",
  "count", "strlen", "str_replace", "sprintf", "printf",
  "array_map", "array_filter", "array_push", "array_pop",
  "in_array", "array_key_exists", "array_merge", "array_values",
  "implode", "explode", "trim", "strtolower", "strtoupper",
  "intval", "strval", "floatval", "boolval",
  "var_dump", "print_r", "var_export",
]);

// ===========================================================================
// PASS 1 — engine structure walk (web-tree-sitter)
// ===========================================================================

/**
 * Declaration node types the PHP engine's structure pass emits, and their base
 * kind. trait_declaration / namespace_definition are deliberately ABSENT: the
 * engine descends through them as transparent containers (their child methods
 * therefore inherit the enclosing parent, not the trait/namespace name).
 */
const _DEF_KIND: Record<string, string> = {
  function_definition: "function",
  method_declaration: "method",
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
};

/**
 * Classify a node as a PHP declaration. Returns null for any non-declaration
 * node (the walk then recurses with the SAME parent — container pass-through).
 *
 * PHP does NOT promote functions to methods (no promote_methods): a
 * function_definition nested inside a function/method/class keeps kind
 * "function" and records the enclosing name as parent_name. method_declaration
 * already carries kind "method" directly.
 */
function _classify(node: Node): { name: string; kind: string } | null {
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
  return { name, kind: baseKind };
}

/**
 * Body node ending the signature slice (field "body"): compound_statement for
 * functions/methods, declaration_list for class/interface, enum_declaration_list
 * for enums. Absent for abstract / interface methods -> signature null.
 */
function _bodyOf(node: Node): Node | null {
  return node.childForFieldName("body");
}

const _WALK_CONFIG: WalkConfig = {
  classify: _classify,
  bodyOf: _bodyOf,
};

// ===========================================================================
// PASS 2 — regex post-pass (port of php.py _extract_php_symbols_inner)
// ===========================================================================

// Namespace declaration: namespace App\Models;
// Python `\w` is Unicode-aware (matches str.isalnum()+underscore, e.g. `é`),
// whereas JS `\w` is ASCII-only — spell the word class as `[\p{L}\p{N}_]` with
// the `u` flag so multibyte namespace/use targets (Café\Münü) match identically.
const _NAMESPACE_RE = /^namespace\s+([\p{L}\p{N}_\\]+)\s*;/u;

// Class/interface/trait/enum declaration.
const _CLASS_RE =
  /^(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;

// Method/function declaration.
const _METHOD_RE =
  /^(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

// Arrow/anonymous functions are noise — skip lines that define them without a name.
const _ANON_FN_RE = /^\s*function\s*\(/;

// Constant declaration: const FOO = ... or define('FOO', ...).
const _CONST_RE =
  /^(?:(?:public|protected|private|static)\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)/;
const _DEFINE_RE = /^define\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/;

// Property declaration: public/protected/private $name.
const _PROP_RE =
  /^(?:(?:public|protected|private|static|readonly)\s+)+\??[A-Za-z_][A-Za-z0-9_|\\]*\s+\$([A-Za-z_][A-Za-z0-9_]*)/;

// use statement: use Namespace\Class [as Alias]. Unicode `\w` -> `[\p{L}\p{N}_]`.
const _USE_RE = /^use\s+([\p{L}\p{N}_\\]+)(?:\s+as\s+[\p{L}\p{N}_]+)?\s*;/u;

// require/include
const _REQUIRE_RE = /^(?:require|include)(?:_once)?\s+['"]([^'"]+)['"]/;

// ---------------------------------------------------------------------------
// Python string-semantics helpers (str.splitlines / str.rstrip / str.lstrip)
// ---------------------------------------------------------------------------

/**
 * Codepoints Python str.strip()/lstrip()/rstrip() remove by default
 * (str.isspace()): ASCII whitespace plus the Unicode separators Python treats
 * as whitespace. Mirrors cpp.ts's _PY_WS.
 */
const _PY_WS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python str.rstrip() with the default whitespace class. */
function _pyRStrip(s: string): string {
  let end = s.length;
  while (end > 0 && _PY_WS.has(s.codePointAt(end - 1)!)) {
    end -= 1;
  }
  return s.slice(0, end);
}

/** Python str.lstrip() with the default whitespace class. */
function _pyLStrip(s: string): string {
  let start = 0;
  while (start < s.length && _PY_WS.has(s.codePointAt(start)!)) {
    start += 1;
  }
  return s.slice(start);
}

/**
 * Reproduce Python str.splitlines() (no keepends): split on the full Python
 * line-boundary set and yield no empty trailing element after a final
 * separator. Mirrors cpp.ts's _pySplitlines.
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
      cp === 0x0a ||
      cp === 0x0b ||
      cp === 0x0c ||
      cp === 0x1c ||
      cp === 0x1d ||
      cp === 0x1e ||
      cp === 0x85 ||
      cp === 0x2028 ||
      cp === 0x2029
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

/** Count non-overlapping occurrences of `sub` in `s` (Python str.count). */
function _count(s: string, sub: string): number {
  if (sub === "") {
    return s.length + 1;
  }
  let n = 0;
  let idx = 0;
  for (;;) {
    const found = s.indexOf(sub, idx);
    if (found === -1) {
      break;
    }
    n += 1;
    idx = found + sub.length;
  }
  return n;
}

/**
 * Inner regex symbol pass (wrapped by {@link _extract_php_symbols} via
 * safe_regex_parse). Faithful port of php.py _extract_php_symbols_inner: a
 * line-by-line scan with block-comment + brace-depth context tracking that
 * appends the constructs the engine omits. `seen` is the SHARED dedup set so
 * symbols already emitted by the engine pass (same name+line) are suppressed.
 *
 * Returns [extraSymbols, extraImports].
 */
function _extract_php_symbols_inner(
  source: Buffer,
  seen: Set<string>,
): [Symbol[], ImpExp[]] {
  const symbols: Symbol[] = [];
  const imp_exp: ImpExp[] = [];

  const text = source.toString("utf-8");
  const lines = _pySplitlines(text);

  // Context tracking: stack of [class_name, brace_depth_at_entry].
  const context_stack: Array<[string, number]> = [];
  let brace_depth = 0;
  let in_comment = false;

  const currentClass = (): string | null =>
    context_stack.length > 0 ? (context_stack[context_stack.length - 1] as [string, number])[0] : null;

  const add = common.make_add_fn(symbols, seen);

  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const i = idx0 + 1; // 1-based line number (Python enumerate(..., 1))
    const raw_line = lines[idx0] as string;
    const line = _pyRStrip(raw_line);
    const stripped = _pyLStrip(line);

    // Block comment handling.
    if (stripped.includes("/*") && !in_comment) {
      in_comment = true;
    }
    if (stripped.includes("*/")) {
      in_comment = false;
      continue;
    }
    if (in_comment) {
      continue;
    }

    // Skip single-line comments and empty lines.
    if (stripped === "" || stripped.startsWith("//") || stripped.startsWith("#")) {
      continue;
    }

    // Track brace depth for class context.
    const open_b = _count(line, "{") - _count(line, "\\{");
    const close_b = _count(line, "}") - _count(line, "\\}");
    brace_depth += open_b;

    // Pop context stack when we close the class brace.
    while (
      context_stack.length > 0 &&
      brace_depth <= (context_stack[context_stack.length - 1] as [string, number])[1]
    ) {
      context_stack.pop();
    }

    brace_depth -= close_b;

    // Namespace.
    const ns_m = _NAMESPACE_RE.exec(stripped);
    if (ns_m !== null) {
      add(ns_m[1] as string, "namespace", i, stripped.slice(0, 200));
      continue;
    }

    // use statement (import).
    const use_m = _USE_RE.exec(stripped);
    if (use_m !== null) {
      imp_exp.push(new ImpExp({ kind: "import", target: use_m[1] as string, line: i }));
      continue;
    }

    // require/include.
    const req_m = _REQUIRE_RE.exec(stripped);
    if (req_m !== null) {
      imp_exp.push(new ImpExp({ kind: "import", target: req_m[1] as string, line: i }));
      continue;
    }

    // Class/interface/trait/enum.
    const cls_m = _CLASS_RE.exec(stripped);
    if (cls_m !== null) {
      const name = cls_m[1] as string;
      // Python: "interface"/"trait"/"enum" in stripped.split(name)[0]
      const before = stripped.split(name)[0] as string;
      const is_interface = before.includes("interface");
      const is_trait = before.includes("trait");
      const is_enum = before.includes("enum");
      let kind: string;
      if (is_interface) {
        kind = "interface";
      } else if (is_trait) {
        kind = "trait";
      } else if (is_enum) {
        kind = "enum";
      } else {
        kind = "class";
      }
      const parent = currentClass();
      add(name, kind, i, stripped.slice(0, 200), parent);
      // Push context at current brace depth (entry brace not yet counted for this line).
      context_stack.push([name, brace_depth - open_b]);
      continue;
    }

    // Anonymous function — skip.
    if (_ANON_FN_RE.exec(stripped) !== null) {
      continue;
    }

    // Method/function.
    const meth_m = _METHOD_RE.exec(stripped);
    if (meth_m !== null) {
      const name = meth_m[1] as string;
      const parent = currentClass();
      const kind = parent ? "method" : "function";
      const sig_end = stripped.indexOf(")");
      const sig = sig_end >= 0 ? stripped.slice(0, sig_end + 1) : stripped;
      add(name, kind, i, sig.slice(0, 200), parent);
      continue;
    }

    // Property.
    const prop_m = _PROP_RE.exec(stripped);
    if (prop_m !== null) {
      const name = prop_m[1] as string;
      const parent = currentClass();
      if (parent) {
        add(name, "var", i, stripped.slice(0, 200), parent);
      }
      continue;
    }

    // Class constant.
    const const_m = _CONST_RE.exec(stripped);
    if (const_m !== null) {
      const name = const_m[1] as string;
      const parent = currentClass();
      add(name, "const", i, stripped.slice(0, 200), parent);
      continue;
    }

    // Global define().
    const define_m = _DEFINE_RE.exec(stripped);
    if (define_m !== null) {
      add(define_m[1] as string, "const", i, stripped.slice(0, 200));
      continue;
    }
  }

  return [symbols, imp_exp];
}

/** safe_regex_parse wrapper around {@link _extract_php_symbols_inner}. */
function _extract_php_symbols(
  source: Buffer,
  seen: Set<string>,
): [Symbol[], ImpExp[]] {
  return common.safe_regex_parse<[Symbol[], ImpExp[]]>(
    (...args: unknown[]) =>
      _extract_php_symbols_inner(args[0] as Buffer, args[1] as Set<string>),
    [source, seen],
    { log: _LOG, label: "_extract_php_symbols", empty: [[], []] },
  );
}

// ===========================================================================
// extract
// ===========================================================================

/**
 * Extract symbols, refs, and imports from a PHP source file.
 *
 * Mirrors php.py extract: PASS 1 (engine structure walk + call-site refs) then
 * PASS 2 (regex post-pass) merged via the shared seen_names dedup set. Imports
 * come entirely from the regex pass (the engine emits none for PHP). Sections
 * are always empty for PHP.
 *
 * `parser` must be a Parser already bound to the php grammar (built once by
 * getExtractor).
 */
function _extract(
  parser: Awaited<ReturnType<typeof getParser>>,
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const symbols: Symbol[] = [];
  const imp_exp: ImpExp[] = [];
  const seen_names: Set<string> = new Set();
  let refs: Ref[] = [];

  // --- PASS 1: engine structure + ref passes (degrades to empty on failure) ---
  const handle = parseToTree(source, parser);
  if (handle !== null) {
    walkStructure(handle.root, handle.text, symbols, seen_names, _WALK_CONFIG);
    refs = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);
  } else {
    _LOG.debug("php: parse failed for %s — engine pass skipped", rel_path);
  }

  // --- PASS 2: regex post-pass (extra symbols + all imports) ---
  const [extra_syms, extra_imports] = _extract_php_symbols(source, seen_names);
  for (const s of extra_syms) {
    symbols.push(s);
  }
  for (const im of extra_imports) {
    imp_exp.push(im);
  }

  _LOG.debug(
    "php extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );
  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the PHP extractor.
 *
 * Awaits Parser.init() + the php grammar load (via ts_engine.getParser), then
 * returns a SYNCHRONOUS extract(source, rel) closure. get_extractor (parser.ts)
 * awaits this; index_file stays synchronous thereafter.
 */
export async function getExtractor(): Promise<Extractor> {
  const parser = await getParser("php");
  return (source: Buffer, rel_path: string) => _extract(parser, source, rel_path);
}
