/**
 * Kotlin symbol extractor using regex-based heuristics.
 *
 * Faithful port of src/token_goat/languages/kotlin.py. Strict NodeNext ESM.
 *
 * -----
 * Why this adapter is regex-driven, NOT tree-sitter
 * -----
 * Unlike python/ruby/go/etc., the Kotlin Python adapter does NOT call the opaque
 * Rust processor (tree_sitter_language_pack.process) at all — kotlin.py extracts
 * classes/interfaces/objects/enums, functions, methods, properties, and imports
 * entirely by regex against the raw source bytes. The ORACLE (ground truth) runs
 * kotlin.py, so this port reproduces that regex pipeline bit-for-bit and does NOT
 * load a tree-sitter grammar. getExtractor stays async only to satisfy the
 * parser.ts grammar-adapter contract (get_extractor awaits it); the returned
 * extract closure is fully synchronous and grammar-free.
 *
 * -----
 * Pipeline (matching kotlin.py extract)
 * -----
 *  1. _extract_kotlin_symbols — line-by-line scan tracking brace depth. A
 *     column-0 class/interface/object/enum header opens a "current class"; inside
 *     it (depth_in_class >= 1) indented `fun` declarations become methods and
 *     ALL-CAPS `val`/`const val` declarations become consts (parent_name =
 *     current class). At column 0 outside any class, a top-level `fun` becomes a
 *     function. The current class closes when brace_depth falls back to its
 *     opening level. Wrapped in common.safe_regex_parse so a malformed pattern
 *     never aborts extraction.
 *  2. refs via common.extract_refs_from_source(CALL_RE) minus _CALL_NOISE.
 *  3. _extract_kotlin_imports — one ImpExp per `import x.y.z` (or `.*`) line.
 *
 * Sections are always empty for Kotlin.
 *
 * -----
 * Fidelity notes (verified against the oracle)
 * -----
 *  - Lines come from Python str.splitlines() (drops a trailing empty element);
 *    the local _splitlines reproduces that. Symbol line numbers are 1-based.
 *  - is_indented := line[:1] in (" ", "\t"). Class headers only match at column 0
 *    (is_indented false); methods/consts only match inside a class at depth>=1.
 *  - Signatures truncate to 200 CODE POINTS (Python s[:200]); _sliceCodepoints
 *    reproduces that (a JS .slice would cut UTF-16 units and could split an astral
 *    pair). The method signature is line[:line.find("{")].strip() when a "{" is
 *    present, else line.rstrip(); an empty result becomes null. The const
 *    signature is line.strip()[:200]; the top-level-fun signature matches the
 *    method rule. The class signature is line.rstrip()[:200].
 *  - end_line always equals line (single-line heuristics).
 */

import type { Extractor, Ref, Section } from "../parser.js";
import { ImpExp, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";

const _LOG = getLogger("languages.kotlin");

// ===========================================================================
// Call-site ref noise filter — port of kotlin.py _CALL_NOISE
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "if", "for", "while", "when", "return", "throw", "try", "catch", "finally",
  "is", "as", "in", "by", "to", "and", "or", "not", "also", "let", "run",
  "apply", "with", "takeIf", "takeUnless", "repeat",
  "println", "print", "error", "check", "require",
  "Int", "Long", "Double", "Float", "Boolean", "Char", "Byte", "Short", "String",
  "Unit", "Any", "Nothing", "Pair", "Triple",
  "List", "Map", "Set", "Array", "MutableList", "MutableMap", "MutableSet",
  "listOf", "mapOf", "setOf", "arrayOf", "mutableListOf", "mutableMapOf",
  "emptyList", "emptyMap", "emptySet",
  "null", "true", "false", "it", "this", "super",
  "get", "set", "add", "remove", "size", "isEmpty", "contains",
  "equals", "hashCode", "toString", "copy", "component1", "component2",
]);

// ===========================================================================
// Regex tables — ports of kotlin.py module-level patterns
// ===========================================================================

// Python re.compile patterns are anchored via `.match` (start-of-string). The
// JS ports below all start with `^` and are matched via _matchAtStart (a sticky
// clone forced to index 0), reproducing Python `.match` semantics.

/** `^import\s+(<qualified-name>(.*)?)`. */
const _IMPORT_RE =
  /^import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)/;

