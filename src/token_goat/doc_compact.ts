/**
 * Stable-doc compact serving for large reference docs.
 *
 * Faithful port of src/token_goat/doc_compact.py.
 *
 * A compact is a user-created or auto-extractive summary of a large reference
 * doc, stored as a sidecar file in the token-goat data dir. When pre_read
 * detects that a compact exists and is fresh (source hash matches), it serves
 * the compact instead of the full file.
 *
 * Sidecar layout:
 *   <data_dir>/doc_compacts/<project_hash>/<slug>.compact.md
 *   slug = sha256(abs_path_lower)[:12] + "_" + stem_slug[:32]
 *
 * Compact file format:
 *   Line 1: <!-- token-goat doc-compact source-hash:<sha256> source:<rel_path> -->
 *   Line 2+: compact body (markdown)
 *
 * Parity notes (Python → TS):
 *  - pathlib.Path → string paths throughout (mirroring paths.ts). Every function
 *    that took `str | Path` accepts a `string`; every function that returned a
 *    `Path` returns a `string`. The Python tests assert `p.name.endswith(...)`
 *    and `p1 == p2`; in TS these become `path.basename(p).endsWith(...)` and
 *    `p1 === p2` (plain string equality), which hold because the path strings
 *    are produced deterministically.
 *  - Path(file_path).resolve() → path.resolve(filePath). Path(...).stem →
 *    basename minus the final extension (via path.parse(...).name). Path(...).
 *    name → path.basename(...).
 *  - hashlib.sha256(...).hexdigest() → crypto.createHash("sha256").digest("hex").
 *    The lowercase-then-utf8-encode for the slug hash uses Buffer.from(s, "utf8")
 *    so it is byte-identical to Python's str.lower().encode().
 *  - source_path.read_bytes() / read_text(errors="replace") → fs.readFileSync.
 *    read_text(encoding="utf-8", errors="replace") maps to
 *    fs.readFileSync(p, "utf8") (Node substitutes U+FFFD for invalid UTF-8, the
 *    same fail-soft contract as errors="replace"). OSError → any thrown fs error
 *    is caught and folded into the None/"" branch.
 *  - str.splitlines(keepends=True) has no JS builtin; _splitlinesKeepends below
 *    reproduces Python's line-boundary set restricted to the boundaries this
 *    module actually encounters (\n, \r\n, \r) plus the no-trailing-newline
 *    case. read_compact_body/mark_compact_stale rely on it.
 *  - str.rstrip("\n\r") → a manual trailing-CR/LF strip (JS trimEnd would also
 *    eat spaces/tabs, which Python's rstrip("\n\r") does NOT). str.lstrip("\n")
 *    → a manual leading-LF strip (same reasoning). str.strip() (whitespace) →
 *    .trim() (both strip ASCII + Unicode whitespace; inputs here are ASCII).
 *  - re.compile(...) → top-level RegExp literals compiled once at module load.
 *    _HEADER_RE preserves the exact pattern including the `^...$` anchors and the
 *    non-greedy `(.+?)` capture; matched against a single (already newline-
 *    stripped) line so there is no multiline concern. re.match anchors at start;
 *    JS RegExp.exec with a `^`-anchored pattern is the equivalent.
 *  - lazy `from . import paths` / `from . import db` → top-level imports of
 *    ./paths.js and ./db.js. The Python laziness was for import-cycle avoidance;
 *    in the TS layering both are Layer 1 and safe to import eagerly. ESM has no
 *    synchronous dynamic-import analogue of Python's in-function `import`, so the
 *    db import is hoisted; get_section_headings is the only consumer and is not
 *    exercised by the ported test suite (its caller, hints, is deferred). The
 *    conn.execute(sql, params).fetchall() pattern maps to better-sqlite3's
 *    prepare(sql).all(...params); `row["heading"]` → `row.heading`.
 *  - _LOG.debug(...) → util.ts getLogger("doc_compact").debug(...). No test
 *    asserts on these debug lines (caplog is not used in this suite).
 *  - No module-global mutable cache exists in doc_compact.py, so no registerReset
 *    is needed. (Confirmed by reading the source: the only module-level state is
 *    the immutable constants and compiled regex.)
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional return values are `T | null`
 *    where the Python returned `... | None` (read_compact_header,
 *    read_compact_body, find_compact_for_path), preserving the null sentinel the
 *    tests assert on (`is None`); the source_rel keyword default ("") is spelled
 *    explicitly.
 * `noUncheckedIndexedAccess` is on → every lines[i] / match group access is
 *    narrowed before use.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import * as paths from "./paths.js";
import * as db from "./db.js";
import { getLogger } from "./util.js";

const _LOG = getLogger("doc_compact");

// Maximum heading preview items in section-map hints.
export const _SECTION_MAP_MAX = 10;

// Extractive compact: sentences collected per section heading.
export const _DEFAULT_SENTENCES_PER_SECTION = 2;

// Header line format (must fit on one line).
export const _HEADER_PREFIX = "<!-- token-goat doc-compact source-hash:";

const _HEADER_RE = /^<!-- token-goat doc-compact source-hash:(\S+) source:(.+?) -->$/;

// ---------------------------------------------------------------------------
// Internal string helpers (Python str method analogues with exact semantics).
// ---------------------------------------------------------------------------

/**
 * Reproduce Python's str.rstrip("\n\r"): strip ONLY trailing CR/LF characters
 * (not arbitrary whitespace, which JS trimEnd would also remove).
 */
