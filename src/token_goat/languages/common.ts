/**
 * Shared utilities for language-specific symbol extractors.
 *
 * Faithful port of src/token_goat/languages/common.py. Strict NodeNext ESM.
 *
 * -----
 * Coupling with parser.ts
 * -----
 * Python's common.py imports Symbol/Ref/ImpExp/Section from ..parser lazily
 * (inside functions) to dodge a circular import. In the TS port the cycle is not
 * a real runtime cycle: parser.ts does NOT import common.ts, so common.ts can
 * import the Symbol/Ref/ImpExp/Section value classes from "../parser.js" at
 * module top level. The classes are constructed with an options object
 * (`new Symbol({ name, kind, line })`), mirroring Python keyword construction.
 *
 * -----
 * Byte-offset parity (build_line_index / offset_to_line)
 * -----
 * Python tree-sitter and the flat adapters that consume these helpers work in
 * UTF-8 BYTE offsets. The Python build_line_index happened to index character
 * positions, but every flat adapter in the TS port computes byte offsets (via
 * Buffer); so here build_line_index returns the BYTE offset of each line start
 * and offset_to_line maps a BYTE offset to a 1-indexed line. For pure-ASCII
 * input the two are identical; for multi-byte text the byte-accurate version is
 * what the TS adapters require.
 *
 * -----
 * Regex parity
 * -----
 *  - Python `re.DOTALL` -> `[\s\S]` in the JS pattern (so `.` would otherwise
 *    not span newlines).
 *  - Python `re.IGNORECASE` -> the `i` flag.
 *  - A backreference like `\1` is written `\\1` in the JS string-built source
 *    but `\1` in a regex literal (used directly here).
 *  - Python str.splitlines() drops a trailing empty element; the local
 *    _splitlines helper reproduces that (a plain String.split("\n") would keep
 *    a trailing "" after a final newline).
 *  - Python slicing `s[:n]` counts CODE POINTS; the local _sliceCodepoints
 *    helper reproduces that for the heading/context truncations (a JS
 *    `.slice(0, n)` would cut on UTF-16 code units and could split an astral
 *    pair).
 */

import { createRequire } from "node:module";
import type { Logger } from "../util.js";
import { getLogger } from "../util.js";
import { ImpExp, Ref, Section, Symbol } from "../parser.js";

const _LOG = getLogger("languages.common");

// CommonJS require bound to THIS module's URL. Works identically under vitest
// and native ESM (node/tsx) — unlike a global `require`, which vitest injects
// but native ESM lacks (the blind spot that masked the db.ts bare-require bug).
const _moduleRequire = createRequire(import.meta.url);

// ===========================================================================
// Shared regex patterns
// ===========================================================================

/**
 * Shared call-site ref pattern for languages whose identifiers follow
 * [A-Za-z_][A-Za-z0-9_]* (Python, Go, Rust). TypeScript/JS extends this with
 * '$' and defines its own local variant.
 *
 * Note: this is a SOURCE pattern. Callers that `.finditer` must construct a
 * fresh RegExp with the `g` (and `u`) flag (a shared global RegExp carries
 * mutable lastIndex state and is not safe to reuse concurrently). makeCallRe()
 * builds the canonical global instance; CALL_RE_SOURCE is exposed for adapters
 * that extend it (those adapters MUST also compile with the `u` flag).
 *
 * UNICODE \w parity: Python's `re` treats `\w` as Unicode-aware by default, so
 * the lookbehind `(?<![.\w])` blocks a match whose preceding char is ANY letter
 * or digit, including non-ASCII (`naïve` / `método`). JS `\w` is ASCII-only, so
 * a faithful port must spell the lookbehind with `\p{L}\p{N}_` and compile with
 * the `u` flag — otherwise `def naïve_fn(` would spuriously yield a ref starting
 * mid-word at the byte after `ï`. (Verified against the oracle: the engine emits
 * NO ref there.) The capture class stays ASCII `[A-Za-z_][A-Za-z0-9_]*` to match
 * the engine's identifier-start rule exactly.
 */
export const CALL_RE_SOURCE = "(?<![.\\p{L}\\p{N}_])([A-Za-z_][A-Za-z0-9_]*)\\s*\\(";

/**
 * Build a fresh global RegExp for the shared call-site pattern. Each call
 * returns a new object so concurrent `finditer`-style loops do not share
 * lastIndex. Compiled with `u` so the `\p{…}` lookbehind classes are valid and
 * Unicode-aware (Python `\w` parity).
 */
export function makeCallRe(): RegExp {
  return new RegExp(CALL_RE_SOURCE, "gu");
}

/**
 * The canonical shared call-site RegExp (global). Mirrors Python's module-level
 * `CALL_RE = re.compile(...)`. Because JS global regexes carry lastIndex,
 * callers should prefer {@link makeCallRe} when they `finditer`; this export
 * exists for parity with the Python name and for adapters that pass a compiled
 * pattern straight into {@link extract_refs_from_source} (which resets
 * lastIndex internally).
 */
export const CALL_RE: RegExp = makeCallRe();

// Pre-compiled patterns used by strip_cstyle_comments for the common C-style
// block-comment syntax. DOTALL is expressed via [\s\S].
const _CSTYLE_BLOCK_RE = /\/\*[\s\S]*?\*\//g;
const _CSTYLE_LINE_RE = /\/\/[^\n]*/g;

// ===========================================================================
// String helpers (Python parity)
// ===========================================================================

