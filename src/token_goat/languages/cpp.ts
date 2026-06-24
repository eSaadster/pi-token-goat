/**
 * C and C++ symbol extractor (regex-based heuristics).
 *
 * Faithful port of src/token_goat/languages/cpp.py. Strict NodeNext ESM.
 *
 * -----
 * Why this is NOT a tree-sitter walk
 * -----
 * Unlike python.ts / the other GRAMMAR adapters (which reproduce the opaque
 * Rust processor by walking a web-tree-sitter AST), cpp.py is purely
 * REGEX-based: it never touches tree-sitter. It scans the source line by line
 * and applies a battery of compiled patterns (`#define`, `#include`,
 * function/struct/class/typedef/namespace/extern), reusing the shared
 * common.ts helpers (make_add_fn, extract_refs_from_source, CALL_RE). The C++
 * extractor (extract / "cpp" mode) handles templates, methods, and namespaces;
 * the C extractor (extract_c / "c" mode) shares the same symbol pipeline but
 * skips the C++-only namespace / class / method rules.
 *
 * The oracle (the project's .venv adapter) is therefore the Python regex
 * implementation itself; this port matches it field-for-field.
 *
 * -----
 * getExtractor shape
 * -----
 * parser.ts routes BOTH the `cpp` and `c` registry keys through
 * _grammar_importer("cpp"), which awaits this module's getExtractor() with no
 * argument. To stay faithful to BOTH Python entry points while exposing a
 * single zero-arg factory, getExtractor() returns the C++-mode extractor (the
 * documented oracle for this task). The C-mode extractor is exported as
 * {@link extract_c} and is reachable via {@link getExtractorC}; extract / the
 * cpp-mode closure is exported as {@link extract}. The async getExtractor()
 * requires no grammar load, so it resolves synchronously-after-await.
 *
 * -----
 * Python parity notes
 * -----
 *  - `raw_line.strip()` strips Unicode whitespace -> _pyStrip (matches
 *    str.strip()'s default whitespace class, incl. NBSP and the unicode
 *    spaces Python treats as whitespace for the ASCII-dominant inputs here we
 *    only need the common set, but we mirror str.strip()'s codepoint table).
 *  - `text.splitlines()` splits on \n \r \r\n \v \f \x1c-\x1e \x85
 *      and drops no trailing element beyond the final separator ->
 *    _pySplitlines.
 *  - `make_add_fn` truncates signatures to 200 code points; the Python call
 *    sites ALSO pre-slice `line[:200]` — the double truncation is harmless and
 *    reproduced here by passing the raw (untruncated-here) string into the
 *    common make_add_fn closure, which performs the 200-codepoint slice.
 */

import type { Extractor, Ref, Section, Symbol } from "../parser.js";
import { ImpExp } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";

const _LOG = getLogger("languages.cpp");

// ===========================================================================
// Call-site ref noise filter — port of cpp.py _CALL_NOISE
// ===========================================================================

const _CALL_NOISE: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "case", "return", "break", "continue", "goto",
  "sizeof", "typeof", "alignof", "decltype", "typeid",
  "new", "delete", "throw", "try", "catch",
  "this", "nullptr", "NULL", "true", "false",
  "int", "long", "short", "char", "double", "float", "void", "bool",
  "unsigned", "signed", "const", "static", "extern", "volatile", "inline",
  "auto", "register", "restrict",
  "printf", "fprintf", "sprintf", "snprintf", "scanf", "fscanf",
  "malloc", "calloc", "realloc", "free", "memcpy", "memset", "memmove",
  "strlen", "strcpy", "strncpy", "strcmp", "strncmp", "strcat", "strncat",
  "fopen", "fclose", "fread", "fwrite", "fgets", "fputs",
  "assert", "abort", "exit",
  "std", "endl", "cout", "cin", "cerr",
  "vector", "string", "map", "set", "pair", "list", "queue", "stack",
  "make_shared", "make_unique", "move", "forward",
  "begin", "end", "size", "empty", "push_back", "pop_back",
  "first", "second", "data", "find", "insert", "erase",
]);

// ===========================================================================
// Compiled patterns — direct ports of cpp.py module-level regexes
// ===========================================================================

