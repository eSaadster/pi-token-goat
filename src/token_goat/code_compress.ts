/**
 * Structural skeleton extraction for post-read code compression.
 *
 * Faithful 1:1 port of src/token_goat/code_compress.py.
 */

const _SUPPORTED_EXT: ReadonlySet<string> = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs",
  ".java",
]);

// Python regexes
const _PY_IMPORT_RE = /^(import |from )/;
const _PY_DEF_RE = /^(async\s+)?def\s|^class\s/;
const _PY_DECORATOR_RE = /^@/;
const _PY_DUNDER_ALL_RE = /^__all__\s*=/;
// Matches CamelCase type aliases (MyType = ...) and explicit TypeAlias
// annotations (X: TypeAlias = ...)
const _PY_TYPE_ALIAS_RE = /^[A-Z]\w*\s*(?::\s*\w+\s*)?=/;

// JS/TS: matches function/class/interface/type/enum declarations and
// const/let/var arrow functions
const _JS_SIG_RE =
  /^\s*(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|async\s+)*(?:function\b|class\b|interface\b|type\b|enum\b|const\s+\w|let\s+\w|var\s+\w)/;

// Go: function and type-struct/interface declarations
const _GO_SIG_RE = /^\s*(?:func\s|type\s+\w+\s+(?:struct|interface)\b)/;

// Rust: pub/priv fn, struct, enum, trait, impl
const _RUST_SIG_RE =
  /^\s*(?:pub(?:\s+\(crate\))?\s+)?(?:async\s+)?(?:fn\s|struct\s|enum\s|trait\s|impl\b)/;

// Java: method and class/interface/enum declarations with access modifiers
const _JAVA_SIG_RE =
  /^\s*(?:(?:public|private|protected|static|abstract|final|native|synchronized)\s+)+(?:class\b|interface\b|enum\b|void\b|\w+)\s+\w+\s*[(<]/;

// Import/use/require for non-Python languages
const _IMPORT_RE = /^\s*(?:import\b|from\b|use\b|require\b)/;

/**
 * Return a structural skeleton of source, or null for unsupported extensions.
 *
 * For Python files, keeps all import lines, __all__ assignments, top-level type
 * aliases, and all def/class signatures (with decorators) at any nesting level.
 * Each body block is replaced with ``# ... N lines`` at the appropriate indent.
 *
 * For JS/TS/Go/Rust/Java files, applies best-effort signature extraction based
 * on common patterns, replacing brace-delimited bodies with ``// ... N lines``.
 *
 * Returns null for unsupported extensions (pass-through signal to the caller).
 */
export function compress_to_skeleton(
  source: string,
  file_ext: string,
): string | null {
  if (!_SUPPORTED_EXT.has(file_ext)) {
    return null;
  }
  if (!source) {
    return "";
  }
  if (file_ext === ".py") {
    return _compress_python(source);
  }
  return _compress_brace_lang(source, file_ext);
}

/** Line-by-line Python skeleton extractor. */
function _compress_python(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i]!;
    const stripped = line.replace(/^\s+/, "");
    const indent = line.length - stripped.length;

    if (!stripped) {
      i += 1;
      continue;
    }

    // Top-level import lines kept verbatim
    if (indent === 0 && _PY_IMPORT_RE.test(stripped)) {
      out.push(line);
      i += 1;
      continue;
    }

    // Top-level __all__ = [...] kept verbatim
    if (indent === 0 && _PY_DUNDER_ALL_RE.test(stripped)) {
      out.push(line);
      i += 1;
      continue;
    }

    // Top-level type alias: CamelCase = ... or X: TypeAlias = ...
    if (indent === 0 && _PY_TYPE_ALIAS_RE.test(stripped)) {
      out.push(line);
      i += 1;
      continue;
    }

    // Decorator at any indent kept verbatim
    if (_PY_DECORATOR_RE.test(stripped)) {
      out.push(line);
      i += 1;
      continue;
    }

    // def / async def / class at any indent: emit signature, suppress body
    if (_PY_DEF_RE.test(stripped)) {
      out.push(line);
      i += 1;
      let body_count = 0;
      while (i < n) {
        const nxt = lines[i]!;
        const nxt_s = nxt.replace(/^\s+/, "");
        if (!nxt_s) {
          i += 1;
          continue;
        }
        const nxt_indent = nxt.length - nxt_s.length;
        if (nxt_indent <= indent) {
          break;
        }
        // Nested def/class/decorator: stop counting, let outer loop emit it
        if (_PY_DECORATOR_RE.test(nxt_s) || _PY_DEF_RE.test(nxt_s)) {
          break;
        }
        body_count += 1;
        i += 1;
      }
      if (body_count > 0) {
        const body_pfx = " ".repeat(indent + 4);
        out.push(`${body_pfx}# ... ${body_count} lines`);
      }
      continue;
    }

    // Skip all other lines (body code, non-type-alias assignments, comments,
    // etc.)
    i += 1;
  }

  return out.join("\n");
}

/**
 * Advance past a brace-delimited block starting at initial_depth > 0.
 *
 * Returns [next_line_index, body_line_count] where body_line_count counts
 * lines consumed before the depth returned to zero.
 */
function _skip_brace_body(
  lines: string[],
  start: number,
  initial_depth: number,
): [number, number] {
  let depth = initial_depth;
  let body_count = 0;
  let i = start;
  const n = lines.length;
  while (i < n && depth > 0) {
    for (const ch of lines[i]!) {
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    if (depth > 0) {
      body_count += 1;
    }
    i += 1;
  }
  return [i, body_count];
}

/** Best-effort skeleton extractor for brace-delimited languages. */
function _compress_brace_lang(source: string, file_ext: string): string {
  let sig_re: RegExp;
  if (
    file_ext === ".js" ||
    file_ext === ".jsx" ||
    file_ext === ".ts" ||
    file_ext === ".tsx"
  ) {
    sig_re = _JS_SIG_RE;
  } else if (file_ext === ".go") {
    sig_re = _GO_SIG_RE;
  } else if (file_ext === ".rs") {
    sig_re = _RUST_SIG_RE;
  } else {
    sig_re = _JAVA_SIG_RE;
  }

  const lines = source.split("\n");
  const out: string[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i]!;
    const stripped = line.replace(/^\s+/, "");

    if (!stripped) {
      i += 1;
      continue;
    }

    // Import/use/require lines kept verbatim
    if (_IMPORT_RE.test(stripped)) {
      out.push(line);
      i += 1;
      continue;
    }

    if (sig_re.test(line) || sig_re.test(stripped)) {
      out.push(line);
      i += 1;
      // Calculate brace depth opened by the signature line itself
      let depth = _count(line, "{") - _count(line, "}");
      if (depth > 0) {
        const [next_i, body_count] = _skip_brace_body(lines, i, depth);
        if (body_count > 0) {
          out.push(`// ... ${body_count} lines`);
        }
        i = next_i;
      } else if (i < n && lines[i]!.trim() === "{") {
        // Allman-style: opening brace on its own line
        depth = 1;
        i += 1;
        const [next_i, body_count] = _skip_brace_body(lines, i, depth);
        if (body_count > 0) {
          out.push(`// ... ${body_count} lines`);
        }
        i = next_i;
      }
      continue;
    }

    i += 1;
  }

  return out.join("\n");
}

/** Count occurrences of a single character in a string. */
function _count(s: string, ch: string): number {
  let c = 0;
  for (const x of s) {
    if (x === ch) {
      c += 1;
    }
  }
  return c;
}