/**
 * Reproduce Python str.splitlines() for the `\n`-delimited case: split on "\n"
 * and drop a single trailing empty element (Python does not yield an empty
 * final line after a terminating newline). Note: Python splitlines also splits
 * on \r, \v, \f, and Unicode line separators; the call sites here only feed
 * `\n`-normalised or plain text, so the `\n`-only split matches their behaviour.
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

/** Length of `s` in CODE POINTS (Python len(str)). */
function _lenCodepoints(s: string): number {
  let n = 0;
  for (const _ of s) {
    n += 1;
  }
  return n;
}

/** UTF-8 byte length of a single code point's string (1..4). */
function _utf8Len(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * Count occurrences of "\n" in `s` (Python str.count("\n")). Used for
 * match-position -> line-number conversion in the HTML heading extractor.
 */
function _countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      n += 1;
    }
  }
  return n;
}

// ===========================================================================
// strip_cstyle_comments
// ===========================================================================

/**
 * Replace comment regions with whitespace, preserving line numbers.
 *
 * Block comments (`block_re`) are replaced with the same number of newlines
 * they contained so subsequent matches land on the correct 1-indexed line; line
 * comments (`line_re`) are stripped entirely. Defaults handle C-style block and
 * `//` line comments. Pass `line_re` to override (e.g. SQL uses `--`).
 *
 * The passed regexes MUST be global (carry the `g` flag) so `.replace` replaces
 * every occurrence — the module defaults are global; adapters that pass custom
 * patterns must include `g`.
 */
export function strip_cstyle_comments(
  text: string,
  options: { block_re?: RegExp; line_re?: RegExp } = {},
): string {
  const block_re = options.block_re ?? _CSTYLE_BLOCK_RE;
  const line_re = options.line_re ?? _CSTYLE_LINE_RE;
  // Reset lastIndex defensively in case a caller passes a stateful global regex.
  block_re.lastIndex = 0;
  line_re.lastIndex = 0;
  let out = text.replace(block_re, (m) => "\n".repeat(_countNewlines(m)));
  out = out.replace(line_re, "");
  return out;
}

// ===========================================================================
// make_symbol_emitter
// ===========================================================================

/**
 * The de-duplicated emit helper used by CSS, GraphQL, Proto, and other
 * flat-grammar adapters: `emit(name, kind, line)` appends a (Symbol, Section)
 * pair when constraints allow.
 */
export type SymbolEmitter = (name: string, kind: string, line: number) => void;

/**
 * Return a closure that appends a (Symbol, Section) pair when constraints allow.
 *
 * @param symbols         List to append Symbol objects to.
 * @param sections        List to append Section objects to.
 * @param seen            A set of "name\nline" keys for exact-duplicate
 *                        suppression. (Python used a {(name, line)} tuple set;
 *                        the TS port keys on a string join since JS Sets compare
 *                        tuples by identity, not value.)
 * @param max_heading_len Maximum allowed character (code-point) length for name.
 * @param max_symbols     Maximum number of symbols to emit.
 */
export function make_symbol_emitter(
  symbols: Symbol[],
  sections: Section[],
  seen: Set<string>,
  options: { max_heading_len?: number; max_symbols?: number } = {},
): SymbolEmitter {
  const max_heading_len = options.max_heading_len ?? 120;
  const max_symbols = options.max_symbols ?? 500;

  return (name: string, kind: string, line: number): void => {
    if (_lenCodepoints(name) > max_heading_len) {
      return;
    }
    if (symbols.length >= max_symbols) {
      return;
    }
    const key = _key(name, line);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    symbols.push(new Symbol({ name, kind, line }));
    sections.push(new Section({ heading: name, level: 1, line }));
  };
}

/** Build the `(name, line)` tuple key used by the dedup sets (string form). */
function _key(name: string, line: number): string {
  return `${name}\n${line}`;
}

// ===========================================================================
// AddSymbolFn / AddFn protocols (as TS interfaces)
// ===========================================================================

/**
 * The recursive `_add_symbol` closure returned by {@link make_add_symbol}.
 * Signature: `(item, parent_name=null) -> void`.
 */
export type AddSymbolFn = (item: unknown, parent_name?: string | null) => void;

/**
 * The `add` closure returned by {@link make_add_fn}. Signature:
 * `add(name, kind, lineno, sig=null, parent=null) -> void`.
 */
export type AddFn = (
  name: string,
  kind: string,
  lineno: number,
  sig?: string | null,
  parent?: string | null,
) => void;

// ===========================================================================
// kind_str / sym_kind_str
// ===========================================================================

/** Canonical kind string (e.g. "function", "class", "method", "const", "var"). */
export type KindStr = string;

/** Base mapping shared by most languages (Go, TypeScript, Python). */
const _BASE_KIND_STR_MAPPING: Record<string, KindStr> = {
  Function: "function",
  Method: "method",
  Class: "class",
  Struct: "type",
  Interface: "interface",
  Enum: "enum",
  Trait: "interface",
  Impl: "class",
  Module: "const",
  Namespace: "const",
  Other: "var",
};

/** Rust-specific overrides (Impl -> impl, Module -> module, Namespace -> module). */
const _RUST_KIND_STR_MAPPING: Record<string, KindStr> = {
  ..._BASE_KIND_STR_MAPPING,
  Impl: "impl",
  Module: "module",
  Namespace: "module",
};

/** Base mapping shared by all languages. */
const _BASE_SYM_KIND_STR_MAPPING: Record<string, KindStr> = {
  Function: "function",
  Class: "class",
  Interface: "interface",
  Type: "type",
  Enum: "enum",
  Constant: "const",
  Variable: "var",
  Module: "const",
  Other: "var",
};