// All-caps #define macro (2+ chars). Anchored at start (Python re.match).
// Python's `\b` is Unicode-aware: after the all-caps ASCII capture it requires
// the next char NOT be a word char (letter/digit/_ in ANY script). JS `\b` is
// ASCII-only even with `u`, so `NAÏVE` would wrongly capture `NA` (Ï is a word
// char in Python -> no boundary -> Python rejects the whole match). Spell the
// trailing boundary as a Unicode-aware negative lookahead with the `u` flag.
const _DEFINE_RE = /^#\s*define\s+([A-Z_][A-Z0-9_]{1,})(?![\p{L}\p{N}_])/u;

// #include statement.
const _INCLUDE_RE = /^#\s*include\s+[<"]([^>"]+)[>"]/;

// Function definition: return_type name(params) { — not extern, not inside a
// struct. Matches both C and C++ top-level/static functions. Faithful to the
// Python source pattern (nested optional groups preserved verbatim).
const _FUNC_DEF_RE =
  /^(?:static\s+|inline\s+|__attribute__\s*\([^)]*\)\s*)*(?:(?:unsigned|signed|long|short|const)\s+)*(?:[A-Za-z_][A-Za-z0-9_:*<>[\]]*(?:\s*\*+)?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*$/;

// C++ method outside class body: ClassName::method( pattern. Global so a
// finditer-style scan over the whole line finds the LAST occurrence.
const _CPP_SCOPE_RE = /([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_~]*)\s*\(/g;

// struct/class/enum declaration — named form: struct Foo { or typedef struct Foo {
const _STRUCT_RE = /^(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|;)/;
// closing brace typedef: } TypeName; (anonymous struct alias)
const _TYPEDEF_CLOSE_RE = /^\}\s*([A-Za-z_][A-Za-z0-9_]*)\s*;/;
// anonymous typedef struct/union/enum opening (no name before {)
const _ANON_TYPEDEF_RE = /^typedef\s+(?:struct|union|enum)\s*\{/;
const _CLASS_RE = /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:{]|$)/;

// extern function declaration
const _EXTERN_RE = /^extern\s+(?:[A-Za-z_][A-Za-z0-9_\s*]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*;/;

// typedef to a name: typedef ... OldName NewName;
const _TYPEDEF_RE = /^typedef\s+.+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/;

// namespace declaration (C++ only)
const _NAMESPACE_RE = /^namespace\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|$)/;

// Lines that should not be mistaken for function defs.
const _NOT_FUNC = /\bif\b|\bfor\b|\bwhile\b|\bswitch\b|\bdo\b|^\s*#|\bextern\b|^\s*\/\//;

// ===========================================================================
// Python string-semantics helpers
// ===========================================================================

/**
 * Codepoints Python str.strip() removes by default (str.isspace()). Covers
 * ASCII whitespace plus the Unicode separators Python treats as whitespace.
 */
const _PY_WS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python str.strip() with the default whitespace class. */
function _pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && _PY_WS.has(s.codePointAt(start)!)) {
    start += 1;
  }
  while (end > start && _PY_WS.has(s.codePointAt(end - 1)!)) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Python str.rstrip() with the default whitespace class. */
