/**
 * JSON extractor — top-level keys for objects, array-of-N for arrays.
 *
 * Faithful port of src/token_goat/languages/json_idx.py. Strict NodeNext ESM.
 *
 * -----
 * Order-preserving parse (vs JSON.parse)
 * -----
 * Python `json.loads` preserves a JSON object's key insertion order, INCLUDING
 * keys that look like integers ("0", "1", …). JS `JSON.parse` builds plain
 * objects, where integer-like keys are reordered ahead of string keys per the
 * ECMAScript property-ordering rules — which would scramble the emitted symbol
 * order relative to Python. So this module ships a tiny order-preserving JSON
 * parser ({@link _parseJson}) that models objects as an ordered list of
 * [key, value] entries (a JsonObject wrapper) and arrays as JS arrays. The
 * parser is strict-ish (matches what json.loads accepts for the inputs this
 * adapter sees) and throws a JsonDecodeError on malformed input so the caller's
 * regex fallback path runs, exactly like Python's `except json.JSONDecodeError`.
 *
 * -----
 * _safe_repr / json.dumps parity
 * -----
 * Python `json.dumps(obj, default=str)` uses the DEFAULT separators (", " and
 * ": "), ensure_ascii=True (non-ASCII -> \uXXXX), and renders floats with a
 * trailing ".0" when integral. {@link _jsonDumps} reproduces that for the
 * ordered value model.
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";

const _LOG = getLogger("languages.json_idx");

// Minimum file size to index JSON (50 KB)
const _MIN_JSON_SIZE = 50_000;

// Maximum symbols per JSON file
const _MAX_SYMBOLS = 200;

// Regex for extracting top-level keys without full JSON parse (for large/malformed
// files). Anchored at column 0 with MULTILINE so it reliably hits only top-level
// keys in pretty-printed JSON (nested keys are indented, so they don't match).
const _TOP_LEVEL_KEY_RE = /^\s*"([^"]+)"\s*:/gm;

// Section-emission pattern: a pretty-printed JSON top-level key. Anchored with
// MULTILINE so we can compute line numbers via positional offsets.
const _SECTION_KEY_RE = /^[ \t]*"([^"]+)"\s*:/gm;

// Maximum number of top-level keys promoted to Section entries per file.
const _MAX_SECTIONS_PER_FILE = 100;

// Fallback regex for *minified* JSON, where everything is on a single line.
const _ANY_KEY_RE = /"([^"\\]{1,200})"\s*:/g;

// When indexing top-level objects whose value is also an object, emit one level
// of nested keys as parent.child symbols up to this many total entries.
const _MAX_NESTED_SYMBOLS = 50;

// For top-level arrays of objects, peek at element[0] and emit its keys as
// [].key symbols, capped to keep the budget healthy.
const _MAX_ARRAY_ELEMENT_KEYS = 20;

// ===========================================================================
// Order-preserving JSON value model + parser
// ===========================================================================

/** Ordered object: entries preserve JSON source insertion order. */
class JsonObject {
  readonly entries: Array<[string, JsonValue]> = [];
  set(key: string, value: JsonValue): void {
    this.entries.push([key, value]);
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

/** Raised on malformed JSON (analogue of Python json.JSONDecodeError). */
class JsonDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONDecodeError";
  }
}

/**
 * Minimal order-preserving JSON parser. Models objects as {@link JsonObject}
 * (ordered entries) and arrays as JS arrays. Throws {@link JsonDecodeError} on
 * any malformed input. Numbers are parsed as JS numbers; the distinction between
 * int and float is recovered at dump time by inspecting the SOURCE token, so we
 * remember whether a number token contained a '.'/'e'/'E' via a wrapper.
 */