/** Rust-specific overrides (Module -> module). */
const _RUST_SYM_KIND_STR_MAPPING: Record<string, KindStr> = {
  ..._BASE_SYM_KIND_STR_MAPPING,
  Module: "module",
};

/** Take the substring after the last "." (Python `str(x).rpartition(".")[-1]`). */
function _rpartitionDot(value: unknown): string {
  const s = String(value);
  const dot = s.lastIndexOf(".");
  return dot === -1 ? s : s.slice(dot + 1);
}

/**
 * Convert a tree-sitter StructureKind to a canonical kind string. Supports
 * language-specific overrides for Impl/Module/Namespace. Python/Go/TypeScript
 * use the base mapping; Rust has overrides.
 */
export function kind_str(structure_kind: unknown, language: string = "go"): string {
  const s = _rpartitionDot(structure_kind);
  const mapping = language === "rust" ? _RUST_KIND_STR_MAPPING : _BASE_KIND_STR_MAPPING;
  return mapping[s] ?? "var";
}

/**
 * Convert a tree-sitter SymbolKind to a canonical kind string. Supports
 * language-specific overrides for Module mappings.
 */
export function sym_kind_str(sym_kind: unknown, language: string = "go"): string {
  const s = _rpartitionDot(sym_kind);
  const mapping = language === "rust" ? _RUST_SYM_KIND_STR_MAPPING : _BASE_SYM_KIND_STR_MAPPING;
  return mapping[s] ?? "var";
}

// ===========================================================================
// Tree-sitter degradation: get_tlp / parse_source / make_process_config
// ===========================================================================

/**
 * Return the tree-sitter "language pack" handle, or null if unavailable.
 *
 * Python imports `tree_sitter_language_pack`, a high-level wrapper exposing
 * `ProcessConfig(...)` and `.process(text, cfg)` (consumed by
 * make_process_config / parse_source). No npm package offers that surface:
 * `web-tree-sitter` is the low-level WASM runtime (Parser/Language/Query) and
 * does NOT expose `ProcessConfig`. So this seam stays dormant — we load
 * `web-tree-sitter` and return it only if it actually carries the language-pack
 * API; today that guard always fails, so GRAMMAR languages get no tree-sitter
 * extractor and files are indexed without symbols (matching Python without the
 * language pack). If a real pack-shaped module is ever installed under this
 * name, the seam lights up with no further change.
 *
 * IMPORTANT (ESM): resolution goes through `_moduleRequire`
 * (createRequire(import.meta.url)), never a global `require`. vitest injects a
 * global `require`, so a bare `require` / `globalThis.require` passes the suite
 * yet is `undefined` under native node/tsx — the exact blind spot that masked
 * the db.ts bare-require bug. The previous globalThis.require path also
 * diverged: under vitest it returned web-tree-sitter (truthy, wrong API ->
 * make_process_config would throw), under native ESM it returned null.
 */
export function get_tlp(): unknown | null {
  try {
    // Lazy require so the package's absence never breaks tsc and the function
    // stays synchronous like Python's get_tlp().
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = _moduleRequire("web-tree-sitter") as Record<string, unknown> | null;
    // Only a module exposing the language-pack API (ProcessConfig) is usable by
    // make_process_config / parse_source. web-tree-sitter is not, so in practice
    // this is the dormant null branch.
    if (mod && typeof mod === "object" && "ProcessConfig" in mod) {
      return mod;
    }
    return null;
  } catch {
    // Package not installed / not resolvable — file indexed without symbols.
    return null;
  }
}

/**
 * A tree-sitter ProcessConfig handle. Opaque (`unknown`) in this port — no
 * adapter consumes it this run.
 */
export type ProcessConfig = unknown;

/**
 * Create a ProcessConfig for tree-sitter language-pack processing.
 *
 * Returns `[tlp, cfg]` when tree-sitter is available, or `[null, null]` when
 * not. Always returns `[null, null]` this run (no runtime installed).
 */
export function make_process_config(
  language: string,
  options: {
    structure?: boolean;
    imports?: boolean;
    exports?: boolean;
    symbols?: boolean;
  } = {},
): [unknown, ProcessConfig] | [null, null] {
  const tlp = get_tlp();
  if (tlp === null) {
    return [null, null];
  }
  const structure = options.structure ?? true;
  const imports = options.imports ?? true;
  const exports = options.exports ?? false;
  const symbols = options.symbols ?? true;
  const ProcessConfigCtor = (tlp as { ProcessConfig: (cfg: unknown) => unknown }).ProcessConfig;
  return [
    tlp,
    ProcessConfigCtor({ language, structure, imports, exports, symbols }),
  ];
}

/**
 * Decode `source` and run tree-sitter processing, returning `[result, text]`.
 *
 * Returns `[result, text]` on success, or `[null, null]` when tree-sitter is
 * unavailable or parsing fails. This run, tree-sitter is unavailable, so the
 * first branch always returns `[null, null]` and callers fall through to their
 * empty-result path.
 */