function _pyRStrip(s: string): string {
  let end = s.length;
  while (end > 0 && _PY_WS.has(s.codePointAt(end - 1)!)) {
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * Reproduce Python str.splitlines() (no keepends). Splits on the full Python
 * line-boundary set and yields no empty trailing element after a final
 * separator. Matches the boundary table CPython uses for str.splitlines.
 */
function _pySplitlines(text: string): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    // \r\n is a single boundary.
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

/** Match a non-global pattern anchored at string start (Python re.match). */
function _match(pattern: RegExp, s: string): RegExpMatchArray | null {
  return pattern.exec(s);
}

/** Test whether a non-anchored pattern matches anywhere (Python re.search). */
function _search(pattern: RegExp, s: string): boolean {
  return pattern.test(s);
}

// ===========================================================================
// Symbol extraction
// ===========================================================================

/**
 * Inner symbol pass (wrapped by {@link _extract_symbols} via safe_regex_parse).
 * Faithful port of cpp.py _extract_symbols_inner: scans every line and emits a
 * Symbol per matched construct. `language` is "cpp" or "c" and only gates the
 * namespace / class / out-of-class-method rules.
 */
function _extract_symbols_inner(source: Buffer, language: string): Symbol[] {
  const symbols: Symbol[] = [];
  const seen: Set<string> = new Set();
  const text = source.toString("utf-8");
  const lines = _pySplitlines(text);
  const n = lines.length;
  let in_comment = false;
  // Track anonymous typedef struct start lines: } TypeName; needs the start line.
  const anon_typedef_starts: number[] = [];

  const add = common.make_add_fn(symbols, seen);

  for (let idx0 = 0; idx0 < n; idx0++) {
    const i = idx0 + 1; // 1-based line number (Python enumerate(..., 1))
    const raw_line = lines[idx0] as string;
    const line = _pyStrip(raw_line);

    // block comment tracking (simple heuristic)
    if (line.includes("/*") && !in_comment) {
      in_comment = true;
    }
    if (line.includes("*/")) {
      in_comment = false;
      continue;
    }
    if (in_comment || line.startsWith("//")) {
      continue;
    }

    // #define macros (all-caps only)
    const def_m = _match(_DEFINE_RE, raw_line);
    if (def_m !== null) {
      const name = def_m[1] as string;
      if (name.length >= 2) {
        add(name, "const", i, _pyRStrip(raw_line).slice(0, 200));
      }
      continue;
    }

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    // closing brace typedef: } TypeName;  (anonymous struct pattern)
    const close_m = _match(_TYPEDEF_CLOSE_RE, line);
    if (close_m !== null) {
      const name = close_m[1] as string;
      const start_line = anon_typedef_starts.length > 0
        ? (anon_typedef_starts.pop() as number)
        : i;
      add(name, "type", start_line, line.slice(0, 200));
      continue;
    }

    // namespace (C++ only)
    if (language === "cpp") {
      const ns_m = _match(_NAMESPACE_RE, line);
      if (ns_m !== null) {
        add(ns_m[1] as string, "const", i, line.slice(0, 200));
        continue;
      }
    }

    // anonymous typedef struct { — track start line for closing-brace resolution
    if (_match(_ANON_TYPEDEF_RE, line) !== null) {
      anon_typedef_starts.push(i);
      continue;
    }

    // struct/union/enum
    const st_m = _match(_STRUCT_RE, line);
    if (st_m !== null) {
      add(st_m[1] as string, "type", i, line.slice(0, 200));
      continue;
    }

    // class (C++ only)
    if (language === "cpp") {
      const cl_m = _match(_CLASS_RE, line);
      if (cl_m !== null) {
        // Python: "(" not in line[:line.find("{")+1 if "{" in line else len(line)]
        const sliceEnd = line.includes("{") ? line.indexOf("{") + 1 : line.length;
        const head = line.slice(0, sliceEnd);
        if (!head.includes("(")) {
          const name = cl_m[1] as string;
          if (name !== "if" && name !== "for" && name !== "while" && name !== "switch") {
            add(name, "class", i, line.slice(0, 200));
            continue;
          }
        }
      }
    }

    // typedef alias (not typedef struct/union/enum — those are caught above)
    if (
      line.startsWith("typedef") &&
      !line.includes("struct") &&
      !line.includes("union") &&
      !line.includes("enum")
    ) {
      const td_m = _match(_TYPEDEF_RE, line);
      if (td_m !== null) {
        add(td_m[1] as string, "type", i, line.slice(0, 200));
        continue;
      }
    }

    // extern function declaration
    const ext_m = _match(_EXTERN_RE, line);
    if (ext_m !== null) {
      add(ext_m[1] as string, "function", i, line.slice(0, 200));
      continue;
    }

    // C++ out-of-class method ClassName::method(
    if (
      language === "cpp" &&
      line.includes("::") &&
      !_search(_NOT_FUNC, raw_line) &&
      !line.includes(";")
    ) {
      const scope_matches = _findAll(_CPP_SCOPE_RE, line);
      if (scope_matches.length > 0) {
        const last_m = scope_matches[scope_matches.length - 1] as RegExpMatchArray;
        const class_name = last_m[1] as string;
        const method_name = last_m[2] as string;
        if (!_CALL_NOISE.has(method_name)) {
          const sig_end = line.indexOf("{");
          const sig = sig_end >= 0 ? _pyRStrip(line.slice(0, sig_end)) : _pyRStrip(line);
          add(method_name, "method", i, sig.slice(0, 200), class_name);
          continue;
        }
      }
    }

    // Function definition: must end with { on same line or next line.
    if (line.includes("(") && !line.includes(";") && !_search(_NOT_FUNC, raw_line)) {
      const fn_m = _match(_FUNC_DEF_RE, line);
      if (fn_m !== null) {
        const name = fn_m[1] as string;
        if (!_CALL_NOISE.has(name) && name.length > 1) {
          // look ahead for opening brace (may be on next line)
          const has_body = line.includes("{") || (i < n && (lines[i] as string).includes("{"));
          if (has_body) {
            const sig_end = line.indexOf("{");
            const sig = sig_end >= 0 ? _pyRStrip(line.slice(0, sig_end)) : _pyRStrip(line);
            add(name, "function", i, sig.slice(0, 200));
          }
        }
      }
    }
  }

  return symbols;
}

/**
 * Run all global-pattern matches across `s` (Python re.finditer over a global
 * pattern). Resets lastIndex so the shared module-level regex is safe to reuse.
 */
function _findAll(pattern: RegExp, s: string): RegExpMatchArray[] {
  const out: RegExpMatchArray[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(s)) !== null) {
    if (m.index === pattern.lastIndex) {
      pattern.lastIndex += 1;
    }
    out.push(m);
  }
  return out;
}

/** safe_regex_parse wrapper around {@link _extract_symbols_inner}. */
function _extract_symbols(source: Buffer, language: string): Symbol[] {
  return common.safe_regex_parse<Symbol[]>(
    (...args: unknown[]) =>
      _extract_symbols_inner(args[0] as Buffer, args[1] as string),
    [source, language],
    { log: _LOG, label: `_extract_symbols(${language})`, empty: [] },
  );
}

// ===========================================================================
// Imports
// ===========================================================================

/** Port of cpp.py _extract_imports: one ImpExp per #include directive. */
function _extract_imports(source: Buffer): ImpExp[] {
  const imp_exp: ImpExp[] = [];
  const text = source.toString("utf-8");
  const lines = _pySplitlines(text);
  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const m = _match(_INCLUDE_RE, lines[idx0] as string);
    if (m !== null) {
      imp_exp.push(new ImpExp({ kind: "import", target: m[1] as string, line: idx0 + 1 }));
    }
  }
  return imp_exp;
}