function _parseJson(text: string): JsonValue {
  let i = 0;
  const n = text.length;

  function err(msg: string): never {
    throw new JsonDecodeError(`${msg} at position ${i}`);
  }

  function skipWs(): void {
    while (i < n) {
      const c = text.charCodeAt(i);
      // space, tab, newline, carriage return
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        i += 1;
      } else {
        break;
      }
    }
  }

  function parseValue(): JsonValue {
    skipWs();
    if (i >= n) {
      err("Expecting value");
    }
    const ch = text[i] as string;
    if (ch === "{") {
      return parseObject();
    }
    if (ch === "[") {
      return parseArray();
    }
    if (ch === '"') {
      return parseString();
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return parseNumber();
    }
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    if (text.startsWith("NaN", i)) {
      i += 3;
      return NaN;
    }
    if (text.startsWith("Infinity", i)) {
      i += 8;
      return Infinity;
    }
    if (text.startsWith("-Infinity", i)) {
      i += 9;
      return -Infinity;
    }
    err("Expecting value");
  }

  function parseObject(): JsonObject {
    i += 1; // consume {
    const obj = new JsonObject();
    skipWs();
    if (text[i] === "}") {
      i += 1;
      return obj;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') {
        err("Expecting property name enclosed in double quotes");
      }
      const key = parseString();
      skipWs();
      if (text[i] !== ":") {
        err("Expecting ':' delimiter");
      }
      i += 1;
      const value = parseValue();
      obj.set(key, value);
      skipWs();
      const c = text[i];
      if (c === ",") {
        i += 1;
        continue;
      }
      if (c === "}") {
        i += 1;
        return obj;
      }
      err("Expecting ',' delimiter");
    }
  }

  function parseArray(): JsonValue[] {
    i += 1; // consume [
    const arr: JsonValue[] = [];
    skipWs();
    if (text[i] === "]") {
      i += 1;
      return arr;
    }
    for (;;) {
      const value = parseValue();
      arr.push(value);
      skipWs();
      const c = text[i];
      if (c === ",") {
        i += 1;
        continue;
      }
      if (c === "]") {
        i += 1;
        return arr;
      }
      err("Expecting ',' delimiter");
    }
  }

  function parseString(): string {
    i += 1; // consume opening quote
    let out = "";
    for (;;) {
      if (i >= n) {
        err("Unterminated string");
      }
      const ch = text[i] as string;
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === "\\") {
        i += 1;
        if (i >= n) {
          err("Unterminated string");
        }
        const esc = text[i] as string;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(i + 1, i + 5);
            if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
              err("Invalid \\uXXXX escape");
            }
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            err(`Invalid \\escape: ${esc}`);
        }
        i += 1;
        continue;
      }
      // Control chars are technically invalid in strict JSON, but json.loads
      // (strict=True default) rejects raw control chars < 0x20. Reproduce.
      if (ch.charCodeAt(0) < 0x20) {
        err("Invalid control character");
      }
      out += ch;
      i += 1;
    }
  }

  function parseNumber(): number {
    const start = i;
    if (text[i] === "-") {
      i += 1;
    }
    while (i < n) {
      const c = text[i] as string;
      if (
        (c >= "0" && c <= "9") ||
        c === "." ||
        c === "e" ||
        c === "E" ||
        c === "+" ||
        c === "-"
      ) {
        i += 1;
      } else {
        break;
      }
    }
    const tok = text.slice(start, i);
    const num = Number(tok);
    if (Number.isNaN(num) || tok.length === 0) {
      err("Invalid number");
    }
    // Remember whether the source token was a float (had . / e / E) so dump can
    // re-emit ".0" for integral floats faithfully.
    if (/[.eE]/.test(tok)) {
      _floatTokens.add(num === 0 ? "0f" : tok);
      _isFloat.set(numKey(num), true);
    }
    return num;
  }

  const root = parseValue();
  skipWs();
  if (i !== n) {
    err("Extra data");
  }
  return root;
}

// Track which parsed numbers originated from float-shaped tokens so json.dumps
// parity can append ".0" for integral floats. Keyed by a stable numeric key.
const _floatTokens = new Set<string>();
const _isFloat = new Map<string, boolean>();
function numKey(n: number): string {
  return String(n);
}

// ===========================================================================
// json.dumps(obj, default=str) parity
// ===========================================================================

/** Python-compatible json.dumps with DEFAULT separators and ensure_ascii. */
function _jsonDumps(value: JsonValue): string {
  const parts: string[] = [];
  _dumpValue(value, parts);
  return parts.join("");
}

function _dumpValue(value: JsonValue, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  if (value === true) {
    out.push("true");
    return;
  }
  if (value === false) {
    out.push("false");
    return;
  }
  const t = typeof value;
  if (t === "string") {
    out.push(_dumpString(value as string));
    return;
  }
  if (t === "number") {
    out.push(_dumpNumber(value as number));
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let k = 0; k < value.length; k++) {
      if (k > 0) {
        out.push(", ");
      }
      _dumpValue(value[k] as JsonValue, out);
    }
    out.push("]");
    return;
  }
  if (value instanceof JsonObject) {
    out.push("{");
    let first = true;
    for (const [key, v] of value.entries) {
      if (!first) {
        out.push(", ");
      }
      first = false;
      out.push(_dumpString(key));
      out.push(": ");
      _dumpValue(v, out);
    }
    out.push("}");
    return;
  }
  // Should not happen for our value model.
  out.push(_dumpString(String(value)));
}