export function parse_source(
  source: Buffer,
  language: string,
  rel_path: string,
  log: Logger,
  process_config_kwargs: {
    structure?: boolean;
    imports?: boolean;
    exports?: boolean;
    symbols?: boolean;
  } = {},
): [unknown, string] | [null, null] {
  const text = source.toString("utf-8");
  const [tlp, cfg] = make_process_config(language, process_config_kwargs);
  if (tlp === null) {
    _LOG.debug(
      "tree-sitter language pack unavailable; skipping parse for %s",
      rel_path,
    );
    return [null, null];
  }
  try {
    const result = (tlp as { process: (t: string, c: unknown) => unknown }).process(text, cfg);
    return [result, text];
  } catch (exc) {
    log.warning(
      "tree-sitter parse failed for %s (%s): %s — file will be indexed without symbols",
      rel_path,
      language,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [null, null];
  }
}

// ===========================================================================
// build_signature
// ===========================================================================

/**
 * Minimal duck-typed span shape: tree-sitter spans expose byte offsets and
 * 0-based line numbers. All fields optional because the C-extension structs may
 * omit them on error-recovery nodes.
 */
export interface SpanLike {
  start_byte?: number;
  end_byte?: number;
  start_line?: number;
  end_line?: number;
}

/**
 * Extract the declaration header (before the body brace/colon) from raw source
 * bytes. Returns at most 200 characters of the header, or null if unavailable.
 *
 * Byte-accurate: slices the raw Buffer between byte offsets (tree-sitter
 * offsets are byte offsets), then decodes.
 */
export function build_signature(
  source: Buffer,
  item_span: SpanLike,
  body_span: SpanLike | null,
): string | null {
  if (body_span === null) {
    return null;
  }
  try {
    const startByte = item_span.start_byte;
    const endByte = body_span.start_byte;
    if (startByte === undefined || endByte === undefined) {
      // AttributeError analogue: missing .start_byte on an unexpected node shape.
      _LOG.debug(
        "build_signature: skipping malformed span (no signature extracted): missing start_byte",
      );
      return null;
    }
    const header = source.subarray(startByte, endByte);
    let text = header.toString("utf-8").trim();
    if (_lenCodepoints(text) > 200) {
      text = _sliceCodepoints(text, 200);
    }
    return text || null;
  } catch (exc) {
    _LOG.debug(
      "build_signature: skipping malformed span (no signature extracted): %s",
      exc instanceof Error ? exc.message : String(exc),
    );
    return null;
  }
}

// ===========================================================================
// extract_refs_from_source
// ===========================================================================

/**
 * Extract call-site refs using a regex on the source text. Shared implementation
 * for all language adapters. Each adapter supplies its own `call_re` (identifier
 * pattern) and `call_noise` (builtins to skip).
 *
 * @param call_re A RegExp with a single capture group for the identifier. It
 *   should be global; this function resets lastIndex per line so a global
 *   instance is reused safely.
 */
export function extract_refs_from_source(
  source: Buffer,
  call_re: RegExp,
  call_noise: ReadonlySet<string>,
): Ref[] {
  const refs: Ref[] = [];
  const seen: Set<string> = new Set();
  const text = source.toString("utf-8");
  // Ensure the regex is global so finditer-style iteration advances; if the
  // caller passed a non-global pattern, build a global clone.
  const re = call_re.global ? call_re : new RegExp(call_re.source, call_re.flags + "g");
  const lines = _splitlines(text);
  for (let i = 0; i < lines.length; i++) {
    const lineno = i + 1;
    const line = lines[i] as string;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      // Guard against zero-width matches looping forever (the call pattern
      // always consumes at least the identifier, but be defensive).
      if (m.index === re.lastIndex) {
        re.lastIndex += 1;
      }
      const name = m[1];
      if (name === undefined) {
        continue;
      }
      if (call_noise.has(name) || name.length <= 1) {
        continue;
      }
      const key = _key(name, lineno);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      // m.index points at the start of the whole match (the lookbehind is
      // zero-width), which equals the start of capture group 1.
      const col = m.index;
      refs.push(
        new Ref({
          name,
          line: lineno,
          col,
          context: _sliceCodepoints(line.trim(), 120),
        }),
      );
    }
  }
  return refs;
}

// ===========================================================================
// make_add_symbol
// ===========================================================================

/**
 * Duck-typed tree-sitter structure node. All accessors optional because the
 * underlying objects are C-extension structs whose shape varies by node kind.
 */
export interface StructureNodeLike {
  name?: string;
  kind?: unknown;
  span?: SpanLike;
  body_span?: SpanLike;
  children?: unknown[];
}

/**
 * Return a recursive `_add_symbol(item, parent_name)` closure that walks a
 * tree-sitter node and appends named symbols to `symbols`.
 *
 * @param symbols         List to append Symbol objects to.
 * @param seen_names      Dedup set of "name\nline" keys.
 * @param source          Raw file bytes used by build_signature.
 * @param language        Forwarded to kind_str.
 * @param promote_methods When true, a `function` whose parent is non-null is
 *   promoted to `method` (Python and Rust use this).
 */
export function make_add_symbol(
  symbols: Symbol[],
  seen_names: Set<string>,
  source: Buffer,
  language: string = "go",
  options: { promote_methods?: boolean } = {},
): AddSymbolFn {
  const promote_methods = options.promote_methods ?? false;

  const _add_symbol: AddSymbolFn = (itemRaw: unknown, parent_name: string | null = null): void => {
    const item = itemRaw as StructureNodeLike | null | undefined;
    if (item === null || item === undefined || typeof item !== "object") {
      return;
    }
    // .name absent -> not a symbol node (AttributeError analogue).
    const name = item.name;
    if (name === undefined) {
      return;
    }
    if (!name) {
      const children = item.children;
      if (children === undefined) {
        return;
      }
      for (const child of children) {
        _add_symbol(child, parent_name);
      }
      return;
    }
    const span = item.span;
    if (
      span === undefined ||
      span.start_line === undefined ||
      span.end_line === undefined ||
      item.kind === undefined
    ) {
      // .span / .kind missing on partial parse results (error-recovery nodes).
      _LOG.debug("make_add_symbol: skipping malformed node %s", String(name));
      return;
    }
    const body_span = item.body_span !== undefined ? item.body_span : null;
    const line = span.start_line + 1;
    const end_line = span.end_line + 1;
    let kind = kind_str(item.kind, language);
    if (promote_methods && parent_name !== null && kind === "function") {
      kind = "method";
    }
    const sig = build_signature(source, span, body_span);

    const key = _key(name, line);
    if (!seen_names.has(key)) {
      seen_names.add(key);
      symbols.push(
        new Symbol({
          name,
          kind,
          line,
          end_line,
          signature: sig,
          parent_name,
        }),
      );
    }

    const children = item.children;
    if (children === undefined) {
      return;
    }
    for (const child of children) {
      _add_symbol(child, name);
    }
  };

  return _add_symbol;
}