// ===========================================================================
// extract / extract_c
// ===========================================================================

/**
 * Extract symbols, refs, and imports from a C++ source file. Faithful port of
 * cpp.py extract: regex symbol pass in "cpp" mode + call-site refs (CALL_RE
 * minus _CALL_NOISE) + #include imports. Sections are always empty for C++.
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const symbols = _extract_symbols(source, "cpp");
  const refs = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);
  const imp_exp = _extract_imports(source);
  _LOG.debug(
    "cpp extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );
  return [symbols, refs, imp_exp, []];
}

/**
 * Extract symbols, refs, and imports from a C source file. Faithful port of
 * cpp.py extract_c: identical pipeline to {@link extract} but in "c" mode,
 * which skips the C++-only namespace / class / out-of-class-method rules.
 */
export function extract_c(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const symbols = _extract_symbols(source, "c");
  const refs = common.extract_refs_from_source(source, common.CALL_RE, _CALL_NOISE);
  const imp_exp = _extract_imports(source);
  _LOG.debug(
    "c extract: %s → symbols=%d refs=%d imports=%d",
    rel_path,
    symbols.length,
    refs.length,
    imp_exp.length,
  );
  return [symbols, refs, imp_exp, []];
}

/**
 * Resolve the C++ extractor.
 *
 * cpp.py is regex-based, so there is no grammar to load — but the registry
 * calls this through the async _grammar_importer contract, so getExtractor
 * stays async and resolves immediately. Returns the C++-mode {@link extract}
 * (the documented oracle for both the cpp and c registry keys, which both
 * route here; cpp.py's extract is the superset and the task's ground truth).
 */
export async function getExtractor(): Promise<Extractor> {
  return (source: Buffer, rel_path: string) => extract(source, rel_path);
}

/**
 * Resolve the C-mode extractor ({@link extract_c}). Provided for callers that
 * want C-grammar semantics explicitly; the parser registry routes the `c` key
 * through getExtractor (cpp mode) today, mirroring the single-factory contract.
 */
export async function getExtractorC(): Promise<Extractor> {
  return (source: Buffer, rel_path: string) => extract_c(source, rel_path);
}