/** Python repr of a float/int for json.dumps. */
function _dumpNumber(num: number): string {
  if (Number.isNaN(num)) {
    return "NaN";
  }
  if (num === Infinity) {
    return "Infinity";
  }
  if (num === -Infinity) {
    return "-Infinity";
  }
  // If the source token was a float, json.dumps renders an integral float with
  // a trailing ".0" (e.g. 1.0). Integers render without a decimal point.
  if (Number.isInteger(num)) {
    if (_isFloat.get(numKey(num)) === true) {
      return `${num}.0`;
    }
    return String(num);
  }
  // Non-integral float: use the shortest round-trip repr (matches CPython's
  // float repr for the values that appear in config JSON).
  return String(num);
}

/**
 * json.dumps string serialisation with ensure_ascii=True (default): escapes
 * the control set plus quote/backslash, and emits non-ASCII as \\uXXXX.
 */
function _dumpString(s: string): string {
  let out = '"';
  for (let k = 0; k < s.length; k++) {
    const code = s.charCodeAt(k);
    const ch = s[k] as string;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      default:
        break;
    }
    if (code < 0x20 || code > 0x7e) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

/** Python type name for a JSON value (used by _safe_repr's fallback path). */
function _typeName(value: JsonValue): string {
  if (value === null) return "NoneType";
  if (value === true || value === false) return "bool";
  if (Array.isArray(value)) return "list";
  if (value instanceof JsonObject) return "dict";
  const t = typeof value;
  if (t === "string") return "str";
  if (t === "number") {
    return _isFloat.get(numKey(value as number)) === true || !Number.isInteger(value as number)
      ? "float"
      : "int";
  }
  return "object";
}

/** Return a safe string representation of a JSON value (max_len default 100). */
function _safe_repr(obj: JsonValue, max_len = 100): string {
  try {
    let s = _jsonDumps(obj);
    if ([...s].length > max_len) {
      s = _sliceCodepoints(s, max_len) + "...";
    }
    return s;
  } catch (exc) {
    _LOG.debug(
      "_safe_repr: json.dumps failed for %s: %s",
      _typeName(obj),
      exc instanceof Error ? exc.message : String(exc),
    );
    return _typeName(obj);
  }
}

/** Take the first n code points of s (Python s[:n]). */
function _sliceCodepoints(s: string, n: number): string {
  if (n <= 0) return "";
  let out = "";
  let count = 0;
  for (const ch of s) {
    if (count >= n) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** Length of s in code points. */
function _lenCodepoints(s: string): number {
  let len = 0;
  for (const _ of s) len += 1;
  return len;
}

// ===========================================================================
// extract
// ===========================================================================

export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  if (source.length < _MIN_JSON_SIZE) {
    // File too small for symbol indexing; still extract Sections for
    // pretty-printed files so `token-goat section` works on configs.
    let sections: Section[];
    try {
      const text_for_sections = source.toString("utf-8");
      sections = _extract_sections(text_for_sections);
    } catch (exc) {
      _LOG.debug(
        "json_idx: section decode failed for %s: %s",
        rel_path,
        exc instanceof Error ? exc.message : String(exc),
      );
      sections = [];
    }
    return [[], [], [], sections];
  }

  const text = source.toString("utf-8");
  const symbols: Symbol[] = [];

  // Try full JSON parse first.
  try {
    const data = _parseJson(text);
    if (data instanceof JsonObject) {
      _emit_dict_symbols(symbols, data);
    } else if (Array.isArray(data)) {
      _emit_array_symbols(symbols, data);
    }
    const sections = _extract_sections(text);
    return [symbols, [], [], sections];
  } catch (exc) {
    _LOG.debug(
      "json_idx: full parse failed for %s, falling back to regex: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
  }

  // Fallback: strict anchored pattern (pretty-printed JSON).
  _TOP_LEVEL_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _TOP_LEVEL_KEY_RE.exec(text)) !== null) {
    if (m.index === _TOP_LEVEL_KEY_RE.lastIndex) {
      _TOP_LEVEL_KEY_RE.lastIndex += 1;
    }
    if (symbols.length >= _MAX_SYMBOLS) {
      break;
    }
    const key = m[1] as string;
    symbols.push(new Symbol({ name: key, kind: "json_key", line: 1 }));
  }

  // If the anchored pattern found nothing, the file is likely minified.
  if (symbols.length === 0) {
    const seen = new Set<string>();
    _ANY_KEY_RE.lastIndex = 0;
    while ((m = _ANY_KEY_RE.exec(text)) !== null) {
      if (m.index === _ANY_KEY_RE.lastIndex) {
        _ANY_KEY_RE.lastIndex += 1;
      }
      if (symbols.length >= _MAX_SYMBOLS) {
        break;
      }
      const key = m[1] as string;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      symbols.push(new Symbol({ name: key, kind: "json_key", line: 1 }));
    }
  }

  const sections = _extract_sections(text);
  return [symbols, [], [], sections];
}

function _extract_sections(text: string): Section[] {
  if (!text) {
    return [];
  }

  const matches: Array<[number, string]> = [];
  const seen_at_line = new Set<number>();
  _SECTION_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _SECTION_KEY_RE.exec(text)) !== null) {
    if (m.index === _SECTION_KEY_RE.lastIndex) {
      _SECTION_KEY_RE.lastIndex += 1;
    }
    const key = m[1] as string;
    if (!key) {
      continue;
    }
    const depth = _depth_before(text, m.index);
    if (depth !== 1) {
      continue;
    }
    const line = _countNewlines(text.slice(0, m.index)) + 1;
    if (seen_at_line.has(line)) {
      continue;
    }
    seen_at_line.add(line);
    matches.push([line, key]);
    if (matches.length >= _MAX_SECTIONS_PER_FILE) {
      break;
    }
  }

  if (matches.length === 0) {
    return [];
  }

  const total_lines = _countNewlines(text) + 1;
  const sections: Section[] = [];
  for (let i = 0; i < matches.length; i++) {
    const [line, key] = matches[i] as [number, string];
    let end_line =
      i + 1 < matches.length ? (matches[i + 1] as [number, string])[0] - 1 : total_lines;
    end_line = Math.max(line, end_line);
    sections.push(new Section({ heading: key, level: 1, line, end_line }));
  }
  return sections;
}