// ===========================================================================
// add_imports / add_symbol_info
// ===========================================================================

/** Duck-typed import node from tree-sitter results. */
export interface ImportNodeLike {
  span?: SpanLike;
}

/**
 * Add imports to the imp_exp list using a caller-supplied extraction function.
 * The extraction function may return one or more targets per import.
 *
 * @param extract_targets_fn `(imp) -> string | string[]` extracting target(s).
 */
export function add_imports(
  imp_exp: ImpExp[],
  imports: unknown[],
  extract_targets_fn: (imp: unknown) => string | string[],
): void {
  for (const imp of imports) {
    let targets: string[];
    let line: number;
    try {
      const raw = extract_targets_fn(imp);
      if (typeof raw === "string") {
        targets = raw ? [raw] : [];
      } else {
        targets = raw;
      }
      const span = (imp as ImportNodeLike).span;
      if (span === undefined || span.start_line === undefined) {
        throw new _AttributeError("import node missing span.start_line");
      }
      line = span.start_line + 1;
    } catch (exc) {
      _LOG.debug(
        "add_imports: skipping malformed import node: %s",
        exc instanceof Error ? exc.message : String(exc),
      );
      continue;
    }
    for (const target of targets) {
      if (target) {
        imp_exp.push(new ImpExp({ kind: "import", target, line }));
      }
    }
  }
}

/** Duck-typed SymbolInfo node from tree-sitter results. */
export interface SymbolInfoLike {
  name?: string;
  kind?: unknown;
  span?: SpanLike;
}

/**
 * Add symbols from result.symbols (SymbolInfo) to the symbol list.
 *
 * @param symbols      List to append Symbol objects to.
 * @param seen_names   Dedup set of "name\nline" keys.
 * @param symbol_infos result.symbols list from tree-sitter processing.
 * @param language     Forwarded to sym_kind_str.
 */
export function add_symbol_info(
  symbols: Symbol[],
  seen_names: Set<string>,
  symbol_infos: unknown[],
  language: string = "go",
): void {
  const before = symbols.length;
  for (const symRaw of symbol_infos) {
    const sym = symRaw as SymbolInfoLike;
    let name: string;
    let span: SpanLike;
    let line: number;
    let kind: string;
    try {
      if (sym === null || typeof sym !== "object" || sym.name === undefined) {
        throw new _AttributeError("SymbolInfo missing name");
      }
      name = sym.name;
      if (sym.span === undefined || sym.span.start_line === undefined) {
        throw new _AttributeError("SymbolInfo missing span.start_line");
      }
      span = sym.span;
      line = span.start_line! + 1;
      kind = sym_kind_str(sym.kind, language);
    } catch (exc) {
      _LOG.debug(
        "add_symbol_info (%s): skipping malformed SymbolInfo: %s",
        language,
        exc instanceof Error ? exc.message : String(exc),
      );
      continue;
    }
    const key = _key(name, line);
    if (!seen_names.has(key)) {
      seen_names.add(key);
      symbols.push(
        new Symbol({
          name,
          kind,
          line,
          end_line: (span.end_line ?? span.start_line!) + 1,
          signature: null,
          parent_name: null,
        }),
      );
    }
  }
  const added = symbols.length - before;
  const skipped = symbol_infos.length - added;
  _LOG.debug(
    "add_symbol_info (%s): added %d symbol(s) from %d candidates (%d duplicate(s) skipped)",
    language,
    added,
    symbol_infos.length,
    skipped,
  );
}

/** AttributeError analogue for the duck-typed-node guards above. */
class _AttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
  }
}

// ===========================================================================
// collect_symbols_and_refs
// ===========================================================================

/** Duck-typed tree-sitter process result. */
export interface ProcessResultLike {
  structure: unknown[];
  symbols: unknown[];
  imports?: unknown[];
  exports?: unknown[];
}

/**
 * The 5-tuple returned by {@link collect_symbols_and_refs} on success:
 * `[symbols, imp_exp, seen_names, refs, result]`.
 */
export type CollectResult = [
  Symbol[],
  ImpExp[],
  Set<string>,
  Ref[],
  ProcessResultLike,
];

/**
 * Run the standard symbol-extraction pipeline shared by most language adapters.
 *
 * Returns `[symbols, imp_exp, seen_names, refs, result]` so callers can append
 * their own language-specific symbols and handle imports before returning, or
 * null when tree-sitter is unavailable / parsing fails (always null this run).
 *
 * @param call_re         Compiled regex for call-site extraction.
 * @param call_noise      Names to exclude from refs.
 * @param promote_methods Forwarded to make_add_symbol (true for Python/Rust).
 */
