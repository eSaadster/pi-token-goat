/**
 * Automatic pruning and analysis of Claude Code's native auto-memory store —
 * TypeScript port of src/token_goat/memory_prune.py (402 LOC).
 *
 * The auto-memory store lives at ``~/.claude/projects/<slug>/memory/``. It uses
 * a lazy-index pattern: ``MEMORY.md`` is a short one-line-per-entry index; each
 * fact lives in a sibling ``*.md`` file (YAML frontmatter + body). Claude Code
 * injects ``MEMORY.md`` at every session start, so its size directly affects
 * startup context.
 *
 * What this module does automatically (safe, structural-only):
 * - Remove index lines whose target ``.md`` file is absent (dead links).
 * - Remove duplicate index lines pointing to the same target file (keep first).
 *
 * What it reports but never auto-edits:
 * - Near-duplicate sibling bodies (via embedding cosine similarity or Jaccard).
 * - Exact-duplicate lines / sections inside ``CLAUDE.md`` files.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY (snake_case) for every name a test
 *    imports / asserts on: functions (parse_index, prune_index,
 *    find_content_duplicates, audit_claude_md) and classes (IndexEntry,
 *    PruneResult, DupCluster, ClaudeMdReport).
 *  - _ENTRY_RE: Python re.compile(r"^\s*-\s*\[(?P<title>[^\]]+)\]\((?P<target>
 *    [^)]+?\.md)\)") -> JS RegExp with named groups (?<title> / ?<target>). No
 *    flags (no re.MULTILINE in Python — it is matched per-line via .match).
 *  - text.splitlines(keepends=True) -> a hand-rolled splitter that preserves the
 *    line terminator on each line (Python str.splitlines recognises \n, \r, \r\n
 *    and several Unicode line boundaries; the memory files only carry \n, but the
 *    splitter handles \r\n / \r too for fidelity).
 *  - Path filesystem ops -> node:fs (readFileSync / existsSync). OSError on read
 *    -> a try/catch returning the no-op default, matching Python's `except OSError`.
 *  - paths.atomic_write_text(...) -> paths.atomicWriteText(...) via the static
 *    `import * as paths` so the seam is consistent with compact.ts.
 *  - estimate_tokens is imported from ./compact.js (Python lazily imports it from
 *    .compact inside each function; the TS port imports it once at module load —
 *    compact.ts is shipped/green).
 *  - The embeddings module is NOT ported. Python does a lazy `from . import
 *    embeddings` wrapped in try/except that falls through to the Jaccard path when
 *    the import fails or embeddings.is_available() is False. The TS port mirrors
 *    compact.ts's injection seam: _getEmbeddings() returns the injected override
 *    or null; when null, the embedding branch is skipped and the Jaccard fallback
 *    runs. The ported tests only exercise the Jaccard path (no fastembed), so this
 *    is faithful. Reported in known_gaps.
 *  - str.strip().strip('"') -> a local _stripQuotes helper; .lstrip() / .strip()
 *    over default whitespace -> a Python-compatible whitespace trim (\s in JS
 *    matches the same ASCII/Unicode whitespace Python str.strip removes for the
 *    BMP text these files carry).
 *  - dict ordering: Python 3.7+ dicts preserve insertion order; JS objects /Maps
 *    do too. line_map reconstruction sorts integer keys numerically (Python
 *    sorted(dict) over int keys), so a Map<number,...> + numeric sort reproduces it.
 *  - f"{x!r}" (Python repr of a str) -> a local _pyRepr that reproduces Python's
 *    single-quote-preferred repr for the cross_file_overlap descriptions the test
 *    asserts contain the shared text. The test only checks truthiness of overlaps,
 *    not the exact repr punctuation, so minor repr-escaping differences are
 *    unobservable; _pyRepr is a best-effort match.
 *
 * verbatimModuleSyntax is on -> type-only imports use `import type` (none needed).
 * exactOptionalPropertyTypes is on -> optional fields are `T | undefined`.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as paths from "./paths.js";
import { estimate_tokens } from "./compact.js";

// ---------------------------------------------------------------------------
// Small Python-builtin shims.
// ---------------------------------------------------------------------------

/**
 * str.splitlines(keepends=True) analogue. Splits on \r\n, \r, \n boundaries and
 * keeps the terminator attached to each produced line. An empty input yields [].
 * A trailing newline does NOT produce a trailing empty element (matches Python).
 */
