/**
 * Protocol Buffers (.proto) extractor — messages, services, RPCs, enums.
 *
 * Faithful port of src/token_goat/languages/proto_idx.py. Strict NodeNext ESM.
 *
 * `.proto` files define the contract between services and can grow large.
 * Agents typically need one message or RPC definition, not the whole IDL. This
 * extractor gives `token-goat section api.proto::UserRequest` the ability to
 * return a 20-line message block instead of the full file.
 *
 * Pure-regex scanner at column-0 anchoring (or minimal indentation for `rpc` and
 * `oneof` which appear inside blocks). No tree-sitter. Block and line comments
 * are stripped in a pre-pass (common.strip_cstyle_comments) so names inside
 * comments don't appear as false positives.
 *
 * Line numbers are derived by counting "\n" in the character prefix before each
 * match (Python `stripped[:m.start()].count("\n") + 1`).
 */

import { ImpExp, type Ref, type Section, type Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import * as common from "./common.js";

const _strip_comments = common.strip_cstyle_comments;

const _LOG = getLogger("languages.proto_idx");

// ---------------------------------------------------------------------------
// Extraction regexes
// ---------------------------------------------------------------------------

// Top-level `message Name` / `enum Name` / `service Name` at column 0.
const _TOP_LEVEL_RE =
  /^(message|enum|service)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;

// `extend QualifiedName { }` — target type may be dotted (google.protobuf.X).
const _EXTEND_RE = /^extend\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{/gm;

// `rpc MethodName(...)` inside a service block.
const _RPC_RE = /^\s+rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

// `oneof name { }` inside a message.
const _ONEOF_RE = /^\s+oneof\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;

// `import "path/to/other.proto";` — file-level import directive. Both double and
// single quotes accepted; `weak` and `public` modifiers allowed before the path.
const _IMPORT_RE = /^import\s+(?:weak\s+|public\s+)?["']([^"']+)["']/gm;

// ---------------------------------------------------------------------------
// Map keyword -> symbol kind.
// ---------------------------------------------------------------------------

const _KIND_MAP: Record<string, string> = {
  message: "proto_message",
  enum: "proto_enum",
  service: "proto_service",
};

/** Count "\n" in `s` (Python str.count("\n")). */
function _countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      n += 1;
    }
  }
  return n;
}

/**
 * Extract Protocol Buffer symbols, imports, and sections from `source`.
 *
 * Return signature matches every other language extractor:
 * `(symbols, refs, imports, sections)`. `import "..."` directives are returned
 * as ImpExp entries with kind="import".
 */
export function extract(
  source: Buffer,
  rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const text = common.decode_source_text(source, _LOG, "proto_idx");
  if (text === null) {
    return [[], [], [], []];
  }

  try {
    const stripped = _strip_comments(text);
    const total_lines = _countNewlines(text) + 1;

    const symbols: Symbol[] = [];
    const imp_exp: ImpExp[] = [];
    const sections: Section[] = [];
    const seen: Set<string> = new Set();

    const _emit = common.make_symbol_emitter(symbols, sections, seen);

    // import "path/to/file.proto" — extracted from the stripped text.
    _IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = _IMPORT_RE.exec(stripped)) !== null) {
      if (m.index === _IMPORT_RE.lastIndex) {
        _IMPORT_RE.lastIndex += 1;
      }
      const path = (m[1] ?? "").trim();
      if (path) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        imp_exp.push(new ImpExp({ kind: "import", target: path, line }));
      }
    }

    // Top-level: message / enum / service
    _TOP_LEVEL_RE.lastIndex = 0;
    while ((m = _TOP_LEVEL_RE.exec(stripped)) !== null) {
      if (m.index === _TOP_LEVEL_RE.lastIndex) {
        _TOP_LEVEL_RE.lastIndex += 1;
      }
      const keyword = m[1] as string;
      const name = (m[2] ?? "").trim();
      if (name) {
        const kind = _KIND_MAP[keyword] ?? "proto_message";
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, kind, line);
      }
    }

    // extend QualifiedName { } — target may be dotted (google.protobuf.X)
    _EXTEND_RE.lastIndex = 0;
    while ((m = _EXTEND_RE.exec(stripped)) !== null) {
      if (m.index === _EXTEND_RE.lastIndex) {
        _EXTEND_RE.lastIndex += 1;
      }
      const name = (m[1] ?? "").trim();
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, "proto_extend", line);
      }
    }

    // rpc methods inside services
    _RPC_RE.lastIndex = 0;
    while ((m = _RPC_RE.exec(stripped)) !== null) {
      if (m.index === _RPC_RE.lastIndex) {
        _RPC_RE.lastIndex += 1;
      }
      const name = (m[1] ?? "").trim();
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, "proto_rpc", line);
      }
    }

    // oneof groups inside messages
    _ONEOF_RE.lastIndex = 0;
    while ((m = _ONEOF_RE.exec(stripped)) !== null) {
      if (m.index === _ONEOF_RE.lastIndex) {
        _ONEOF_RE.lastIndex += 1;
      }
      const name = (m[1] ?? "").trim();
      if (name) {
        const line = _countNewlines(stripped.slice(0, m.index)) + 1;
        _emit(name, "proto_oneof", line);
      }
    }

    // Sort sections by line then assign end_lines.
    sections.sort((a, b) => a.line - b.line);
    common.assign_flat_end_lines(sections, total_lines);

    return [symbols, [], imp_exp, sections];
  } catch (exc) {
    _LOG.debug(
      "proto_idx: parse failed for %s: %s",
      rel_path,
      exc instanceof Error ? exc.message : String(exc),
    );
    return [[], [], [], []];
  }
}