/** Function declaration (any modifiers), used for methods inside a class. */
const _FUN_RE =
  /^\s*(?:(?:public|internal|protected|private|open|override|abstract|suspend|inline|infix|operator|external|actual|expect|final|sealed)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/;

/** ALL-CAPS `val` / `const val` constant (indented; inside a class). */
const _CONST_RE =
  /^\s+(?:(?:public|internal|protected|private|open|override|abstract|final|actual|expect|const|lateinit|companion)\s+)*(?:const\s+)?val\s+([A-Z_][A-Z0-9_]*)\s*(?::|=)/;

/** Column-0 class / interface / object / enum class header. */
const _CLASS_HEADER_RE =
  /^(?:(?:public|internal|protected|private|open|abstract|sealed|data|inner|expect|actual|value|annotation)\s+)*(?:class|interface|object|enum\s+class)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** Top-level function (subset of modifiers; column 0). */
const _TOP_FUN_RE =
  /^(?:(?:public|internal|private|suspend|inline|infix|operator|external|actual|expect)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/;

// ===========================================================================
// String helpers (Python parity)
// ===========================================================================

/**
 * Reproduce Python str.splitlines() for the `\n`-delimited case: split on "\n"
 * and drop a single trailing empty element (Python yields no empty final line
 * after a terminating newline). Call sites here feed plain decoded text.
 */
function _splitlines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
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

/** Count occurrences of `ch` (single char) in `s` (Python str.count(ch)). */
function _count(s: string, ch: string): number {
  let n = 0;
  let idx = s.indexOf(ch);
  while (idx !== -1) {
    n += 1;
    idx = s.indexOf(ch, idx + 1);
  }
  return n;
}

/** Python str.strip(): strip ASCII + Unicode whitespace from both ends. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.rstrip(): strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/**
 * Match a `^`-anchored pattern at the START of `s` (Python re.Pattern.match).
 * Clones the pattern with a sticky flag so it only matches at index 0.
 */
function _matchAtStart(pattern: RegExp, s: string): RegExpMatchArray | null {
  const flags = pattern.flags.replace(/[gy]/g, "") + "y";
  const re = new RegExp(pattern.source, flags);
  re.lastIndex = 0;
  return re.exec(s);
}

// ===========================================================================
// Symbol extraction
// ===========================================================================

/**
 * Inner symbol pass (wrapped by {@link _extract_kotlin_symbols} via
 * common.safe_regex_parse). Faithful port of kotlin.py
 * _extract_kotlin_symbols_inner: brace-depth-tracking line scan emitting
 * classes (column 0), methods + ALL-CAPS consts (inside a class), and top-level
 * functions (column 0, outside any class).
 */
function _extract_kotlin_symbols_inner(source: Buffer): Symbol[] {
  const symbols: Symbol[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);

  let current_class: string | null = null;
  let class_brace_depth = 0;
  let brace_depth = 0;

  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const i = idx0 + 1; // 1-based line number (Python enumerate(lines, 1))
    const line = lines[idx0] as string;
    const stripped = _strip(line);
    if (!stripped || stripped.startsWith("//")) {
      brace_depth += _count(line, "{") - _count(line, "}");
      continue;
    }

    const first = line.slice(0, 1);
    const is_indented = first === " " || first === "\t";

    const cm = is_indented ? null : _matchAtStart(_CLASS_HEADER_RE, line);
    if (cm) {
      const cname = cm[1] as string;
      symbols.push(
        new Symbol({
          name: cname,
          kind: "class",
          line: i,
          end_line: i,
          signature: _sliceCodepoints(_rstrip(line), 200),
        }),
      );
      current_class = cname;
      class_brace_depth = brace_depth;
    }

    if (current_class !== null) {
      const depth_in_class = brace_depth - class_brace_depth;
      if (depth_in_class >= 1) {
        const fm = _matchAtStart(_FUN_RE, line);
        if (fm) {
          const fname = fm[1] as string;
          const sig_end = line.indexOf("{");
          const sig = sig_end >= 0 ? _strip(line.slice(0, sig_end)) : _rstrip(line);
          symbols.push(
            new Symbol({
              name: fname,
              kind: "method",
              line: i,
              end_line: i,
              signature: sig ? _sliceCodepoints(sig, 200) : null,
              parent_name: current_class,
            }),
          );
        }

        const const_m = _matchAtStart(_CONST_RE, line);
        if (const_m) {
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
      }
    } else if (!is_indented) {
      const tfm = _matchAtStart(_TOP_FUN_RE, line);
      if (tfm) {
        const fname = tfm[1] as string;
        const sig_end = line.indexOf("{");
        const sig = sig_end >= 0 ? _strip(line.slice(0, sig_end)) : _rstrip(line);
        symbols.push(
          new Symbol({
            name: fname,
            kind: "function",
            line: i,
            end_line: i,
            signature: sig ? _sliceCodepoints(sig, 200) : null,
          }),
        );
      }
    }

    brace_depth += _count(line, "{") - _count(line, "}");

    if (current_class !== null && brace_depth <= class_brace_depth) {
      current_class = null;
    }
  }

  return symbols;
}

/** safe_regex_parse wrapper around {@link _extract_kotlin_symbols_inner}. */
function _extract_kotlin_symbols(source: Buffer): Symbol[] {
  return common.safe_regex_parse<Symbol[]>(
    (...args: unknown[]) => _extract_kotlin_symbols_inner(args[0] as Buffer),
    [source],
    { log: _LOG, label: "_extract_kotlin_symbols", empty: [] },
  );
}

// ===========================================================================
// Imports
// ===========================================================================

/** Port of kotlin.py _extract_kotlin_imports: one ImpExp per `import` line. */
function _extract_kotlin_imports(source: Buffer): ImpExp[] {
  const imports: ImpExp[] = [];
  const text = source.toString("utf-8");
  const lines = _splitlines(text);
  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const i = idx0 + 1;
    const m = _matchAtStart(_IMPORT_RE, _strip(lines[idx0] as string));
    if (m) {
      imports.push(new ImpExp({ kind: "import", target: m[1] as string, line: i }));
    }
  }
  return imports;
}

// ===========================================================================
// extract / getExtractor
// ===========================================================================

/**
 * Extract symbols, refs, and imports from a Kotlin source file.
 *
 * Mirrors kotlin.py extract: regex symbol pass + call-site refs + import rows.
 * Sections are always empty. Synchronous (no grammar load).
 */
function _extract(source: Buffer, rel_path: string): [Symbol[], Ref[], ImpExp[], Section[]] {
  const symbols = _extract_kotlin_symbols(source);
  const refs: Ref[] = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);
  const imp_exp = _extract_kotlin_imports(source);

  _LOG.debug(
    "kotlin extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );
  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the Kotlin extractor.
 *
 * Async only to satisfy the grammar-adapter contract in parser.ts
 * (get_extractor awaits getExtractor); the returned closure is synchronous and
 * does NOT load any tree-sitter grammar — Kotlin extraction is pure regex.
 */
export async function getExtractor(): Promise<Extractor> {
  return (source: Buffer, rel_path: string) => _extract(source, rel_path);
}