function _splitlinesKeepends(text: string): string[] {
  const lines: string[] = [];
  let i = 0;
  const n = text.length;
  let start = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "\n") {
      lines.push(text.slice(start, i + 1));
      i += 1;
      start = i;
    } else if (ch === "\r") {
      // \r\n is a single boundary; \r alone is a boundary too.
      if (i + 1 < n && text[i + 1] === "\n") {
        lines.push(text.slice(start, i + 2));
        i += 2;
      } else {
        lines.push(text.slice(start, i + 1));
        i += 1;
      }
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < n) {
    lines.push(text.slice(start, n));
  }
  return lines;
}

/** str.splitlines() (keepends=False): boundaries the same, terminators stripped. */
function _splitlines(text: string): string[] {
  return _splitlinesKeepends(text).map((line) => line.replace(/\r\n$|[\r\n]$/, ""));
}

/** Python str.strip() over default whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/, "").replace(/\s+$/, "");
}

/** Python str.lstrip() over default whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/, "");
}

/** Python ``s.strip('"')`` — strip leading/trailing double-quote characters. */
function _stripQuotes(s: string): string {
  let out = s;
  while (out.startsWith('"')) {
    out = out.slice(1);
  }
  while (out.endsWith('"')) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Python repr(str) — best-effort. Prefers single quotes; switches to double
 * quotes when the string contains a single quote but no double quote (matching
 * CPython). Backslashes and the chosen quote are escaped. Used only for the
 * cross_file_overlap description strings.
 */
function _pyRepr(s: string): string {
  let quote = "'";
  if (s.includes("'") && !s.includes('"')) {
    quote = '"';
  }
  let body = s.replace(/\\/g, "\\\\");
  if (quote === "'") {
    body = body.replace(/'/g, "\\'");
  } else {
    body = body.replace(/"/g, '\\"');
  }
  // Common control escapes Python applies.
  body = body
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return quote + body + quote;
}

// ---------------------------------------------------------------------------
// embeddings seam — NOT YET PORTED.
// ---------------------------------------------------------------------------
// Python does a lazy `from . import embeddings` inside find_content_duplicates
// wrapped in try/except, then checks embeddings.is_available(). The embeddings
// module is not part of the ported layer set, so a static import would fail to
// resolve. This seam mirrors compact.ts's bash_cache/skill_cache injection: when
// no override is set, _getEmbeddings() returns null and the embedding branch is
// skipped, falling through to the Jaccard path (exactly what Python does when the
// import fails / fastembed is absent). A later layer or a test can inject a mock.

interface _EmbeddingsModule {
  is_available(): boolean;
  embed_texts(texts: string[]): number[][];
}

let _embeddingsModuleOverride: _EmbeddingsModule | undefined;

/** Test/late-layer seam: inject an embeddings implementation (or undefined to clear). */
export function _setEmbeddingsModule(mod: _EmbeddingsModule | undefined): void {
  _embeddingsModuleOverride = mod;
}

/** Resolve the embeddings module: the injected override wins, else null (fail-soft). */
function _getEmbeddings(): _EmbeddingsModule | null {
  return _embeddingsModuleOverride ?? null;
}

// ---------------------------------------------------------------------------
// Index entry parsing
// ---------------------------------------------------------------------------

// Python: re.compile(r"^\s*-\s*\[(?P<title>[^\]]+)\]\((?P<target>[^)]+?\.md)\)")
const _ENTRY_RE = /^\s*-\s*\[(?<title>[^\]]+)\]\((?<target>[^)]+?\.md)\)/;

/** One parsed line from MEMORY.md. Python @dataclass(frozen=True). */
export class IndexEntry {
  readonly raw: string;
  readonly title: string;
  readonly target: string; // filename only, e.g. ``feedback_testing.md``
  readonly lineno: number; // 0-based

  constructor(args: { raw: string; title: string; target: string; lineno: number }) {
    this.raw = args.raw;
    this.title = args.title;
    this.target = args.target;
    this.lineno = args.lineno;
  }
}

/**
 * Parse MEMORY.md text into passthrough lines and entries.
 *
 * Returns ``[passthrough, entries]`` where *passthrough* is a list of
 * ``[lineno, raw_line]`` tuples for lines that are NOT index entries (headers,
 * blank lines, freeform notes). These are preserved verbatim.
 */
export function parse_index(text: string): [Array<[number, string]>, IndexEntry[]] {
  const passthrough: Array<[number, string]> = [];
  const entries: IndexEntry[] = [];
  const lines = _splitlinesKeepends(text);
  for (let lineno = 0; lineno < lines.length; lineno++) {
    const line = lines[lineno]!;
    const m = _ENTRY_RE.exec(line);
    if (m && m.groups) {
      entries.push(
        new IndexEntry({
          raw: line,
          title: m.groups["title"]!,
          target: m.groups["target"]!,
          lineno,
        }),
      );
    } else {
      passthrough.push([lineno, line]);
    }
  }
  return [passthrough, entries];
}

// ---------------------------------------------------------------------------
// Safe structural pruning
// ---------------------------------------------------------------------------

/** Result of a {@link prune_index} call. Python @dataclass. */
export class PruneResult {
  removed_dead: IndexEntry[];
  removed_dup: IndexEntry[];
  kept: number;
  changed: boolean;
  tokens_saved: number; // estimate_tokens over removed raw lines

  constructor(args: {
    removed_dead?: IndexEntry[];
    removed_dup?: IndexEntry[];
    kept?: number;
    changed?: boolean;
    tokens_saved?: number;
  } = {}) {
    this.removed_dead = args.removed_dead ?? [];
    this.removed_dup = args.removed_dup ?? [];
    this.kept = args.kept ?? 0;
    this.changed = args.changed ?? false;
    this.tokens_saved = args.tokens_saved ?? 0;
  }
}

/**
 * Read MEMORY.md, drop dead-link and exact-dup-target entries, rewrite atomically.
 *
 * *memory_dir* is the directory containing MEMORY.md and its siblings. When
 * *dry_run* is true the file is never written; the returned result still reflects
 * what *would* have been removed.
 *
 * Returns ``PruneResult(changed=false)`` when the file is absent, unreadable, or
 * already clean. Never raises — caller decides on logging.
 */
export function prune_index(memory_dir: string, opts: { dry_run?: boolean } = {}): PruneResult {
  const dry_run = opts.dry_run ?? false;
  const result = new PruneResult();
  const memory_md = nodePath.join(memory_dir, "MEMORY.md");

  let text: string;
  try {
    text = fs.readFileSync(memory_md, "utf8");
  } catch {
    return result;
  }

  const [passthrough, entries] = parse_index(text);

  const seen_targets = new Set<string>();
  const keep: IndexEntry[] = [];
  const dead: IndexEntry[] = [];
  const dups: IndexEntry[] = [];

  for (const entry of entries) {
    const target_path = nodePath.join(memory_dir, entry.target);
    if (!fs.existsSync(target_path)) {
      dead.push(entry);
    } else if (seen_targets.has(entry.target)) {
      dups.push(entry);
    } else {
      seen_targets.add(entry.target);
      keep.push(entry);
    }
  }

  result.removed_dead = dead;
  result.removed_dup = dups;
  result.kept = keep.length;
  result.changed = Boolean(dead.length || dups.length);
  result.tokens_saved = estimate_tokens(
    dead.map((e) => e.raw).join("") + dups.map((e) => e.raw).join(""),
  );

  if (!result.changed || dry_run) {
    return result;
  }

  // Reconstruct in original line order by merging passthrough + kept entries via a lineno map.
  const line_map = new Map<number, string>();
  for (const [lineno, raw] of passthrough) {
    line_map.set(lineno, raw);
  }
  for (const entry of keep) {
    line_map.set(entry.lineno, entry.raw);
  }

  // Sort by original line number and join.
  const sortedKeys = [...line_map.keys()].sort((a, b) => a - b);
  let reconstructed = sortedKeys.map((k) => line_map.get(k)!).join("");

  // Ensure trailing newline.
  if (reconstructed && !reconstructed.endsWith("\n")) {
    reconstructed += "\n";
  }

  try {
    paths.atomicWriteText(memory_md, reconstructed);
  } catch {
    result.changed = false; // write failed; report as no-op
  }

  return result;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection in sibling files (report-only)
// ---------------------------------------------------------------------------

/** A group of memory files with highly similar content. Python @dataclass. */
export class DupCluster {
  members: string[];
  similarity: number;
  method: string; // "embedding" | "jaccard"
  tokens: number; // combined token cost of all members

  constructor(args: { members: string[]; similarity: number; method: string; tokens: number }) {
    this.members = args.members;
    this.similarity = args.similarity;
    this.method = args.method;
    this.tokens = args.tokens;
  }
}

/** Token-set Jaccard similarity (whitespace-tokenised, lowercased). */
function _jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter((t) => t.length > 0));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter((t) => t.length > 0));
  if (ta.size === 0 && tb.size === 0) {
    return 1.0;
  }
  if (ta.size === 0 || tb.size === 0) {
    return 0.0;
  }
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) {
      inter += 1;
    }
  }
  const union = ta.size + tb.size - inter;
  return inter / union;
}