export function collect_symbols_and_refs(
  source: Buffer,
  language: string,
  rel_path: string,
  log: Logger,
  call_re: RegExp,
  call_noise: ReadonlySet<string>,
  options: {
    promote_methods?: boolean;
    structure?: boolean;
    imports?: boolean;
    exports?: boolean;
    symbols?: boolean;
  } = {},
): CollectResult | null {
  const promote_methods = options.promote_methods ?? false;
  const pcKwargs: {
    structure?: boolean;
    imports?: boolean;
    exports?: boolean;
    symbols?: boolean;
  } = {};
  if (options.structure !== undefined) pcKwargs.structure = options.structure;
  if (options.imports !== undefined) pcKwargs.imports = options.imports;
  if (options.exports !== undefined) pcKwargs.exports = options.exports;
  if (options.symbols !== undefined) pcKwargs.symbols = options.symbols;

  const [result] = parse_source(source, language, rel_path, log, pcKwargs);
  if (result === null) {
    return null;
  }
  const res = result as ProcessResultLike;

  const symbols: Symbol[] = [];
  const imp_exp: ImpExp[] = [];
  const seen_names: Set<string> = new Set();

  const _add_symbol = make_add_symbol(symbols, seen_names, source, language, {
    promote_methods,
  });
  for (const item of res.structure) {
    _add_symbol(item);
  }

  add_symbol_info(symbols, seen_names, res.symbols, language);

  const refs: Ref[] = extract_refs_from_source(source, call_re, call_noise);

  return [symbols, imp_exp, seen_names, refs, res];
}

// ===========================================================================
// extend_starts_for_decorators
// ===========================================================================

/**
 * Walk each symbol's start_line back over leading decorators/modifiers.
 *
 * @param eligible_kinds Kinds to consider (others skipped).
 * @param walk_fn `(text_lines, def_line_1based) -> new_start_1based`.
 */
export function extend_starts_for_decorators(
  symbols: Symbol[],
  source: Buffer,
  options: {
    eligible_kinds: ReadonlySet<string>;
    walk_fn: (text_lines: string[], def_line_1based: number) => number;
  },
): void {
  const { eligible_kinds, walk_fn } = options;
  let text_lines: string[];
  try {
    text_lines = _splitlines(source.toString("utf-8"));
  } catch {
    return;
  }
  if (text_lines.length === 0) {
    return;
  }
  for (const sym of symbols) {
    if (!eligible_kinds.has(sym.kind)) {
      continue;
    }
    const new_start = walk_fn(text_lines, sym.line);
    if (new_start !== sym.line) {
      sym.line = new_start;
    }
  }
}

// ===========================================================================
// build_line_index / offset_to_line (BYTE-accurate)
// ===========================================================================

/**
 * Return a list of BYTE offsets for the start of each line (0-indexed).
 *
 * `build_line_index(text)[i]` is the UTF-8 byte position of the first byte of
 * line `i+1` (1-indexed). Companion to {@link offset_to_line}, which maps a byte
 * offset to a 1-indexed line via binary search.
 *
 * Byte-accurate (the flat adapters work in UTF-8 byte offsets). For pure-ASCII
 * text the byte offsets equal the character offsets the Python helper produced.
 */
export function build_line_index(text: string): number[] {
  const offsets: number[] = [0];
  let byte = 0;
  for (const ch of text) {
    if (ch === "\n") {
      // Record the start of the NEXT line (byte just past the newline).
      offsets.push(byte + 1);
      byte += 1;
    } else {
      byte += _utf8Len(ch);
    }
  }
  return offsets;
}

/**
 * Convert a BYTE offset to a 1-indexed line number using binary search.
 * Companion to {@link build_line_index}. O(log n) in the number of lines.
 *
 * Uses the upper-biased midpoint `(lo + hi + 1) >> 1` (ceiling) so the
 * invariant `line_index[lo] <= offset` is maintained when lo == hi - 1.
 */
export function offset_to_line(line_index: number[], offset: number): number {
  let lo = 0;
  let hi = line_index.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((line_index[mid] as number) <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

// ===========================================================================
// HTML section helpers
// ===========================================================================

/**
 * Assign end_line to each Section based on the next section of equal or lesser
 * level. Mutates `sections` in-place; `lines` is used only for the total line
 * count (EOF).
 */
function _compute_section_end_lines(sections: Section[], lines: string[]): void {
  const total = lines.length;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i] as Section;
    let end_line = total;
    for (let j = i + 1; j < sections.length; j++) {
      if ((sections[j] as Section).level <= sec.level) {
        end_line = (sections[j] as Section).line - 1;
        break;
      }
    }
    sec.end_line = end_line;
  }
}

// Shared HTML heading regex (h1-h6, IGNORECASE + DOTALL via [\s\S]). The
// backreference \1 closes the matching tag. Global so finditer advances.
const _H_TAG_RE = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
// id="..." attribute inside an HTML opening tag (IGNORECASE).
const _HEADING_ID_RE = /\bid\s*=\s*["']([^"']+)["']/i;
// Strip inline HTML tags from heading inner text (global).
const _INLINE_TAG_RE = /<[^>]+>/g;
// Collapse runs of whitespace (including newlines) to a single space (global).
const _WS_RUN_RE = /\s+/g;

/**
 * Extract HTML headings from `text` and assign end_line to each Section.
 * Combines extract_html_headings + _compute_section_end_lines (the two calls
 * that appear identically in html.py and liquid.py).
 */
export function extract_and_finalize_html_sections(
  text: string,
  sections: Section[],
  lines: string[],
): void {
  extract_html_headings(text, sections);
  _compute_section_end_lines(sections, lines);
}