/** Compute the brace/bracket depth at offset into text (string-aware). */
function _depth_before(text: string, offset: number): number {
  let depth = 0;
  let in_string = false;
  let escape = false;
  for (let i = 0; i < offset; i++) {
    const ch = text[i] as string;
    if (in_string) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        in_string = false;
      }
      continue;
    }
    if (ch === '"') {
      in_string = true;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
    }
  }
  return depth;
}

/** Count "\n" occurrences in s (Python str.count("\n")). */
function _countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      count += 1;
    }
  }
  return count;
}

function _emit_dict_symbols(symbols: Symbol[], data: JsonObject): void {
  let nested_budget = _MAX_NESTED_SYMBOLS;
  let i = 0;
  for (const [key, value] of data.entries) {
    if (symbols.length >= _MAX_SYMBOLS) {
      break;
    }
    symbols.push(
      new Symbol({
        name: key,
        kind: "json_key",
        line: 1,
        signature: _safe_repr(value),
      }),
    );
    if (nested_budget > 0 && value instanceof JsonObject) {
      for (const [child_key, child_value] of value.entries) {
        if (nested_budget <= 0 || symbols.length >= _MAX_SYMBOLS) {
          break;
        }
        symbols.push(
          new Symbol({
            name: `${key}.${child_key}`,
            kind: "json_nested_key",
            line: 1,
            signature: _safe_repr(child_value),
          }),
        );
        nested_budget -= 1;
      }
    }
    if (i >= _MAX_SYMBOLS) {
      break;
    }
    i += 1;
  }
}

function _emit_array_symbols(symbols: Symbol[], data: JsonValue[]): void {
  symbols.push(
    new Symbol({
      name: `[${data.length}]`,
      kind: "json_array",
      line: 1,
      signature: `array of ${data.length} items`,
    }),
  );
  if (data.length === 0) {
    return;
  }
  const first = data[0] as JsonValue;
  if (!(first instanceof JsonObject)) {
    return;
  }
  let i = 0;
  for (const [child_key, child_value] of first.entries) {
    if (i >= _MAX_ARRAY_ELEMENT_KEYS || symbols.length >= _MAX_SYMBOLS) {
      break;
    }
    symbols.push(
      new Symbol({
        name: `[].${child_key}`,
        kind: "json_array_element_key",
        line: 1,
        signature: _safe_repr(child_value),
      }),
    );
    i += 1;
  }
}

// Keep _lenCodepoints referenced (used in _safe_repr length guard).
void _lenCodepoints;