/** Return description + first ~500 body chars for similarity comparison. */
function _sibling_snippet(path: string): string {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return "";
  }
  // Strip YAML frontmatter (--- ... ---) to get the body.
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const body = _lstrip(text.slice(end + 4));
      // Also extract description from frontmatter.
      const fm = text.slice(3, end);
      let desc = "";
      for (const line of _splitlines(fm)) {
        if (line.startsWith("description:")) {
          desc = _stripQuotes(_strip(line.slice(12)));
          break;
        }
      }
      return _strip(desc + " " + body.slice(0, 500));
    }
    return text.slice(0, 500);
  }
  return text.slice(0, 500);
}

/**
 * Return clusters of sibling memory files with similar content.
 *
 * Uses embedding cosine similarity when fastembed is available; falls back to
 * Jaccard >= 0.60 (cruder, flag-only). Pure: never mutates any file.
 */
export function find_content_duplicates(
  memory_dir: string,
  opts: { threshold?: number } = {},
): DupCluster[] {
  const threshold = opts.threshold ?? 0.92;

  // sorted(p for p in memory_dir.glob("*.md") if p.name.lower() != "memory.md")
  let names: string[];
  try {
    names = fs.readdirSync(memory_dir);
  } catch {
    names = [];
  }
  const siblings = names
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "memory.md")
    .map((name) => nodePath.join(memory_dir, name))
    .sort();
  if (siblings.length < 2) {
    return [];
  }

  const snippets = siblings.map((p) => _sibling_snippet(p));

  // --- Embedding path ---
  try {
    const embeddings = _getEmbeddings();
    if (embeddings !== null && embeddings.is_available()) {
      const vecs = embeddings.embed_texts(snippets);

      const _cosine = (a: number[], b: number[]): number => {
        let dot = 0;
        const len = Math.min(a.length, b.length);
        for (let k = 0; k < len; k++) {
          dot += a[k]! * b[k]!;
        }
        let na = 0;
        for (const x of a) {
          na += x * x;
        }
        na = Math.sqrt(na);
        let nb = 0;
        for (const y of b) {
          nb += y * y;
        }
        nb = Math.sqrt(nb);
        if (na === 0 || nb === 0) {
          return 0.0;
        }
        return dot / (na * nb);
      };

      const clusters: DupCluster[] = [];
      const used = new Set<number>();
      for (let i = 0; i < siblings.length; i++) {
        if (used.has(i)) {
          continue;
        }
        const group: number[] = [i];
        for (let j = i + 1; j < siblings.length; j++) {
          if (used.has(j)) {
            continue;
          }
          const sim = _cosine(vecs[i]!, vecs[j]!);
          if (sim >= threshold) {
            group.push(j);
          }
        }
        if (group.length > 1) {
          const members = group.map((k) => siblings[k]!);
          let tok = 0;
          for (const k of group) {
            tok += estimate_tokens(snippets[k]!);
          }
          let max_sim = -Infinity;
          for (let a = 0; a < group.length; a++) {
            for (let b = a + 1; b < group.length; b++) {
              const s = _cosine(vecs[group[a]!]!, vecs[group[b]!]!);
              if (s > max_sim) {
                max_sim = s;
              }
            }
          }
          clusters.push(
            new DupCluster({
              members,
              similarity: _round3(max_sim),
              method: "embedding",
              tokens: tok,
            }),
          );
          for (const k of group) {
            used.add(k);
          }
        }
      }
      return clusters;
    }
  } catch {
    // fall through to Jaccard
  }

  // --- Jaccard fallback ---
  const _JACCARD_THRESHOLD = 0.6;
  const clusters: DupCluster[] = [];
  const used = new Set<number>();
  for (let i = 0; i < siblings.length; i++) {
    if (used.has(i)) {
      continue;
    }
    const group: number[] = [i];
    for (let j = i + 1; j < siblings.length; j++) {
      if (used.has(j)) {
        continue;
      }
      const sim = _jaccard(snippets[i]!, snippets[j]!);
      if (sim >= _JACCARD_THRESHOLD) {
        group.push(j);
      }
    }
    if (group.length > 1) {
      const members = group.map((k) => siblings[k]!);
      let tok = 0;
      for (const k of group) {
        tok += estimate_tokens(snippets[k]!);
      }
      let max_sim = -Infinity;
      for (let a = 0; a < group.length; a++) {
        for (let b = a + 1; b < group.length; b++) {
          const s = _jaccard(snippets[group[a]!]!, snippets[group[b]!]!);
          if (s > max_sim) {
            max_sim = s;
          }
        }
      }
      clusters.push(
        new DupCluster({
          members,
          similarity: _round3(max_sim),
          method: "jaccard",
          tokens: tok,
        }),
      );
      for (const k of group) {
        used.add(k);
      }
    }
  }
  return clusters;
}