function _rstripNewlines(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s.charAt(end - 1);
    if (ch === "\n" || ch === "\r") {
      end -= 1;
    } else {
      break;
    }
  }
  return s.slice(0, end);
}

/**
 * Reproduce Python's str.lstrip("\n"): strip ONLY leading LF characters.
 */
function _lstripNewlines(s: string): string {
  let start = 0;
  while (start < s.length && s.charAt(start) === "\n") {
    start += 1;
  }
  return s.slice(start);
}

/**
 * Reproduce Python's str.splitlines(keepends=True) for the line boundaries this
 * module's inputs contain: \r\n, \n, \r. Each returned element retains its
 * terminator; a final line with no terminator is included as-is. An empty
 * string yields [] (matching Python).
 */
function _splitlinesKeepends(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  let lineStart = 0;
  while (i < n) {
    const ch = s.charAt(i);
    if (ch === "\r") {
      if (i + 1 < n && s.charAt(i + 1) === "\n") {
        out.push(s.slice(lineStart, i + 2));
        i += 2;
      } else {
        out.push(s.slice(lineStart, i + 1));
        i += 1;
      }
      lineStart = i;
    } else if (ch === "\n") {
      out.push(s.slice(lineStart, i + 1));
      i += 1;
      lineStart = i;
    } else {
      i += 1;
    }
  }
  if (lineStart < n) {
    out.push(s.slice(lineStart));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function _docCompactsDir(projectHash: string): string {
  return path.join(paths.dataDir(), "doc_compacts", projectHash);
}

/** Deterministic filename component: hash prefix + stem slug. */
function _compactSlug(absPathStr: string): string {
  const h = crypto
    .createHash("sha256")
    .update(Buffer.from(absPathStr.toLowerCase(), "utf8"))
    .digest("hex")
    .slice(0, 12);
  // Path(abs_path_str).stem → filename without its final extension.
  const stem = path.parse(absPathStr).name;
  // re.sub(r"[^a-zA-Z0-9_-]", "_", stem)[:32].strip("_")
  const safeStem = _stripUnderscores(
    stem.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32),
  );
  return `${h}_${safeStem}`;
}

/** Reproduce Python's str.strip("_"): strip leading and trailing underscores. */
function _stripUnderscores(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charAt(start) === "_") start += 1;
  while (end > start && s.charAt(end - 1) === "_") end -= 1;
  return s.slice(start, end);
}

/** Return the sidecar compact path for *filePath* within *projectHash*. */
export function compact_path_for(filePath: string, projectHash: string): string {
  const absStr = path.resolve(filePath);
  return path.join(
    _docCompactsDir(projectHash),
    _compactSlug(absStr) + ".compact.md",
  );
}