/**
 * Append HTML heading Sections parsed from `text` into `sections`. Handles
 * `<h1>`-`<h6>`. When a heading has an `id` attribute, emits TWO sections (the
 * text content and the anchor id) covering the same span. Inline HTML tags
 * inside the heading are stripped. Caller is responsible for computing
 * end-lines afterward.
 */
export function extract_html_headings(text: string, sections: Section[]): void {
  const before = sections.length;
  _H_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = _H_TAG_RE.exec(text)) !== null) {
    if (match.index === _H_TAG_RE.lastIndex) {
      _H_TAG_RE.lastIndex += 1;
    }
    const level = parseInt(match[1] as string, 10);
    const attrs = match[2];
    const raw_inner = match[3] ?? "";
    // Strip inline tags and collapse whitespace runs.
    _INLINE_TAG_RE.lastIndex = 0;
    const inner = raw_inner.replace(_INLINE_TAG_RE, "");
    _WS_RUN_RE.lastIndex = 0;
    let heading_text = inner.replace(_WS_RUN_RE, " ").trim();
    if (!heading_text) {
      continue;
    }
    heading_text = _sliceCodepoints(heading_text, 100);
    const line = _countNewlines(text.slice(0, match.index)) + 1;
    sections.push(new Section({ heading: heading_text, level, line }));
    const id_match = _HEADING_ID_RE.exec(attrs ?? "");
    if (id_match !== null) {
      const anchor = _sliceCodepoints((id_match[1] as string).trim(), 100);
      if (anchor && anchor !== heading_text) {
        sections.push(new Section({ heading: anchor, level, line }));
      }
    }
  }
  const added = sections.length - before;
  _LOG.debug("extract_html_headings: added %d section(s)", added);
}

// ===========================================================================
// Config-file helpers (TOML / INI / YAML / Dockerfile)
// ===========================================================================

const _UTF8_BOM = "﻿";

/**
 * Decode `source` bytes to a normalised text string, or return null on failure.
 * Normalises CRLF/CR to LF and strips a leading UTF-8 BOM.
 *
 * @param label Short adapter label prepended to the failure log message.
 */
export function decode_source_text(
  source: Buffer,
  log: Logger,
  label: string,
): string | null {
  try {
    const text = source
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    // strip UTF-8 BOM if present (Notepad on Windows). Python lstrip("﻿")
    // removes ALL leading BOM chars; replicate with a leading-run strip.
    return _lstripChar(text, _UTF8_BOM);
  } catch (exc) {
    log.debug("%s: decode failed: %s", label, exc instanceof Error ? exc.message : String(exc));
    return null;
  }
}

/** Strip all leading occurrences of a single character (Python str.lstrip(ch)). */
function _lstripChar(s: string, ch: string): string {
  let i = 0;
  while (i < s.length && s[i] === ch) {
    i += 1;
  }
  return s.slice(i);
}

/**
 * Strip a leading UTF-8 BOM from `line` when `idx` is 1, otherwise return `line`
 * unchanged. (BOM is only valid at the start of a file, never mid-document.)
 */
export function bom_strip_first_line(line: string, idx: number): string {
  return idx === 1 ? _lstripChar(line, _UTF8_BOM) : line;
}

/**
 * Assign `end_line` to each Section in a flat (non-nested) section list: a
 * section's content ends at the line before the next section header (or at
 * `total_lines` for the last one). TOML, INI, and Dockerfile share this shape.
 */
export function assign_flat_end_lines(
  sections: Section[],
  total_lines: number,
): void {
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i] as Section;
    if (i + 1 < sections.length) {
      sec.end_line = Math.max(sec.line, (sections[i + 1] as Section).line - 1);
    } else {
      sec.end_line = Math.max(sec.line, total_lines);
    }
  }
}

/**
 * Copy computed `end_line` values from `sections` into the parallel `symbols`
 * list, matched by `(name, line)` key (the flat extractors emit a 1-to-1 list of
 * Symbol and Section per definition). Mutates `symbols` in-place.
 */
export function propagate_section_end_lines_to_symbols(
  symbols: Symbol[],
  sections: Section[],
): void {
  const end_by_key: Map<string, number> = new Map();
  for (const sec of sections) {
    if (sec.end_line !== null) {
      end_by_key.set(_key(sec.heading, sec.line), sec.end_line);
    }
  }
  for (const sym of symbols) {
    const key = _key(sym.name, sym.line);
    if (sym.end_line === null && end_by_key.has(key)) {
      sym.end_line = end_by_key.get(key) ?? null;
    }
  }
}

// ===========================================================================
// scan_flat_headers
// ===========================================================================

/**
 * Line-by-line header scan shared by flat config extractors (toml_idx, ini_idx,
 * dockerfile_idx, and the .env path of ini_idx when emit_sections=false).
 *
 * Returns `[symbols, sections]` on success or null on decode failure. Refs and
 * imports are not modelled for these formats (always empty).
 *
 * @param pattern         Column-0-anchored regex matched against each candidate
 *   line via `.match` semantics (anchored at start). MUST start with `^`.
 * @param get_name        Maps a match to the heading; may return "" to skip.
 * @param symbol_kind     Static kind assigned to every emitted Symbol.
 * @param max_entries     Cap on matches recorded per file.
 * @param max_heading_len Reject matches whose heading exceeds this length.
 * @param emit_sections   When true, append a Section per Symbol and compute
 *   end-lines; when false (.env path), only symbols are emitted.
 * @param level_from_match Optional hook returning a 1-based level per match
 *   (defaults to 1; TOML uses 2 for [[array]] entries).
 * @param prefilter       Optional cheap per-line predicate evaluated before the
 *   regex; lines for which it returns false are skipped.
 */