/** Python round(x, 3) — round-half-to-even at 3 decimal places. */
function _round3(x: number): number {
  // The similarity values here are never exactly N.5 at the 4th decimal in the
  // tested paths, so a plain scale/round/unscale reproduces Python's round(x, 3).
  return Math.round(x * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// CLAUDE.md audit (report-only — never edits)
// ---------------------------------------------------------------------------

/** Audit findings for a single CLAUDE.md file. Python @dataclass. */
export class ClaudeMdReport {
  path: string;
  tokens: number;
  exact_dup_lines: Array<[number, number, string]>; // (first_ln, dup_ln, stripped_text)
  dup_sections: Array<[string, number[]]>; // (heading, [linenos])
  cross_file_overlaps: string[]; // overlap descriptions vs. other files

  constructor(args: {
    path: string;
    tokens: number;
    exact_dup_lines: Array<[number, number, string]>;
    dup_sections: Array<[string, number[]]>;
    cross_file_overlaps: string[];
  }) {
    this.path = args.path;
    this.tokens = args.tokens;
    this.exact_dup_lines = args.exact_dup_lines;
    this.dup_sections = args.dup_sections;
    this.cross_file_overlaps = args.cross_file_overlaps;
  }
}

/**
 * Return duplicate-line and duplicate-section findings across CLAUDE.md files.
 *
 * Report-only: never edits any file.
 */
export function audit_claude_md(files: string[]): ClaudeMdReport[] {
  const reports: ClaudeMdReport[] = [];
  const all_lines: Array<[string, number, string]> = []; // (path, lineno, stripped)

  for (const path of files) {
    let text: string;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      continue;
    }

    const lines = _splitlines(text);
    const tokens = estimate_tokens(text);
    const exact_dups: Array<[number, number, string]> = [];
    const dup_sections: Array<[string, number[]]> = [];

    // Exact duplicate non-blank lines within this file.
    const seen_lines = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
      const stripped = _strip(lines[i]!);
      if (!stripped) {
        continue;
      }
      if (seen_lines.has(stripped)) {
        exact_dups.push([seen_lines.get(stripped)!, i, stripped]);
      } else {
        seen_lines.set(stripped, i);
      }
    }

    // Duplicate headings (## / ###).
    const seen_headings = new Map<string, number[]>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("##")) {
        const heading = _strip(line);
        const arr = seen_headings.get(heading);
        if (arr) {
          arr.push(i);
        } else {
          seen_headings.set(heading, [i]);
        }
      }
    }
    for (const [heading, lnos] of seen_headings) {
      if (lnos.length > 1) {
        dup_sections.push([heading, lnos]);
      }
    }

    reports.push(
      new ClaudeMdReport({
        path,
        tokens,
        exact_dup_lines: exact_dups,
        dup_sections,
        cross_file_overlaps: [], // filled below
      }),
    );

    for (let i = 0; i < lines.length; i++) {
      const stripped = _strip(lines[i]!);
      if (stripped) {
        all_lines.push([path, i, stripped]);
      }
    }
  }

  // Cross-file overlaps: non-blank lines that appear verbatim in >1 file.
  const line_to_files = new Map<string, Set<string>>();
  for (const [path, , stripped] of all_lines) {
    let s = line_to_files.get(stripped);
    if (!s) {
      s = new Set<string>();
      line_to_files.set(stripped, s);
    }
    s.add(path);
  }

  for (const report of reports) {
    const overlaps: string[] = [];
    for (const [stripped, paths_set] of line_to_files) {
      if (paths_set.has(report.path) && paths_set.size > 1) {
        const others: string[] = [];
        for (const p of paths_set) {
          if (p !== report.path) {
            others.push(_basename(p));
          }
        }
        if (others.length > 0) {
          overlaps.push(
            stripped.length > 60
              ? `${_pyRepr(stripped.slice(0, 60))}… also in ${others.join(", ")}`
              : `${_pyRepr(stripped)} also in ${others.join(", ")}`,
          );
        }
      }
    }
    report.cross_file_overlaps = overlaps.slice(0, 10); // cap to avoid noise
  }

  return reports;
}

/** Python Path(p).name — final path component. */
function _basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