/** Return the compact path if it exists on disk, else null. */
export function find_compact_for_path(
  filePath: string,
  projectHash: string,
): string | null {
  const p = compact_path_for(filePath, projectHash);
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Header / freshness
// ---------------------------------------------------------------------------

/** SHA-256 of source file content. */
function _source_sha256(sourcePath: string): string {
  try {
    const data = fs.readFileSync(sourcePath);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Parse the first line of a compact file.
 *
 * Returns [source_hash, source_rel] or null if the header is missing/invalid.
 */
export function read_compact_header(
  compactPath: string,
): [string, string] | null {
  let firstLine: string;
  try {
    const text = fs.readFileSync(compactPath, "utf8");
    // Python reads only the first line via fh.readline(); replicate by reading
    // up to the first \n (the file is small) and rstrip("\n\r").
    const nl = text.indexOf("\n");
    const raw = nl === -1 ? text : text.slice(0, nl + 1);
    firstLine = _rstripNewlines(raw);
  } catch {
    return null;
  }
  const m = _HEADER_RE.exec(firstLine);
  if (m === null) {
    return null;
  }
  return [m[1]!, m[2]!];
}

/** Return true if the compact's source hash matches the current source file. */
export function is_compact_fresh(
  compactPath: string,
  sourcePath: string,
): boolean {
  const header = read_compact_header(compactPath);
  if (header === null) {
    return false;
  }
  const storedHash = header[0];
  if (storedHash === "STALE") {
    return false;
  }
  const currentHash = _source_sha256(sourcePath);
  return Boolean(currentHash) && currentHash === storedHash;
}

/**
 * Replace the source-hash in the header with 'STALE'.
 *
 * Called by the worker after the source file is edited. Fails silently
 * (returns false) if the compact does not exist or cannot be rewritten.
 */
export function mark_compact_stale(compactPath: string): boolean {
  if (!fs.existsSync(compactPath)) {
    return false;
  }
  let text: string;
  try {
    text = fs.readFileSync(compactPath, "utf8");
  } catch {
    return false;
  }
  const lines = _splitlinesKeepends(text);
  if (lines.length === 0) {
    return false;
  }
  const firstLine = lines[0]!;
  const m = _HEADER_RE.exec(_rstripNewlines(firstLine));
  if (m === null || m[1] === "STALE") {
    return false; // already stale or wrong format
  }
  const oldHash = m[1]!;
  lines[0] = _replaceOnce(
    firstLine,
    `source-hash:${oldHash}`,
    "source-hash:STALE",
  );
  try {
    paths.atomicWriteText(compactPath, lines.join(""));
    _LOG.debug(
      "doc_compact.mark_compact_stale: marked stale %s",
      path.basename(compactPath),
    );
    return true;
  } catch (exc) {
    _LOG.debug(
      "doc_compact.mark_compact_stale: write failed for %s: %s",
      path.basename(compactPath),
      exc,
    );
    return false;
  }
}

/** Reproduce Python's str.replace(old, new, 1): replace the first occurrence only. */
function _replaceOnce(s: string, oldStr: string, newStr: string): string {
  const idx = s.indexOf(oldStr);
  if (idx === -1) {
    return s;
  }
  return s.slice(0, idx) + newStr + s.slice(idx + oldStr.length);
}

// ---------------------------------------------------------------------------
// Read / write compact body
// ---------------------------------------------------------------------------

/**
 * Read the compact body (everything after the header line).
 *
 * Returns null if the file cannot be read or has no body.
 */
export function read_compact_body(compactPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(compactPath, "utf8");
  } catch {
    return null;
  }
  const lines = _splitlinesKeepends(text);
  if (lines.length < 2) {
    return null;
  }
  const body = _lstripNewlines(lines.slice(1).join(""));
  return body.trim() ? body : null;
}

/**
 * Write a compact sidecar file with the correct header.
 *
 * @param compactPath Destination path (parent dir must exist or will be created).
 * @param sourcePath  Absolute path to the source document (used for hash).
 * @param compactBody Markdown compact text (no header line).
 * @param sourceRel   Optional relative path for display in the header.
 */
export function write_compact(
  compactPath: string,
  sourcePath: string,
  compactBody: string,
  opts?: { source_rel?: string },
): void {
  const sourceRel = opts?.source_rel ?? "";
  const sha = _source_sha256(sourcePath);
  const displayRel = sourceRel || path.basename(sourcePath);
  const header = `${_HEADER_PREFIX}${sha} source:${displayRel} -->\n`;
  const fullText = header + _lstripNewlines(compactBody);
  paths.ensureDir(path.dirname(compactPath));
  paths.atomicWriteText(compactPath, fullText);
  _LOG.debug(
    "doc_compact.write_compact: wrote %d chars to %s",
    fullText.length,
    path.basename(compactPath),
  );
}

// ---------------------------------------------------------------------------
// Extractive compact builder
// ---------------------------------------------------------------------------

/**
 * Build a compact from markdown text: headings + first N sentences per section.
 *
 * Algorithm:
 *  - Emit every ATX heading verbatim (# / ## / ### etc.).
 *  - After each heading, collect the first `maxSentences` non-empty
 *    non-heading lines.
 *  - Code blocks (``` fences) are included verbatim up to 10 lines.
 *  - Front-matter (--- fences at top) is skipped.
 *
 * This is intentionally simple and deterministic — no NLP, no LLM.
 */
export function build_extractive_compact(
  text: string,
  opts?: { max_sentences?: number },
): string {
  const maxSentences = opts?.max_sentences ?? _DEFAULT_SENTENCES_PER_SECTION;

  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const n = lines.length;

  // Skip YAML front-matter.
  if (lines.length > 0 && lines[0]!.trim() === "---") {
    i = 1;
    while (i < n && lines[i]!.trim() !== "---") {
      i += 1;
    }
    i += 1; // skip closing ---
  }

  let inCodeBlock = false;
  let codeBlockLines = 0;
  let currentHeading: string | null = null;
  let sentencesEmitted = 0;

  while (i < n) {
    const line = lines[i]!;
    const stripped = line.trim();

    // Track fenced code blocks.
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLines = 0;
        if (currentHeading !== null && sentencesEmitted < maxSentences) {
          out.push(line);
          codeBlockLines += 1;
        }
      } else {
        inCodeBlock = false;
        if (currentHeading !== null && sentencesEmitted < maxSentences) {
          out.push(line);
          sentencesEmitted += 1;
        }
      }
      i += 1;
      continue;
    }

    if (inCodeBlock) {
      if (
        codeBlockLines < 10 &&
        currentHeading !== null &&
        sentencesEmitted < maxSentences
      ) {
        out.push(line);
        codeBlockLines += 1;
      }
      i += 1;
      continue;
    }

    // ATX heading.
    const headingMatch = /^(#{1,6})\s+(.*)/.exec(stripped);
    if (headingMatch !== null) {
      currentHeading = stripped;
      sentencesEmitted = 0;
      out.push("");
      out.push(line);
      i += 1;
      continue;
    }

    // Collect content lines after a heading.
    if (
      currentHeading !== null &&
      sentencesEmitted < maxSentences &&
      stripped
    ) {
      out.push(line);
      sentencesEmitted += 1;
    }
    i += 1;
  }

  // Clean up: deduplicate blank lines, strip trailing whitespace.
  const resultLines: string[] = [];
  let prevBlank = false;
  for (const ln of out) {
    const isBlank = !ln.trim();
    if (isBlank && prevBlank) {
      continue;
    }
    resultLines.push(ln);
    prevBlank = isBlank;
  }

  return _stripWhitespace(resultLines.join("\n")) + "\n";
}

/** Reproduce Python's str.strip() (strip leading + trailing whitespace). */
function _stripWhitespace(s: string): string {
  return s.replace(/^\s+/, "").replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------
// Section map query (for hints)
// ---------------------------------------------------------------------------

/**
 * Query the DB for section headings in a markdown file.
 *
 * Returns heading strings in line order. Returns [] on any error.
 */
export function get_section_headings(
  relPath: string,
  projectHash: string,
  opts?: { limit?: number },
): string[] {
  const limit = opts?.limit ?? 20;
  try {
    return db.openProjectReadonly(projectHash, (conn) => {
      const rows = conn
        .prepare(
          "SELECT heading FROM sections WHERE file_rel = ? AND end_line IS NOT NULL ORDER BY line LIMIT ?",
        )
        .all(relPath, limit) as Array<{ heading: string }>;
      return rows.map((r) => r.heading);
    });
  } catch (exc) {
    _LOG.debug(
      "doc_compact.get_section_headings: DB error for %s: %s",
      relPath,
      exc,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// camelCase aliases (JS-idiomatic surface; snake_case names above are the
// canonical contract the Python tests import).
// ---------------------------------------------------------------------------

export const compactPathFor = compact_path_for;
export const findCompactForPath = find_compact_for_path;
export const readCompactHeader = read_compact_header;
export const isCompactFresh = is_compact_fresh;
export const markCompactStale = mark_compact_stale;
export const readCompactBody = read_compact_body;
export const writeCompact = write_compact;
export const buildExtractiveCompact = build_extractive_compact;
export const getSectionHeadings = get_section_headings;