export function scan_flat_headers(
  source: Buffer,
  log: Logger,
  label: string,
  options: {
    pattern: RegExp;
    get_name: (m: RegExpMatchArray) => string;
    symbol_kind: string;
    max_entries: number;
    max_heading_len: number;
    emit_sections?: boolean;
    level_from_match?: ((m: RegExpMatchArray) => number) | null;
    prefilter?: ((line: string) => boolean) | null;
  },
): [Symbol[], Section[]] | null {
  const {
    pattern,
    get_name,
    symbol_kind,
    max_entries,
    max_heading_len,
  } = options;
  const emit_sections = options.emit_sections ?? true;
  const level_from_match = options.level_from_match ?? null;
  const prefilter = options.prefilter ?? null;

  const text = decode_source_text(source, log, label);
  if (text === null) {
    return null;
  }
  const lines = text.split("\n");
  const sections: Section[] = [];
  const symbols: Symbol[] = [];

  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const idx = idx0 + 1;
    const candidate = bom_strip_first_line(lines[idx0] as string, idx);
    if (prefilter !== null && !prefilter(candidate)) {
      continue;
    }
    // Python pattern.match anchors at the START of the string. JS `.match` is
    // unanchored, so we use a regex that already starts with ^ (the contract)
    // and call .exec against the candidate; a `^`-anchored pattern only matches
    // at position 0, reproducing Python's `.match`.
    const m = _matchAtStart(pattern, candidate);
    if (m === null) {
      continue;
    }
    const name = get_name(m);
    if (!name || _lenCodepoints(name) > max_heading_len) {
      continue;
    }
    symbols.push(new Symbol({ name, kind: symbol_kind, line: idx }));
    if (emit_sections) {
      const level = level_from_match !== null ? level_from_match(m) : 1;
      sections.push(new Section({ heading: name, level, line: idx }));
    }
    if (symbols.length >= max_entries) {
      break;
    }
  }

  if (emit_sections) {
    assign_flat_end_lines(sections, lines.length);
    propagate_section_end_lines_to_symbols(symbols, sections);
  }

  return [symbols, sections];
}

/**
 * Reproduce Python's `re.Pattern.match(s)` (anchored at string start) for a
 * pattern that may or may not be global. Returns the match array or null.
 *
 * If the pattern lacks the `y` (sticky) flag we clone it with sticky+lastIndex 0
 * so it only matches at index 0; if it already has `^` plus `g`/`y`, we still
 * reset lastIndex to be safe.
 */
function _matchAtStart(pattern: RegExp, s: string): RegExpMatchArray | null {
  // Build a sticky clone anchored at position 0. Sticky (`y`) forces the match
  // to begin exactly at lastIndex (0), which is Python `.match` semantics.
  const flags = pattern.flags.replace(/[gy]/g, "") + "y";
  const re = new RegExp(pattern.source, flags);
  re.lastIndex = 0;
  const m = re.exec(s);
  return m;
}

// ===========================================================================
// safe_regex_parse
// ===========================================================================

/**
 * Call `fn(...args)` and return its result, or `empty` if a parse error occurs.
 * Consolidates the `try / except (re.error, ValueError, IndexError)` wrappers in
 * every language adapter.
 *
 * In JS the corresponding throws are SyntaxError (bad regex), RangeError, and
 * TypeError/Error; this catches any thrown Error and returns `empty`, matching
 * the Python intent of "never let a malformed pattern abort extraction".
 *
 * @param empty Value to return on error (default []). Pass `[[], []]` for
 *   functions that return a tuple of lists.
 */
export function safe_regex_parse<T>(
  fn: (...args: unknown[]) => T,
  args: unknown[],
  options: { log: Logger; label: string; empty?: T },
): T {
  const { log, label } = options;
  try {
    return fn(...args);
  } catch (exc) {
    log.debug(
      "%s: parse error: %s",
      label,
      exc instanceof Error ? exc.message : String(exc),
    );
    return options.empty !== undefined ? options.empty : ([] as unknown as T);
  }
}

// ===========================================================================
// merge_extra_symbols
// ===========================================================================

/**
 * Append `extras` to `symbols`, skipping any whose `(name, line)` key is already
 * in `seen_names`. Mutates both `symbols` and `seen_names` in-place.
 */
export function merge_extra_symbols(
  symbols: Symbol[],
  seen_names: Set<string>,
  extras: Symbol[],
): void {
  for (const extra of extras) {
    const key = _key(extra.name, extra.line);
    if (!seen_names.has(key)) {
      seen_names.add(key);
      symbols.push(extra);
    }
  }
}

// ===========================================================================
// make_add_fn
// ===========================================================================

/**
 * Return an `add(name, kind, lineno, sig, parent)` closure that appends
 * deduplicated Symbol objects (used by cpp.py, ruby.py, php.py). The signature
 * is truncated to 200 characters; end_line is set equal to the start line.
 *
 * @param symbols    List to append Symbol objects to.
 * @param seen_names Dedup set of "name\nline" keys; mutated in place.
 */
export function make_add_fn(symbols: Symbol[], seen_names: Set<string>): AddFn {
  return (
    name: string,
    kind: string,
    lineno: number,
    sig: string | null = null,
    parent: string | null = null,
  ): void => {
    const key = _key(name, lineno);
    if (!seen_names.has(key)) {
      seen_names.add(key);
      symbols.push(
        new Symbol({
          name,
          kind,
          line: lineno,
          end_line: lineno,
          signature: sig ? _sliceCodepoints(sig, 200) : null,
          parent_name: parent,
        }),
      );
    }
  };
}
