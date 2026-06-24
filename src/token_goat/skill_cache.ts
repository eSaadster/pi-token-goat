/**
 * Persistent store for loaded-skill bodies.
 *
 * Every PostToolUse(Skill) hook invocation records the loaded skill's body to a
 * short text file under `data_dir() / "skills"` keyed by `session_short`,
 * `skill_name`, and a short content hash. After compaction, the agent can
 * recall the full body via the `token-goat skill-body` CLI without re-invoking
 * the skill (which would also re-trigger any side effects the skill performs on
 * first load).
 *
 * Why a separate disk store (vs. session JSON):
 *
 *  * Skill bodies can be tens of KB (Ralph is ~30 KB, /improve ~10 KB). Inlining
 *    that into the session JSON would bloat every subsequent load/save round trip
 *    on the hot pre-read path. Storing the bytes once on disk and only a short
 *    ID in the session keeps the session JSON cheap.
 *
 *  * The CLI retrieval path (`token-goat skill-body`) can stream the file
 *    directly without re-parsing JSON.
 *
 *  * Retention is simple to bound by total bytes: scan the directory, evict the
 *    oldest files until the cap is met. No cross-session coordination is needed.
 *
 * The store is intentionally fail-soft: any I/O error on write is logged and
 * swallowed so a hook never aborts because the cache is full or read-only.
 *
 * --- Port notes ---
 * Faithful TS/Node port of src/token_goat/skill_cache.py. Strict TS, NodeNext
 * ESM, static sibling imports as "./x.js".
 *
 *  - Python `str.splitlines()` DROPS the trailing empty element; the helper
 *    `splitlines()` below reproduces that (a bare String.prototype.split would
 *    keep it → off-by-one in line indices).
 *  - Python str slicing/`len` count CODE POINTS, not UTF-16 units. Slicing that
 *    feeds `find_markdown_boundary` / byte math uses ASCII-only data in every
 *    real case here, but the `[:n]` prose caps go through `cpSlice()` to match
 *    the code-point semantics for astral chars. Byte counts use Buffer (UTF-8).
 *  - `safe_cache_op` is the cache_common callback-style port: it returns
 *    `T | undefined` (undefined when it suppressed an OSError). The Python
 *    `with safe_cache_op(...): return X` + trailing `return None` becomes a
 *    `const r = safe_cache_op(...); ... return null`-shaped control flow.
 *  - hooks_skill is a CIRCULAR-lazy dependency: Python imports it inside a
 *    function; hooks_skill reaches skill_cache only via its
 *    `_setSkillCacheModule` seam, never a hard import. Here it is a top-level
 *    `import * as hooks_skill` used ONLY inside `get_skill_file_path` (ESM
 *    function-level circular usage is safe).
 *  - This module calls its own functions that tests vi.spyOn (read_sidecar,
 *    list_outputs, lookup_all_by_name, get_compact, content_hash,
 *    find_cross_session_entry, output_id_for, evict_old_entries, ...) — those
 *    internal calls route through `import * as self` so the spy is observed.
 *  - Module-global mutable state (`_sweep_done`, `_dir_listing_cache`) is
 *    registered with reset.ts so clearModuleCaches() restores fresh-import state.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  OUTPUT_FILENAME_RE,
  evict_cache_dir,
  find_markdown_boundary,
  get_cache_dir,
  list_cache_outputs,
  load_blob_gz,
  load_output_meta_stat,
  load_output_text,
  load_sidecar_json,
  safe_cache_op,
  safe_join_output_id,
  safe_session_fragment,
  short_content_hash,
  sidecar_path_for,
  store_blob,
  store_blob_gz,
  truncate_tail_preserve,
} from "./cache_common.js";
import type { OutputStatDict } from "./types.js";
import { sanitize_log_str } from "./hooks_common.js";
import { getLogger } from "./util.js";
import { load as loadConfig } from "./config.js";
import { atomicWriteText } from "./paths.js";
import * as doc_compact from "./doc_compact.js";
import { find_project } from "./project.js";
import { registerReset } from "./reset.js";

// hooks_skill: circular-lazy. Top-level namespace import used ONLY inside a
// function (get_skill_file_path), mirroring Python's `from . import hooks_skill`
// inside the function body. hooks_skill never hard-imports skill_cache (it uses
// the _setSkillCacheModule seam), so this top-level import is cycle-safe.
import * as hooks_skill from "./hooks_skill.js";

// Self-import so internal calls observe test spies (vi.spyOn(skill_cache, fn)).
import * as self from "./skill_cache.js";

export { OUTPUT_FILENAME_RE };

const _LOG = getLogger("skill_cache");

// One-shot orphan sweep flag: set to True after the sweep runs in this process.
let _sweep_done = false;

// Process-local directory listing cache for the skills output directory.
// A single manifest build may call get_compact_any_session() once per loaded
// skill; each call previously ran out_dir.glob(pattern), which is an OS-level
// directory scan. With 3 skills that is 3 scans of the same directory in
// rapid succession. The cache below stores the full directory listing for a
// short TTL (5 s) so that all skill lookups within one render share a single
// iterdir() call. TTL is deliberately short so new compact files written
// between manifest renders are visible without delay.
export const _DIR_LISTING_CACHE_TTL_SECS = 5.0;
let _dir_listing_cache: [number, string[]] | null = null;

registerReset(() => {
  _sweep_done = false;
  _dir_listing_cache = null;
});

/**
 * Return a cached listing of *out_dir*, refreshed at most every 5 seconds.
 *
 * Caches the result of `list(out_dir.iterdir())` so that multiple
 * {@link get_compact_any_session} calls within a single manifest render
 * reuse the same directory scan rather than each running a separate
 * `Path.glob()` syscall. Fail-soft: returns an empty list on I/O error.
 *
 * Returns absolute paths (Python returns `Path` objects); callers use the
 * basename via `path.basename(p)` to mirror `Path.name`.
 */
export function _get_skills_dir_listing(out_dir: string): string[] {
  const now = Date.now() / 1000;
  if (_dir_listing_cache !== null) {
    const [cached_ts, cached_list] = _dir_listing_cache;
    if (now - cached_ts < _DIR_LISTING_CACHE_TTL_SECS) {
      return cached_list;
    }
  }
  let listing: string[];
  try {
    listing = fs.readdirSync(out_dir).map((name) => path.join(out_dir, name));
  } catch {
    listing = [];
  }
  _dir_listing_cache = [now, listing];
  return listing;
}

// Schema version embedded in every newly written SkillMeta sidecar JSON.
// Increment this when a new required field is added so that read_sidecar can
// detect entries written by older versions and handle them gracefully.
//
// v1  — original schema (output_id, skill_name, content_sha, body_bytes, ts,
//        truncated; source_path added later as optional with "" default)
// v2  — explicit schema_v field; source_path promoted from implicit default to
//        tracked presence; read_sidecar detects v1 entries and back-fills
//        source_path as "" without discarding the entry.
export const SIDECAR_SCHEMA_VERSION = 2;

// Total byte budget for the on-disk skill body store. When exceeded, the
// oldest entries (by mtime) are evicted until the cap is met. 5 MB is small
// enough to be invisible on any modern disk while big enough to hold dozens of
// skill bodies (most are 5-30 KB; the largest known skill is ~50 KB).
export const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

// Maximum number of compact files allowed in the cache directory. Compact
// files have no extension (`{session}-{name}-compact`) so they are invisible
// to the `.txt`-only LRU eviction in {@link evict_old_entries}. Without a
// count cap they accumulate indefinitely — one compact per (session, skill)
// pair per `token-goat skill-compact` invocation. Each file is tiny
// (usually < 2 KB) so a byte cap would never fire, but a count cap of 500
// gives plenty of headroom for active use (a session with 10 skills × 50
// compactions = 500) while bounding the long-term tail of orphaned compacts.
export const MAX_COMPACT_FILE_COUNT = 500;

// Compact file name regex: `{session}-{safe_name}-compact` with no extension.
// Session fragment and safe_name are restricted to `[a-zA-Z0-9_-]`. The
// trailing `-compact` literal is the distinguishing token.
export const _COMPACT_FILENAME_RE = /^[a-zA-Z0-9_\-]{1,80}-compact$/;

// Sentinel placed at the head of every output file marking the truncation
// boundary, so a reader can immediately see when the stored bytes are partial.
export const _TRUNC_MARKER =
  "[token-goat: skill body truncated; stored {n} of {total} bytes]\n";

// Maximum bytes stored per skill body file. Skill bodies above this size are
// tail-truncated (head dropped). Tail-preserve matches the cache_common helper
// behaviour shared with bash/web caches, and skill bodies' most useful parts
// (rules, checklists, examples) tend to live in the latter half of the file —
// the opening is usually metadata + setup that is also captured in a section
// heading reachable via `token-goat section`.
export const _MAX_STORED_BYTES = 256 * 1024;

// Skill-name validation regex. Restrict to characters that are filesystem-safe
// on all platforms (Windows + POSIX) and that we expect Claude Code skills to
// use: alphanumerics, hyphens, underscores, and a single colon for the
// `plugin:skill` form. Anything else is rejected to keep the cache filename
// safe from injection attacks.
export const _SKILL_NAME_RE = /^[A-Za-z0-9_:\-]{1,128}$/;

// Explicit compact-section delimiter. Skill authors place this HTML comment on
// its own line to divide the file into two logical parts:
//
//   * Everything **above** the marker is the compact form — the essential
//     rules, directives, and quick-reference content the agent needs after a
//     compaction event. Typically 200-600 tokens.
//   * Everything **below** is detailed reference — extended examples,
//     implementation notes, edge cases — useful when the agent wants to drill
//     deeper via `token-goat skill-section <name> <heading>`.
//
// When the marker is absent `extract_compact_from_marker` returns `null`
// and the caller falls back to `generate_compact_summary` auto-extraction.
export const COMPACT_END_MARKER = "<!-- COMPACT_END -->";

/**
 * Metadata associated with a cached skill body entry.
 *
 * Persisted in the session cache (small) alongside an ID that points at the
 * on-disk file (potentially large). Carries everything a manifest renderer
 * or CLI recall path needs without re-reading the body from disk.
 *
 * Python `@dataclass`: positional fields with `source_path` defaulting to "".
 * The TS constructor mirrors that (source_path defaults to "").
 */
export class SkillMeta {
  output_id: string;
  skill_name: string;
  content_sha: string;
  body_bytes: number;
  ts: number;
  truncated: boolean;
  source_path: string; // best-effort filesystem path where the skill body was found

  constructor(
    output_id: string,
    skill_name: string,
    content_sha: string,
    body_bytes: number,
    ts: number,
    truncated: boolean,
    source_path = "",
  ) {
    this.output_id = output_id;
    this.skill_name = skill_name;
    this.content_sha = content_sha;
    this.body_bytes = body_bytes;
    this.ts = ts;
    this.truncated = truncated;
    this.source_path = source_path;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers: line / codepoint / byte utilities
// ---------------------------------------------------------------------------

/**
 * Reproduce Python `str.splitlines()`: split on universal newlines and DROP a
 * trailing empty element (i.e. a final "\n" does NOT yield a trailing "").
 * String.prototype.split would keep that element → off-by-one in line indices.
 */
function splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  // Python splitlines breaks on \n, \r, \r\n (and a few others). Normalise
  // \r\n and \r to \n first, then split; the bodies handled here use \n/\r\n.
  const normalized = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Python `s.strip()`: strip leading/trailing ASCII+Unicode whitespace. */
function pyStrip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python `s.rstrip()`. */
function pyRStrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Code-point-aware `s[:n]` matching Python slicing of astral chars. */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Code-point length, matching Python `len(s)`. */
function cpLen(s: string): number {
  return [...s].length;
}

/** UTF-8 byte length with replacement (Python `len(s.encode("utf-8", "replace"))`). */
function utf8Len(s: string): number {
  return Buffer.from(s, "utf8").length;
}

/** True when err is an OSError-equivalent (Node ErrnoException with a code). */
function isOSError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

/** Python `str.isspace()` for a single character. */
function charIsSpace(c: string): boolean {
  return /\s/u.test(c);
}

// ---------------------------------------------------------------------------

/** Return `data_dir() / "skills"` and create it on first use. */
export function _skill_outputs_dir(): string {
  return get_cache_dir("skills");
}

/** Delegate to cache_common.store_blob_gz for the skills directory. */
function _store_blob_gz(output_id: string, text: string): string | null {
  return store_blob_gz(output_id, text, _skill_outputs_dir, "skill_cache");
}

/** Delegate to cache_common.load_blob_gz for the skills directory. */
function _load_blob_gz(output_id: string): string | null {
  return load_blob_gz(output_id, _skill_outputs_dir, "skill_cache");
}

/**
 * Return a short content hash (first 16 hex chars of SHA-256).
 *
 * Thin wrapper around cache_common.short_content_hash kept for backwards
 * compatibility. Callers outside this module (e.g. hooks_skill) may pass the
 * result to {@link output_id_for} directly.
 */
export function content_hash(content: string): string {
  return short_content_hash(content);
}

/**
 * Return *skill_name* if it passes validation, else `null`.
 *
 * Rejects names that would not be safe to embed in a filesystem path (slashes,
 * backslashes, dots, control characters) or that exceed our length cap. The
 * `plugin:skill` form is allowed because Claude Code uses `:` as the namespace
 * separator and we want plugin-namespaced skills addressable.
 */
export function _safe_skill_name(skill_name: string): string | null {
  if (!skill_name) {
    return null;
  }
  if (!_SKILL_NAME_RE.test(skill_name)) {
    return null;
  }
  return skill_name;
}

/**
 * Build a filesystem-safe ID for the (session, skill_name, content) tuple.
 *
 * Embeds a short session prefix, a sanitised skill name, and the content hash.
 * Two loads of the same skill body in the same session produce the same ID —
 * i.e. the cache is idempotent per (session, name, content). If the body
 * changes (skill was updated between loads), a new ID is generated and both
 * versions remain addressable.
 *
 * Session ID is short-prefixed (16 chars) so total filename length stays well
 * under PATH_MAX; `:` in plugin-namespaced skill names is replaced with `_` so
 * the result is filesystem-safe everywhere.
 *
 * Collision-free namespace marker: when the original *skill_name* contains a
 * `:` (plugin-namespaced form), an `n` suffix is appended to the
 * filesystem-safe name segment so that `plugin:improve` produces
 * `plugin_improven` while the plain `plugin_improve` skill produces
 * `plugin_improve` — distinct filenames despite both mapping to the same
 * `_`-substituted string. The `n` stands for "namespaced" and is chosen
 * because it does not appear in the short content hash (hex-only).
 */
export function output_id_for(
  session_id: string,
  skill_name: string,
  content_sha: string,
): string {
  const safe_session = safe_session_fragment(session_id);
  let safe_name = skill_name.replace(/:/g, "_");
  if (skill_name.includes(":")) {
    safe_name += "n"; // namespace-collision guard
  }
  return `${safe_session}-${safe_name}-${content_sha}`;
}

/**
 * Return the pre-marker compact slice when `COMPACT_END_MARKER` is present.
 *
 * Scans *body* for the first line that equals {@link COMPACT_END_MARKER}
 * (stripped, case-sensitive) that is **not** inside a fenced code block.
 * When found, returns everything above the marker, stripped of
 * leading/trailing whitespace. Returns `null` when the marker is absent so
 * callers can fall back to {@link generate_compact_summary} auto-extraction.
 *
 * Code-block awareness: the marker is ignored when it appears between a pair
 * of triple-backtick (```) or triple-tilde (~~~) fences. This prevents a
 * skill body that *documents* the marker (e.g. a how-to example) from being
 * mis-split at the wrong location.
 *
 * The returned text is **not** capped — the caller decides whether to
 * truncate. Skill authors are responsible for keeping the compact section at
 * a reasonable size (target: <=600 tokens ~= 2400 chars).
 */
export function extract_compact_from_marker(body: string): string | null {
  if (!body || !body.includes(COMPACT_END_MARKER)) {
    return null;
  }
  let in_code_block = false;
  const lines = splitlines(body);
  for (let i = 0; i < lines.length; i++) {
    const stripped = pyStrip(lines[i]!);
    // Track fenced code block state. A fence opens or closes when the
    // stripped line starts with ``` or ~~~. We toggle on each fence line
    // rather than matching pairs so a mismatched fence file still terminates
    // correctly at end-of-file.
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      in_code_block = !in_code_block;
      continue;
    }
    if (in_code_block) {
      continue;
    }
    if (stripped === COMPACT_END_MARKER) {
      const pre_marker = pyStrip(lines.slice(0, i).join("\n"));
      return pre_marker ? pre_marker : null;
    }
  }
  return null;
}

// Headings searched in priority order when looking for actionable checklist prose.
// The first match wins.
const _CHECKLIST_HEADINGS = [
  "## DoD",
  "## Checklist",
  "## Steps",
  "## Definition of Done",
  "## Process",
  "## Quick Start",
] as const;

// Maximum characters returned from a matched checklist section (per skill).
const _CHECKLIST_MAX_CHARS = 400;

/**
 * Return the first checklist-shaped section from a skill body, or `null`.
 *
 * Walks *body* line by line and checks each `##`-level heading against
 * {@link _CHECKLIST_HEADINGS} (case-insensitive prefix match). When a match
 * is found, collects lines until the next `##`-level heading or end-of-file,
 * strips leading/trailing whitespace, and returns the result capped at
 * {@link _CHECKLIST_MAX_CHARS} characters. Returns `null` when no matching
 * heading is found or the extracted text is empty.
 */
export function extract_checklist_section(body: string): string | null {
  if (!body) {
    return null;
  }

  const lines = splitlines(body);
  const n = lines.length;

  // Build a lower-cased version of each target heading for fast comparison.
  const targets = _CHECKLIST_HEADINGS.map((h) => h.toLowerCase());

  // Priority: return the match for the highest-priority heading found.
  // We do a single pass recording the first-found position per heading, then
  // return the match with the lowest priority index.
  // Code-block-aware: headings inside fenced blocks (``` or ~~~) are skipped.
  let best_priority = targets.length;
  let best_start = -1;
  let in_code_block = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = pyStrip(lines[i]!);
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      in_code_block = !in_code_block;
      continue;
    }
    if (in_code_block) {
      continue;
    }
    if (!stripped.startsWith("## ")) {
      continue;
    }
    const low = stripped.toLowerCase();
    for (let pri = 0; pri < targets.length; pri++) {
      if (pri >= best_priority) {
        break; // already have a better match
      }
      if (low.startsWith(targets[pri]!)) {
        best_priority = pri;
        best_start = i;
        break; // each heading checked only once per line
      }
    }
  }

  if (best_start === -1) {
    return null;
  }

  // Collect body lines from the line after the heading up to the next ## heading.
  const body_lines: string[] = [];
  for (let j = best_start + 1; j < n; j++) {
    if (pyStrip(lines[j]!).startsWith("## ")) {
      break;
    }
    body_lines.push(lines[j]!);
  }

  let text = pyStrip(body_lines.join("\n"));
  if (!text) {
    return null;
  }

  // Cap at _CHECKLIST_MAX_CHARS; prefer breaking at a markdown boundary
  // (heading or paragraph) rather than at an arbitrary newline so the
  // extracted checklist is a complete unit.
  if (cpLen(text) > _CHECKLIST_MAX_CHARS) {
    let cut = find_markdown_boundary(text, _CHECKLIST_MAX_CHARS);
    if (cut <= 0) {
      cut = _CHECKLIST_MAX_CHARS;
    }
    text = pyRStrip(text.slice(0, cut)) + "…";
  }

  return text;
}

/**
 * Return a list of all `##`-level heading texts found in *body*.
 *
 * Used by `token-goat skill-body --section` to list available sections when
 * the `--section` flag is absent so the agent can discover section names
 * before deciding which to fetch.
 *
 * Code-block-aware: headings inside fenced blocks (``` or ~~~) are excluded so
 * the agent does not see false section names from Markdown code examples inside
 * the skill body.
 *
 * Returns an empty list when *body* is empty or contains no `##` headings.
 */
export function extract_h2_headings(body: string): string[] {
  if (!body) {
    return [];
  }
  const headings: string[] = [];
  let in_code_block = false;
  for (const line of splitlines(body)) {
    const stripped = pyStrip(line);
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      in_code_block = !in_code_block;
      continue;
    }
    if (in_code_block) {
      continue;
    }
    if (stripped.startsWith("## ") && stripped.length > 3) {
      headings.push(pyStrip(stripped.slice(3)));
    }
  }
  return headings;
}

/**
 * Return all headings up to *max_level* depth as `[level, title]` tuples.
 *
 * Unlike {@link extract_h2_headings}, this function includes H3 (and
 * optionally H4+) headings so callers can show the complete navigable section
 * tree. {@link extract_named_section} can reach H3/H4 sections but they were
 * previously invisible in the "Sections available" hint, making subsections of
 * large skills like ralph undiscoverable without knowing the exact heading
 * text in advance.
 *
 * Each tuple is `[heading_level, heading_text]` where *heading_level* is the
 * number of leading `#` characters (2, 3, or 4).
 *
 * Returns an empty list when *body* is empty. Headings inside fenced code
 * blocks are excluded to avoid false positives from Markdown examples.
 */
export function extract_all_headings(
  body: string,
  max_level = 3,
): Array<[number, string]> {
  if (!body) {
    return [];
  }
  const headings: Array<[number, string]> = [];
  let in_code_block = false;
  for (const line of splitlines(body)) {
    const stripped = pyStrip(line);
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      in_code_block = !in_code_block;
      continue;
    }
    if (in_code_block) {
      continue;
    }
    if (!stripped.startsWith("#")) {
      continue;
    }
    // Count leading hashes.
    const level = stripped.length - lstripHashes(stripped).length;
    if (level < 2 || level > max_level) {
      continue;
    }
    const title = pyStrip(stripped.slice(level));
    if (title) {
      headings.push([level, title]);
    }
  }
  return headings;
}

/** Python `s.lstrip("#")`: strip leading "#" characters. */
function lstripHashes(s: string): string {
  let i = 0;
  while (i < s.length && s[i] === "#") {
    i += 1;
  }
  return s.slice(i);
}

/**
 * Split a heading like `Usage#2` into `["Usage", 2]`.
 *
 * The `#N` suffix selects which occurrence to return when a skill contains
 * multiple headings with the same text (e.g. two `## Usage` sections).
 * Returns `[heading, null]` when no ordinal suffix is present or the suffix is
 * malformed, so a real heading containing `#` is not mistakenly treated as an
 * ordinal.
 */
export function _parse_section_ordinal(heading: string): [string, number | null] {
  if (!heading.includes("#")) {
    return [heading, null];
  }
  // Python str.rpartition("#"): split on the LAST "#".
  const idx = heading.lastIndexOf("#");
  const base = heading.slice(0, idx);
  const ordinal_str = heading.slice(idx + 1);
  if (!base || !ordinal_str) {
    return [heading, null];
  }
  // Python int(): accept an optional sign + digits; reject anything else.
  if (!/^[+-]?\d+$/.test(ordinal_str)) {
    return [heading, null];
  }
  const ordinal = parseInt(ordinal_str, 10);
  if (ordinal < 1) {
    return [heading, null];
  }
  return [base, ordinal];
}

/**
 * Return the content of the section matching *heading*, or `null`.
 *
 * Searches `##`-level headings first, then `###`-level headings so that
 * subsections of large skills (e.g. `### Phase 1 — Explore` inside ralph) are
 * reachable without knowing the exact heading level. A `##` match always wins
 * over a `###` match for the same heading text.
 *
 * Case-insensitive prefix match on the heading text (after stripping the
 * leading `#` prefix and whitespace). Collects lines from the line after the
 * matched heading up to the next heading at the same or higher level, or end
 * of file. Returns `null` when no matching heading is found or the extracted
 * content is empty after stripping.
 *
 * Supports an ordinal suffix `Heading#N` (1-based) to select the *N*-th
 * occurrence when a skill contains multiple sections with the same heading
 * text. Without an ordinal, the first match is returned and a warning is
 * logged listing other match line numbers so the caller knows to add `#2`,
 * `#3`, etc.
 *
 * This is the in-memory equivalent of `read_replacement.read_section` for
 * skill bodies, which are not indexed in the project DB.
 */
export function extract_named_section(body: string, heading: string): string | null {
  if (!body || !heading) {
    return null;
  }

  const [base_heading, ordinal] = _parse_section_ordinal(heading);
  const heading_lower = pyStrip(base_heading).toLowerCase();
  const lines = splitlines(body);
  const n = lines.length;

  // Two-pass: prefer ## then fall back to ### or deeper.
  // Each pass collects ALL matches at that level (for ordinal selection and
  // disambiguation warnings). Code-block-aware: headings inside fenced
  // blocks (``` or ~~~) are skipped.
  // matches: list of [line_index, heading_level] for each match.
  let matches: Array<[number, number]> = [];

  for (const pass_level of [2, 3, 4]) {
    const prefix = "#".repeat(pass_level) + " ";
    let in_code_block = false;
    const level_matches: Array<[number, number]> = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = pyStrip(lines[i]!);
      if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
        in_code_block = !in_code_block;
        continue;
      }
      if (in_code_block) {
        continue;
      }
      if (stripped.startsWith(prefix)) {
        const section_title = pyStrip(stripped.slice(prefix.length)).toLowerCase();
        if (section_title.startsWith(heading_lower)) {
          level_matches.push([i, pass_level]);
        }
      }
    }
    if (level_matches.length > 0) {
      matches = level_matches;
      break;
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // Apply ordinal selection or first-match default with disambiguation warning.
  let match_start: number;
  let match_level: number;
  if (ordinal !== null) {
    if (ordinal > matches.length) {
      _LOG.info(
        "extract_named_section: ordinal %d requested for %s but only %d match(es); " +
          "no section returned",
        ordinal,
        JSON.stringify(base_heading),
        matches.length,
      );
      return null;
    }
    [match_start, match_level] = matches[ordinal - 1]!;
  } else if (matches.length > 1) {
    // Multiple sections share this heading text; return the first and log a
    // disambiguation hint so the caller knows to add #2, #3, etc.
    const other_lines = matches
      .slice(1)
      .map(([line_idx]) => String(line_idx + 1))
      .join(", ");
    _LOG.warning(
      "extract_named_section: %d sections share heading %s; returning first " +
        "(line %d). Use %s#2, %s#3, ... (other matches at lines: %s)",
      matches.length,
      JSON.stringify(base_heading),
      matches[0]![0] + 1,
      JSON.stringify(base_heading),
      JSON.stringify(base_heading),
      other_lines,
    );
    [match_start, match_level] = matches[0]!;
  } else {
    [match_start, match_level] = matches[0]!;
  }

  // Collect body lines until the next heading at the same or higher level.
  const body_lines: string[] = [];
  for (let j = match_start + 1; j < n; j++) {
    const stripped_j = pyStrip(lines[j]!);
    // Stop at any heading at match_level or shorter (higher in hierarchy).
    // "#".startswith("##") is False but "###".startswith("##") is True, so
    // we check whether the line's leading-hash count is <= match_level.
    if (stripped_j.startsWith("#")) {
      const level_j = stripped_j.length - lstripHashes(stripped_j).length;
      if (level_j <= match_level) {
        break;
      }
    }
    body_lines.push(lines[j]!);
  }

  const text = pyStrip(body_lines.join("\n"));
  return text ? text : null;
}

/**
 * One-shot cleanup of stale skill body blobs older than `orphan_age_secs`.
 *
 * Sessions are short-lived (hours). Any body file older than the threshold
 * (default 7 days) belongs to a dead session and can be safely removed.
 * Sidecars (`.json`) next to removed blobs are also deleted.
 *
 * Also sweeps compact files (`{session}-{name}-compact`, no extension).
 * These are invisible to the `.txt`-only LRU eviction in
 * {@link evict_old_entries} and would otherwise accumulate indefinitely
 * after their corresponding session ends.
 *
 * Runs once per process (guarded by `_sweep_done` flag) at first
 * `store_output()` call. Fail-soft: any I/O error is logged and skipped.
 * Never raises.
 */
function _sweep_skill_orphans(): void {
  if (_sweep_done) {
    return;
  }
  _sweep_done = true;

  let age_secs: number;
  try {
    const _cfg = loadConfig();
    // loadConfig() always returns a fully-defaulted skill_preservation block;
    // the `?? <default>` mirrors config.ts's own defaults and satisfies the
    // optional-field types (Python reads these fields directly).
    if (!(_cfg.skill_preservation?.orphan_sweep_enabled ?? true)) {
      _LOG.debug("_sweep_skill_orphans: disabled by config");
      return;
    }
    age_secs = _cfg.skill_preservation?.orphan_age_secs ?? 604800;
  } catch (exc) {
    _LOG.debug("_sweep_skill_orphans: config load failed, skipping: %s", exc);
    return;
  }

  const cache_dir = _skill_outputs_dir();
  if (!isDir(cache_dir)) {
    return;
  }

  const now = Date.now() / 1000;
  let removed = 0;
  let compact_removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(cache_dir);
  } catch (exc) {
    _LOG.debug("_sweep_skill_orphans: directory scan failed: %s", exc);
    return;
  }
  for (const name of names) {
    const fp = path.join(cache_dir, name);
    if (pathSuffix(name) === ".json") {
      continue;
    }
    const is_body = OUTPUT_FILENAME_RE.test(name);
    const is_compact = _COMPACT_FILENAME_RE.test(name);
    if (!is_body && !is_compact) {
      continue;
    }
    try {
      const age = now - fs.statSync(fp).mtimeMs / 1000;
      if (age <= age_secs) {
        continue;
      }
      fs.unlinkSync(fp);
      if (is_body) {
        removed += 1;
        _LOG.debug(
          "_sweep_skill_orphans: removed body %s (age=%s days)",
          name,
          (age / 86400.0).toFixed(1),
        );
        const sidecar = withSuffix(fp, ".json");
        try {
          fs.unlinkSync(sidecar);
        } catch {
          // suppress(OSError)
        }
      } else {
        compact_removed += 1;
        _LOG.debug(
          "_sweep_skill_orphans: removed compact %s (age=%s days)",
          name,
          (age / 86400.0).toFixed(1),
        );
      }
    } catch (exc) {
      if (isOSError(exc)) {
        _LOG.debug("_sweep_skill_orphans: failed to remove %s: %s", name, exc);
      } else {
        throw exc;
      }
    }
  }

  if (removed > 0) {
    _LOG.info("_sweep_skill_orphans: removed %d stale skill body blob(s)", removed);
  }
  if (compact_removed > 0) {
    _LOG.info("_sweep_skill_orphans: removed %d stale compact file(s)", compact_removed);
  }
}

/**
 * Search for an existing body entry with the same *skill_name* and *content_sha*.
 *
 * Scans all sidecar files in the skills cache directory and returns the first
 * {@link SkillMeta} whose `skill_name` and `content_sha` match the requested
 * values AND whose body file still exists on disk. Returns `null` when no such
 * entry is found.
 *
 * This is the cross-session dedup probe used by {@link store_output}: when the
 * same skill body (same SHA) was already cached in an earlier session, the new
 * session reuses the existing file rather than writing a duplicate. The
 * returned `SkillMeta.output_id` points at the *original* session's file so
 * {@link load_output} works without any path indirection.
 *
 * Fail-soft: any I/O error during the scan is logged and skipped. Returns
 * `null` in all error cases so the caller falls back to the normal write path.
 */
export function find_cross_session_entry(
  skill_name: string,
  content_sha: string,
): SkillMeta | null {
  const name = _safe_skill_name(skill_name);
  if (!name || !content_sha) {
    return null;
  }

  const cache_dir = _skill_outputs_dir();
  if (!isDir(cache_dir)) {
    return null;
  }

  try {
    for (const entry of self.list_outputs()) {
      const oid = entry.output_id;
      if (!oid) {
        continue;
      }
      const meta = self.read_sidecar(oid);
      if (meta === null) {
        continue;
      }
      if (meta.skill_name !== name || meta.content_sha !== content_sha) {
        continue;
      }
      // Verify the body file is still present on disk.
      const body_path = path.join(cache_dir, `${oid}.txt`);
      const gz_path = path.join(cache_dir, `${oid}.gz`);
      if (fs.existsSync(body_path) || fs.existsSync(gz_path)) {
        _LOG.debug(
          "find_cross_session_entry: hit for skill=%s sha=%s id=%s",
          name,
          content_sha.slice(0, 8),
          oid,
        );
        return meta;
      }
    }
  } catch (exc) {
    _LOG.debug("find_cross_session_entry: scan error: %s", exc);
  }

  return null;
}

/**
 * Write *body* to the cache and return descriptive metadata.
 *
 * Returns `null` on any I/O error so the calling hook can degrade silently.
 * Body larger than `_MAX_STORED_BYTES` is tail-preserved (head truncated)
 * using the shared {@link truncate_tail_preserve} helper. After the write the
 * function opportunistically evicts the oldest files until the total store
 * size is back under `max_total_bytes`.
 *
 * **Cross-session dedup:** when another session has already cached the same
 * skill body (same *skill_name* and content SHA), this function skips the disk
 * write and returns a {@link SkillMeta} pointing at the existing entry. The
 * body file is only written once per unique `(name, sha)` pair across the
 * entire cache lifetime. This saves disk I/O on the hot path where a
 * long-lived install accumulates the same ralph/improve/etc. skill body across
 * hundreds of sessions.
 *
 * Rejects invalid skill names (returns `null` without writing) to keep the
 * filesystem layout safe from injection attacks.
 */
export function store_output(
  session_id: string,
  skill_name: string,
  body: string,
  opts: { source_path?: string; max_total_bytes?: number } = {},
): SkillMeta | null {
  const source_path = opts.source_path ?? "";
  const max_total_bytes = opts.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;

  _sweep_skill_orphans();

  const name = _safe_skill_name(skill_name);
  if (name === null) {
    _LOG.warning(
      "skill_cache: rejected invalid skill_name: %s",
      sanitize_log_str(skill_name, 120),
    );
    return null;
  }

  const result = safe_cache_op("store_output", { log: _LOG }, (): SkillMeta | null => {
    const sha = self.content_hash(body);

    // Cross-session dedup: avoid writing the same body bytes twice when the
    // same skill (same SHA) was already cached in an earlier session. The
    // existing entry's output_id is reused so load_output works without any
    // path indirection. The caller (hooks_skill) will still call
    // write_sidecar to record the new session's timestamp alongside the
    // existing body file.
    const cross_session_hit = self.find_cross_session_entry(name, sha);
    if (cross_session_hit !== null) {
      _LOG.debug(
        "skill_cache: cross-session dedup hit for skill=%s sha=%s " +
          "(existing id=%s); skipping disk write",
        name,
        sha.slice(0, 8),
        cross_session_hit.output_id,
      );
      // Return a fresh SkillMeta with the caller-supplied source_path and an
      // updated timestamp so the sidecar written by the caller reflects the
      // current session load, not the original session's metadata.
      return new SkillMeta(
        cross_session_hit.output_id,
        name,
        sha,
        cross_session_hit.body_bytes,
        Date.now() / 1000,
        cross_session_hit.truncated,
        source_path || cross_session_hit.source_path,
      );
    }

    const out_id = self.output_id_for(session_id, name, sha);
    const [stored, truncated] = truncate_tail_preserve(body, _MAX_STORED_BYTES, {
      marker_template: _TRUNC_MARKER,
    });

    // Determine whether to compress this body.
    let compress = false;
    try {
      const _sp = loadConfig().skill_preservation;
      // `?? <default>` mirrors config.ts's own defaults (compress_bodies=true,
      // compress_min_bytes=16384) and satisfies the optional-field types;
      // Python reads _sp.compress_bodies / _sp.compress_min_bytes directly.
      compress =
        (_sp?.compress_bodies ?? true) &&
        utf8Len(stored) >= (_sp?.compress_min_bytes ?? 16 * 1024);
    } catch {
      // suppress(Exception)
    }

    let stored_path: string | null;
    if (compress) {
      stored_path = _store_blob_gz(out_id, stored);
    } else {
      stored_path = store_blob(out_id, stored, _skill_outputs_dir, "skill_cache");
    }

    if (stored_path === null) {
      return null;
    }

    const meta = new SkillMeta(
      out_id,
      name,
      sha,
      utf8Len(body),
      Date.now() / 1000,
      truncated,
      source_path,
    );

    // Best-effort eviction. We do not wait or retry: if the directory walk
    // fails (e.g. concurrent worker activity, antivirus lock) the cap is
    // enforced on the next call. Protect the id we just wrote so a coarse-mtime
    // tie can never evict this very entry (MRU protection).
    self.evict_old_entries({ max_total_bytes, protect_id: out_id });

    _LOG.debug(
      "skill_cache: stored id=%s skill=%s bytes=%d truncated=%s compressed=%s",
      out_id,
      name,
      meta.body_bytes,
      truncated,
      compress,
    );
    return meta;
  });

  // safe_cache_op returns undefined when it suppressed an OSError → null.
  return result === undefined ? null : result;
}

/**
 * Return the cached skill body for *output_id*, or `null` if absent.
 *
 * Transparently decompresses gzip-stored bodies: checks for `output_id.gz`
 * first, then falls back to the plain-text file so callers see plain text
 * regardless of how the body was stored.
 */
export function load_output(output_id: string): string | null {
  const gz_text = _load_blob_gz(output_id);
  if (gz_text !== null) {
    return gz_text;
  }
  return load_output_text(output_id, _skill_outputs_dir, "skill_cache");
}

/** Return stat-derived metadata for an output file (size, mtime), or null. */
export function load_output_meta(output_id: string): OutputStatDict | null {
  return load_output_meta_stat(output_id, _skill_outputs_dir, "skill_cache");
}

/**
 * Evict the oldest body entries until total size is at or under *max_total_bytes*.
 *
 * Also enforces a count cap on compact files (`{session}-{name}-compact`, no
 * extension). Compact files are tiny (usually < 2 KB each) so the byte-cap
 * eviction that {@link evict_cache_dir} runs on `.txt` body files would never
 * reach them — without a count cap they accumulate indefinitely. The oldest
 * compacts (by mtime) are removed first when the count exceeds
 * *max_compact_files*.
 *
 * *protect_id*, when given, is the output id the caller just wrote; it is
 * forwarded as the protected set so a coarse-mtime tie can never evict the
 * freshest entry (see {@link evict_cache_dir}).
 *
 * Returns the number of body files removed by the LRU eviction (the compact
 * count eviction runs separately and does not add to this total).
 */
export function evict_old_entries(
  opts: {
    max_total_bytes?: number;
    max_compact_files?: number;
    protect_id?: string | null;
  } = {},
): number {
  const max_total_bytes = opts.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const max_compact_files = opts.max_compact_files ?? MAX_COMPACT_FILE_COUNT;
  const protect_id = opts.protect_id ?? null;

  const removed = evict_cache_dir({
    cache_dir_fn: _skill_outputs_dir,
    log_name: "skill_cache",
    max_total_bytes,
    protect_ids: protect_id ? new Set<string>([protect_id]) : undefined,
  });
  _evict_compact_files({ max_compact_files });
  return removed;
}

/**
 * Remove the oldest compact files when the count exceeds *max_compact_files*.
 *
 * Compact files are named `{session}-{name}-compact` with no extension and are
 * not tracked by the byte-cap LRU eviction that targets `.txt` body files.
 * This function provides a separate count-based guard so a long-lived install
 * (many sessions × many skills) does not accumulate thousands of tiny compact
 * files.
 *
 * Fail-soft: any I/O error is logged at DEBUG and skipped. Never raises.
 */
function _evict_compact_files(
  opts: { max_compact_files?: number } = {},
): void {
  const max_compact_files = opts.max_compact_files ?? MAX_COMPACT_FILE_COUNT;
  try {
    const cache_dir = _skill_outputs_dir();
    if (!isDir(cache_dir)) {
      return;
    }

    const compacts: Array<[string, number]> = [];
    let names: string[];
    try {
      names = fs.readdirSync(cache_dir);
    } catch (exc) {
      _LOG.debug("skill_cache._evict_compact_files: directory scan failed: %s", exc);
      return;
    }
    for (const name of names) {
      if (!_COMPACT_FILENAME_RE.test(name)) {
        continue;
      }
      const fp = path.join(cache_dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      compacts.push([fp, st.mtimeMs / 1000]);
    }

    if (compacts.length <= max_compact_files) {
      return;
    }

    // Sort oldest-first and evict the surplus.
    compacts.sort((a, b) => a[1] - b[1]);
    const to_evict = compacts.length - max_compact_files;
    let evicted = 0;
    for (const [fp] of compacts.slice(0, to_evict)) {
      try {
        try {
          fs.unlinkSync(fp);
        } catch (e) {
          // unlink(missing_ok=True): ignore ENOENT, re-throw other OSErrors.
          if (!(isOSError(e) && (e as NodeJS.ErrnoException).code === "ENOENT")) {
            throw e;
          }
        }
        evicted += 1;
        _LOG.debug("skill_cache._evict_compact_files: removed %s", path.basename(fp));
      } catch (exc) {
        if (isOSError(exc)) {
          _LOG.debug(
            "skill_cache._evict_compact_files: failed to remove %s: %s",
            path.basename(fp),
            exc,
          );
        } else {
          throw exc;
        }
      }
    }

    if (evicted > 0) {
      _LOG.info(
        "skill_cache._evict_compact_files: evicted %d compact file(s) (cap=%d)",
        evicted,
        max_compact_files,
      );
    }
  } catch (exc) {
    _LOG.debug("skill_cache._evict_compact_files: unexpected error: %s", exc);
  }
}

/**
 * Remove all cached skill entries whose `source_path` matches *file_path*.
 *
 * Called by the worker after re-indexing a file that was in the dirty queue,
 * when that file is a known skill body path. Ensures that the stale cached
 * body is not served to the agent after the skill has been edited on disk.
 *
 * Also removes associated compact files keyed to the same skill name/session
 * so a subsequent `--compact` recall regenerates from the fresh body.
 *
 * Returns the number of body files removed. Fail-soft: any I/O error is logged
 * and skipped so the worker is never interrupted.
 */
export function invalidate_for_path(file_path: string): number {
  if (!file_path) {
    return 0;
  }

  // Normalise the path for comparison: resolve forward-slash/back-slash
  // differences on Windows.
  let norm_path: string;
  try {
    norm_path = fs.realpathSync(path.resolve(file_path));
  } catch (e) {
    if (isOSError(e) || e instanceof TypeError) {
      norm_path = file_path.replace(/\\/g, "/");
    } else {
      throw e;
    }
  }

  let removed = 0;
  // Set of compact-file name suffixes to purge, built during the body-removal
  // loop (before files are deleted) so the second pass sees the right suffix
  // patterns even though the body .txt files have already been unlinked.
  const compact_suffixes = new Set<string>();
  const cache_dir = _skill_outputs_dir();
  if (!isDir(cache_dir)) {
    return 0;
  }

  for (const entry of self.list_outputs()) {
    const oid = entry.output_id;
    if (!oid) {
      continue;
    }
    const meta = self.read_sidecar(oid);
    if (meta === null) {
      continue;
    }
    if (!meta.source_path) {
      continue;
    }
    let candidate_norm: string;
    try {
      candidate_norm = fs.realpathSync(path.resolve(meta.source_path));
    } catch (e) {
      if (isOSError(e) || e instanceof TypeError) {
        candidate_norm = meta.source_path.replace(/\\/g, "/");
      } else {
        throw e;
      }
    }
    if (candidate_norm !== norm_path) {
      continue;
    }
    // Match found: collect the compact suffix pattern BEFORE removing files
    // so the suffix is available even after the body .txt is deleted.
    // Must mirror _compact_file_id exactly — it lowercases the safe name, so
    // a mixed-case skill name (e.g. "userSettings:brainstorming") writes a
    // compact file as "...-usersettings_brainstormingn-compact". Without the
    // same .lower() here the purge suffix never matches and the stale compact
    // survives a skill edit.
    let safe_name = meta.skill_name.toLowerCase().replace(/:/g, "_");
    if (meta.skill_name.includes(":")) {
      safe_name += "n";
    }
    compact_suffixes.add(`-${safe_name}-compact`);
    // Remove body file (.txt and optionally .gz) and sidecar (.json).
    const body_path = path.join(cache_dir, `${oid}.txt`);
    const gz_path = path.join(cache_dir, `${oid}.gz`);
    const sidecar = path.join(cache_dir, `${oid}.json`);
    for (const p of [body_path, gz_path, sidecar]) {
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          _LOG.debug("skill_cache.invalidate_for_path: removed %s", path.basename(p));
        }
      } catch (exc) {
        if (isOSError(exc)) {
          _LOG.debug(
            "skill_cache.invalidate_for_path: failed to remove %s: %s",
            path.basename(p),
            exc,
          );
        } else {
          throw exc;
        }
      }
    }
    removed += 1;
  }

  // Purge compact files whose name ends with any of the collected suffixes.
  // Compact files are named `{session_fragment}-{safe_name}-compact` with no
  // extension, so `fp.suffix == ""` and the suffix pattern is an exact match.
  if (compact_suffixes.size > 0) {
    let names: string[];
    try {
      names = fs.readdirSync(cache_dir);
    } catch (exc) {
      _LOG.debug("skill_cache.invalidate_for_path: compact scan failed: %s", exc);
      names = [];
    }
    for (const name of names) {
      if (pathSuffix(name)) {
        // compact files have no extension (.txt/.gz/.json have suffixes)
        continue;
      }
      for (const sfx of compact_suffixes) {
        if (name.endsWith(sfx)) {
          try {
            fs.unlinkSync(path.join(cache_dir, name));
            _LOG.debug(
              "skill_cache.invalidate_for_path: removed compact %s",
              name,
            );
          } catch {
            // suppress(OSError)
          }
          break;
        }
      }
    }
  }

  // Mark any doc compact sidecar stale so pre_read stops serving it.
  try {
    const _abs = norm_path;
    const _proj = find_project(path.dirname(_abs));
    if (_proj !== null) {
      const _cpath = doc_compact.find_compact_for_path(_abs, _proj.hash);
      if (_cpath !== null) {
        doc_compact.mark_compact_stale(_cpath);
      }
    }
  } catch (exc) {
    _LOG.debug("skill_cache.invalidate_for_path: doc_compact stale failed: %s", exc);
  }

  if (removed > 0) {
    _LOG.info(
      "skill_cache.invalidate_for_path: removed %d entr%s for path %s",
      removed,
      removed === 1 ? "y" : "ies",
      sanitize_log_str(file_path, 120),
    );
  }
  return removed;
}

/** Return metadata for every cached output, newest first. */
export function list_outputs(): OutputStatDict[] {
  return list_cache_outputs(_skill_outputs_dir);
}

/**
 * Return the most-recent cached entry for *skill_name*, across all sessions.
 *
 * Walks the cache directory and picks the entry whose `skill_name` field in
 * the sidecar matches. Returns `null` when no entry exists. Used by the
 * `token-goat skill-body NAME` CLI to find a body without needing the full
 * `output_id`.
 *
 * Skips invalid skill names defensively rather than scanning the directory
 * with a name that could never have produced a valid entry.
 */
export function lookup_by_name(skill_name: string): SkillMeta | null {
  const matches = self.lookup_all_by_name(skill_name);
  return matches.length > 0 ? matches[0]! : null;
}

/**
 * Resolve *skill_name* to an on-disk file path, or return `null`.
 *
 * Resolution order:
 *
 *  1. Check the in-memory/on-disk skill cache for any session's stored entry
 *     that recorded a `source_path`. Use the most-recent such entry whose path
 *     still exists on disk.
 *  2. Delegate to the same filesystem probe that the PostToolUse(Skill) hook
 *     uses at capture time: `~/.claude/skills/<name>/SKILL.md`, plugin layouts,
 *     etc. This covers the case where no PostToolUse hook has fired yet (e.g.
 *     the user queries a skill they have installed but never loaded in this
 *     session).
 *
 * Returns `null` when the skill cannot be located by either strategy. Never
 * raises — callers treat `null` as "not found".
 *
 * Returns a path string (Python returns a `Path`); callers stat/read it.
 */
export function get_skill_file_path(skill_name: string): string | null {
  // Strategy 1: use the source_path recorded by the PostToolUse(Skill) hook.
  for (const candidate of self.lookup_all_by_name(skill_name)) {
    const sp = candidate.source_path;
    if (sp) {
      try {
        if (isFile(sp)) {
          return sp;
        }
      } catch (e) {
        if (isOSError(e) || e instanceof TypeError) {
          continue;
        }
        throw e;
      }
    }
  }

  // Strategy 2: probe the filesystem using the same logic as the hook.
  const resolved = hooks_skill._resolve_skill_body_path(skill_name);
  if (resolved) {
    try {
      if (isFile(resolved)) {
        return resolved;
      }
    } catch (e) {
      if (!(isOSError(e) || e instanceof TypeError)) {
        throw e;
      }
      // suppress(OSError, ValueError)
    }
  }

  return null;
}

/**
 * Return every cached entry for *skill_name*, newest first.
 *
 * Used by the CLI recall path: when the most-recent entry's body file has been
 * evicted (the sidecar may outlive the body since both go through independent
 * unlinks under the byte-cap eviction loop), the caller can walk older entries
 * to find a still-loadable body. Each entry is paired with its sidecar
 * metadata so callers can inspect `ts` and decide which is acceptable.
 *
 * Returns an empty list when no entry exists or the skill name is invalid.
 */
export function lookup_all_by_name(skill_name: string): SkillMeta[] {
  const name = _safe_skill_name(skill_name);
  if (name === null) {
    return [];
  }
  const results: SkillMeta[] = [];
  for (const entry of self.list_outputs()) {
    const oid = entry.output_id;
    if (!oid) {
      continue;
    }
    const meta = self.read_sidecar(oid);
    if (meta === null || meta.skill_name !== name) {
      continue;
    }
    results.push(meta);
  }
  results.sort((a, b) => b.ts - a.ts);
  return results;
}

// sha portion is short_content_hash output: 16 lowercase hex chars.
const _SHA_RE = /^[0-9a-f]{16}$/;

/**
 * Return lightweight SkillMeta stubs for every cached entry in *session_id*.
 *
 * The `output_id` filename encodes `{session_prefix}-{skill_name}-{sha}`. We
 * parse it directly (no sidecar needed — `store_output` does not write
 * sidecars) so that callers can discover whether the same skill was stored
 * with multiple distinct `content_sha` values during one session (i.e. the
 * skill body changed between loads).
 *
 * Fields populated: `output_id`, `skill_name`, `content_sha`. Fields left at
 * defaults: `body_bytes=0`, `ts=0.0`, `truncated=False`. Entries that do not
 * match the expected 3-segment format are skipped.
 *
 * `list_outputs()` returns entries newest-first by mtime; that order is
 * preserved so callers iterating for "most recent sha" get it first.
 */
export function list_by_session(session_id: string): SkillMeta[] {
  const prefix = safe_session_fragment(session_id);
  // prefix is 16 chars; output_id is "{prefix}-{safe_name}-{sha16}".
  // Split off the prefix+dash, then split on "-" from the right to extract sha.
  const prefix_dash = prefix + "-";
  // sha portion is short_content_hash output: 16 lowercase hex chars. Validate
  // both length and alphabet so a malformed filename that happens to share the
  // session prefix can't pollute the parsed result.
  const results: SkillMeta[] = [];
  for (const entry of self.list_outputs()) {
    const oid = entry.output_id;
    if (!oid || !oid.startsWith(prefix_dash)) {
      continue;
    }
    // Strip session prefix, leaving "{safe_name}-{sha16}".
    const remainder = oid.slice(prefix_dash.length);
    // sha is always the last 16-char hex segment after the final "-".
    const dash_pos = remainder.lastIndexOf("-");
    if (dash_pos < 1) {
      continue;
    }
    const safe_name = remainder.slice(0, dash_pos);
    const sha = remainder.slice(dash_pos + 1);
    if (!safe_name || !_SHA_RE.test(sha)) {
      continue;
    }
    // Restore ":" from "_" in plugin-namespaced names (best-effort; may be
    // ambiguous if the skill name itself contains underscores, but the
    // consumer only needs this for grouping, not exact round-tripping).
    const skill_name = safe_name; // keep as-is for grouping; exact form in session
    results.push(
      new SkillMeta(oid, skill_name, sha, 0, entry.mtime ?? 0.0, false),
    );
  }
  return results;
}

/** Return the sidecar JSON metadata path for *output_id*, or null on invalid ID. */
export function sidecar_meta_path(output_id: string): string | null {
  const base = safe_join_output_id(output_id, _skill_outputs_dir, "skill_cache");
  if (base === null) {
    return null;
  }
  return sidecar_path_for(base);
}

/**
 * Persist *meta* as a JSON sidecar next to its output file (best-effort).
 *
 * Embeds {@link SIDECAR_SCHEMA_VERSION} in the written JSON so that
 * {@link read_sidecar} can detect entries created by older versions and apply
 * appropriate migration or ignore-and-continue logic.
 */
export function write_sidecar(meta: SkillMeta): void {
  const sidecar_path = self.sidecar_meta_path(meta.output_id);
  if (sidecar_path === null) {
    return;
  }
  try {
    // dataclasses.asdict(meta): field order matches the dataclass declaration.
    const payload: Record<string, unknown> = {
      output_id: meta.output_id,
      skill_name: meta.skill_name,
      content_sha: meta.content_sha,
      body_bytes: meta.body_bytes,
      ts: meta.ts,
      truncated: meta.truncated,
      source_path: meta.source_path,
      schema_v: SIDECAR_SCHEMA_VERSION,
    };
    atomicWriteText(sidecar_path, JSON.stringify(payload));
  } catch (exc) {
    if (isOSError(exc)) {
      _LOG.debug(
        "skill_cache: sidecar write failed for %s: %s",
        meta.output_id,
        exc,
      );
    } else {
      throw exc;
    }
  }
}

/**
 * Return parsed {@link SkillMeta} from the sidecar JSON, or null.
 *
 * Tolerant of older sidecars that lack fields added in later schema versions:
 *
 *  * **v1 → v2**: `source_path` was added as an optional field with `""`
 *    default; older entries simply omit it. {@link read_sidecar} back-fills the
 *    default so callers never see `null` for this field.
 *  * Entries with `schema_v` greater than {@link SIDECAR_SCHEMA_VERSION}
 *    (written by a future version of token-goat) are loaded with best-effort
 *    parsing — unknown fields are silently ignored, known fields retain their
 *    safe defaults when absent.
 *
 * Returns `null` only when the file is missing, unreadable, or the JSON payload
 * cannot be coerced into a valid {@link SkillMeta} at all (e.g. the required
 * `output_id` field is a dict rather than a string).
 */
export function read_sidecar(output_id: string): SkillMeta | null {
  const p = self.sidecar_meta_path(output_id);
  if (p === null) {
    return null;
  }
  const data = load_sidecar_json(p);
  if (data === null) {
    return null;
  }
  try {
    // Log a debug note when the stored schema version is ahead of ours so
    // operators can tell if a downgrade is in play without failing loudly.
    const stored_v = data["schema_v"];
    if (stored_v !== null && stored_v !== undefined) {
      let stored_v_int: number;
      const coerced = pyInt(stored_v);
      stored_v_int = coerced === null ? 0 : coerced;
      if (stored_v_int > SIDECAR_SCHEMA_VERSION) {
        _LOG.debug(
          "read_sidecar: entry %s has schema_v=%s > current %s; " +
            "unknown fields will be ignored",
          output_id,
          stored_v,
          SIDECAR_SCHEMA_VERSION,
        );
      }
    }
    // Required fields: int()/float()/str() coercions may raise (TypeError/
    // ValueError) when a field has an incompatible type (e.g. output_id is a
    // dict). Those propagate to the catch below → null.
    const output_id_v = pyStr(data["output_id"], output_id);
    const skill_name_v = pyStr(data["skill_name"], "");
    const content_sha_v = pyStr(data["content_sha"], "");
    const body_bytes_v = pyIntStrict(data["body_bytes"], 0);
    const ts_v = pyFloatStrict(data["ts"], 0.0);
    const truncated_v = pyBool(data["truncated"], false);
    // v1 entries lack source_path; default to "" (safe for all callers).
    const source_path_v = pyStr(data["source_path"], "");
    return new SkillMeta(
      output_id_v,
      skill_name_v,
      content_sha_v,
      body_bytes_v,
      ts_v,
      truncated_v,
      source_path_v,
    );
  } catch (e) {
    if (e instanceof CoercionError) {
      return null;
    }
    throw e;
  }
}

// --- Python int()/float()/str()/bool() coercion helpers -------------------

/** Error mirroring Python TypeError/ValueError raised by int()/float(). */
class CoercionError extends Error {}

/**
 * Python `str(x)` for sidecar values, with a default when the key is absent.
 *
 * In Python `str(data.get(k, default))` always succeeds (str() never raises for
 * the JSON-derived types we encounter), so this returns the stringified value.
 * When the key is missing/undefined, the (already-string) default is used.
 */
function pyStr(value: unknown, defaultStr: string): string {
  if (value === undefined) {
    return defaultStr;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return String(value);
  }
  // dict/list/etc.: str() produces a repr but is still a string; coercion
  // succeeds. Use JSON-ish repr (the exact text is never compared by callers).
  return String(value);
}

/**
 * Python `int(data.get(k, default))` for sidecar values, raising CoercionError
 * on a value that int() would reject (e.g. a dict, or a non-numeric string).
 */
function pyIntStrict(value: unknown, defaultInt: number): number {
  if (value === undefined) {
    return defaultInt;
  }
  if (typeof value === "number") {
    return Math.trunc(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (/^[+-]?\d+$/.test(t)) {
      return parseInt(t, 10);
    }
    throw new CoercionError(`invalid literal for int(): ${value}`);
  }
  throw new CoercionError("int() argument must be a number or string");
}

/**
 * Python `float(data.get(k, default))` for sidecar values, raising
 * CoercionError on a value float() would reject.
 */
function pyFloatStrict(value: unknown, defaultFloat: number): number {
  if (value === undefined) {
    return defaultFloat;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1.0 : 0.0;
  }
  if (typeof value === "string") {
    const t = value.trim();
    // Python float() accepts ints, floats, scientific, inf, nan.
    if (t === "") {
      throw new CoercionError("could not convert string to float: ''");
    }
    const lowered = t.toLowerCase();
    if (
      lowered === "inf" ||
      lowered === "+inf" ||
      lowered === "infinity" ||
      lowered === "+infinity"
    ) {
      return Infinity;
    }
    if (lowered === "-inf" || lowered === "-infinity") {
      return -Infinity;
    }
    if (lowered === "nan" || lowered === "+nan" || lowered === "-nan") {
      return NaN;
    }
    const num = Number(t);
    if (Number.isNaN(num)) {
      throw new CoercionError(`could not convert string to float: ${value}`);
    }
    return num;
  }
  throw new CoercionError("float() argument must be a number or string");
}

/** Python `bool(data.get(k, default))` — truthiness, never raises. */
function pyBool(value: unknown, defaultBool: boolean): boolean {
  if (value === undefined) {
    return defaultBool;
  }
  // Python bool(): "", 0, 0.0, None, [], {} are falsy.
  if (value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** Python `int(stored_v)` for the schema_v log path; returns null on TypeError/ValueError. */
function pyInt(value: unknown): number | null {
  try {
    return pyIntStrict(value, 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compact summary helpers
// ---------------------------------------------------------------------------

// Maximum characters for a compact summary (~400 tokens at ~4 chars/token).
const _COMPACT_MAX_CHARS = 1600;

// Regex that matches the one-line header prepended by store_compact.
// Two supported forms:
//   Old (pre-staleness-tracking): "--- compact form (N tokens) ---\n"
//   New (with source SHA):        "--- compact form (N tokens, sha=ABCD1234) ---\n"
// Used by _strip_compact_header to recover the bare body for accurate token
// counting and by extract_compact_source_sha to retrieve the embedded SHA.
const _COMPACT_HEADER_RE = /^--- compact form \(\d+ tokens(?:, sha=[0-9a-f]+)?\) ---\n/;
const _COMPACT_HEADER_SHA_RE = /^--- compact form \(\d+ tokens, sha=([0-9a-f]+)\) ---\n/;

// Keywords that identify high-priority "rule" lines worth including in the compact.
const _RULE_KEYWORDS_RE = /\b(CRITICAL|MUST|NEVER|RULE)\b/;

/**
 * Strip the one-line metadata header from a stored compact text and return the body.
 *
 * {@link store_compact} prepends `"--- compact form (N tokens) ---\n"` (or the
 * newer `"--- compact form (N tokens, sha=ABCD1234) ---\n"` form) so readers can
 * immediately see the token count. When computing token counts programmatically
 * (e.g. in {@link get_all_cached_skills}) we need only the body so that
 * `len(body) // 4` matches the formula used at write time.
 *
 * Returns the input unchanged when no header is present (safe for callers that
 * may receive raw body text instead of stored compact text).
 */
export function _strip_compact_header(stored_text: string): string {
  const m = _COMPACT_HEADER_RE.exec(stored_text);
  if (m) {
    return stored_text.slice(m[0].length);
  }
  return stored_text;
}

/**
 * Return the `source_sha` embedded in a compact header, or `null`.
 *
 * When {@link store_compact} is called with a *source_sha* (the sha256 hex
 * digest of the body that generated the compact), it embeds the first 12 hex
 * characters in the header line:
 *
 *     `--- compact form (N tokens, sha=ABCD12345678) ---`
 *
 * This function extracts that fragment so callers can compare it against the
 * current body's sha and warn when the compact is derived from a different
 * version of the skill body (i.e. the compact may be stale).
 *
 * Returns `null` when the header is absent or was written by an older version
 * of token-goat that did not embed a sha.
 */
export function extract_compact_source_sha(stored_text: string): string | null {
  const m = _COMPACT_HEADER_SHA_RE.exec(stored_text);
  if (m) {
    return m[1]!;
  }
  return null;
}

/**
 * Score the quality of a compact relative to its source body.
 *
 * Returns a dict with these fields:
 *
 * - `score` (int 0-100): overall quality score (higher is better).
 * - `coverage_ratio` (float 0.0-1.0): compact tokens / body tokens, capped at 1.0.
 *   A well-formed compact should be 0.10-0.50 (10-50% of the body).
 * - `non_empty_sections` (int): number of headings in the compact followed by
 *   at least one non-blank content line.
 * - `has_goal_marker` (bool): whether the compact contains a COMPACT_END marker
 *   or a frontmatter `description:` field — both indicate the compact was
 *   intentionally curated vs. heuristically generated.
 * - `headings_count` (int): total H1-H4 heading count in the compact body
 *   (outside fenced code blocks).
 * - `has_rule_lines` (bool): whether any CRITICAL/MUST/NEVER/RULE lines were
 *   preserved (a signal that the compact captured load-bearing directives).
 * - `issues` (list[str]): human-readable warnings about quality problems.
 *
 * Callers must pass the *bare* compact body (without the `--- compact form ... ---`
 * header line — pass the output of {@link _strip_compact_header}). The *full_body*
 * should be the original skill body text used to estimate the coverage ratio.
 */
export function score_compact(
  compact_body: string,
  full_body: string,
): Record<string, unknown> {
  const issues: string[] = [];

  // -- token estimates ------------------------------------------------------
  // Use the same 3-chars/token heuristic as compact.estimate_tokens so the
  // coverage ratio is internally consistent.
  const compact_tokens = Math.max(1, Math.floor(cpLen(compact_body) / 3));
  const body_tokens = Math.max(1, Math.floor(cpLen(full_body) / 3));
  const raw_ratio = compact_tokens / body_tokens;
  const coverage_ratio = Math.min(1.0, raw_ratio);

  // -- heading analysis (code-block-aware) ----------------------------------
  let in_fence = false;
  const headings: string[] = [];
  const lines = splitlines(compact_body);
  let i = 0;
  const heading_has_content: boolean[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    const stripped = pyStrip(line);
    if (stripped.startsWith("```")) {
      in_fence = !in_fence;
      i += 1;
      continue;
    }
    if (!in_fence && stripped.startsWith("#")) {
      headings.push(stripped);
      // Look ahead for at least one non-blank content line
      let j = i + 1;
      let has_content = false;
      while (j < lines.length) {
        const next_stripped = pyStrip(lines[j]!);
        if (next_stripped.startsWith("#")) {
          break;
        }
        if (next_stripped && !next_stripped.startsWith("```")) {
          has_content = true;
          break;
        }
        j += 1;
      }
      heading_has_content.push(has_content);
    }
    i += 1;
  }

  const headings_count = headings.length;
  const non_empty_sections = heading_has_content.filter((hc) => hc).length;

  // -- goal / curation markers ----------------------------------------------
  const has_goal_marker =
    full_body.includes("<!-- COMPACT_END -->") ||
    Boolean(_COMPACT_HEADER_RE.exec(compact_body + "\n")) || // unlikely but safe
    // frontmatter description in the body is a strong curation signal
    (full_body.startsWith("---") && cpSlice(full_body, 400).includes("description:"));

  // -- rule-line presence ---------------------------------------------------
  const has_rule_lines = Boolean(_RULE_KEYWORDS_RE.exec(compact_body));

  // -- quality scoring ------------------------------------------------------
  // Base score starts at 50; penalties and bonuses applied below.
  let score = 50;

  // Coverage ratio: ideal range 0.10-0.50. Too small → may be empty/stub.
  // Too large → compact is not meaningfully smaller than the body.
  if (raw_ratio < 0.05) {
    score -= 20;
    issues.push(
      `compact is very small (${pctFormat(coverage_ratio)} of body) — may be stub or empty`,
    );
  } else if (raw_ratio < 0.1) {
    score -= 8;
    issues.push(`compact coverage is low (${pctFormat(coverage_ratio)} of body)`);
  } else if (raw_ratio <= 0.5) {
    score += 15; // ideal range
  } else if (raw_ratio <= 0.8) {
    score += 5; // acceptable but verbose
  } else {
    score -= 10;
    issues.push(
      `compact is ${pctFormat(coverage_ratio)} of body — barely smaller than the original`,
    );
  }

  // Headings: structured compacts are easier to navigate.
  if (headings_count === 0) {
    score -= 10;
    issues.push("compact has no headings — may be unstructured prose");
  } else if (headings_count >= 3) {
    score += 10;
  }

  // Non-empty sections: sections with content are better than placeholder headers.
  const empty_sections = headings_count - non_empty_sections;
  if (headings_count > 0 && empty_sections > 0) {
    score -= 5 * Math.min(empty_sections, 3);
    issues.push(`${empty_sections} section(s) with no content lines`);
  }

  // Goal/curation marker: intentionally curated compacts score higher.
  if (has_goal_marker) {
    score += 10;
  }

  // Rule lines: load-bearing directives were preserved.
  if (has_rule_lines) {
    score += 5;
  }

  // Clamp to 0-100.
  score = Math.max(0, Math.min(100, score));

  return {
    score: score,
    coverage_ratio: roundHalfEven(coverage_ratio, 4),
    non_empty_sections: non_empty_sections,
    has_goal_marker: has_goal_marker,
    headings_count: headings_count,
    has_rule_lines: has_rule_lines,
    issues: issues,
  };
}

/** Python `f"{x:.0%}"`: percent with no decimals, rounding half-to-even. */
function pctFormat(x: number): string {
  // Python f"{x:.0%}" — multiply by 100 then round half-to-even (banker's).
  return `${roundHalfEven(x * 100, 0)}%`;
}

/** Increment a non-negative integer decimal string by 1 (carry-aware). */
function _incDecimalString(s: string): string {
  const a = s.split("");
  let i = a.length - 1;
  while (i >= 0) {
    if (a[i] === "9") {
      a[i] = "0";
      i -= 1;
    } else {
      a[i] = String.fromCharCode(a[i]!.charCodeAt(0) + 1);
      break;
    }
  }
  if (i < 0) {
    a.unshift("1");
  }
  return a.join("");
}

/**
 * Python `round(x, ndigits)` — banker's rounding (round half to EVEN) on the
 * TRUE binary value. The naive `x * 10**n` scaling loses the tie-breaking
 * information (e.g. 0.00625*10000 rounds to exactly 62.5 in float, hiding that
 * the true double is slightly ABOVE the half), so round on the correctly-rounded
 * decimal expansion from toFixed instead. Verified byte-for-byte vs CPython
 * round() / f"{x:.0%}" over an 80k-pair grid + exact-half stressors.
 */
export function roundHalfEven(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) {
    return x;
  }
  if (x === 0) {
    return 0;
  }
  const neg = x < 0;
  const ax = Math.abs(x);
  // toFixed is correctly rounded on the true double; ndigits+30 digits reveal the
  // true tail past the cut so we can detect a genuine half-way tie.
  const hi = ax.toFixed(Math.min(100, ndigits + 30));
  const dot = hi.indexOf(".");
  const intPart = hi.slice(0, dot);
  const frac = hi.slice(dot + 1);
  const keep = frac.slice(0, ndigits);
  const tail = frac.slice(ndigits);
  let up: boolean;
  const d0 = tail.charCodeAt(0) - 48;
  if (d0 < 5) {
    up = false;
  } else if (d0 > 5) {
    up = true;
  } else if (/[1-9]/.test(tail.slice(1))) {
    up = true; // strictly above the half-way point
  } else {
    // Exactly halfway → round to even.
    const lastKept = keep.length ? keep : intPart;
    up = (lastKept.charCodeAt(lastKept.length - 1) - 48) % 2 === 1;
  }
  let comb = intPart + keep;
  if (up) {
    comb = _incDecimalString(comb);
  }
  if (ndigits === 0) {
    return (neg ? -1 : 1) * Number(comb);
  }
  while (comb.length <= ndigits) {
    comb = "0" + comb;
  }
  const res = comb.slice(0, comb.length - ndigits) + "." + comb.slice(comb.length - ndigits);
  return (neg ? -1 : 1) * Number(res);
}

/**
 * Extract a compact summary from *full_body* capped at ~400 tokens (1600 chars).
 *
 * The summary includes, in order:
 * 1. The YAML frontmatter `description` field (if present) as an opening line.
 * 2. All H2 and H3 headings as a table of contents (code-block-aware: headings
 *    inside fenced blocks are excluded to avoid false positives from examples).
 * 3. All lines containing CRITICAL/MUST/NEVER/RULE keywords (first occurrence
 *    per unique line, deduplicated, code-block-aware).
 * 4. Lines starting with `**` (bold emphasis — typically key directives,
 *    code-block-aware).
 * 5. Fallback for flat skill files: when none of the above yield content, the
 *    first non-empty, non-heading prose paragraph (up to 400 chars) is used.
 *    Flat skills (no structural headings, no rule keywords) still get a usable
 *    compact so the compaction manifest is not empty for that skill.
 *
 * The result is capped at {@link _COMPACT_MAX_CHARS} characters. Returns the
 * compact text as a single string; never raises.
 */
export function generate_compact_summary(full_body: string): string {
  if (!full_body) {
    return "";
  }

  const parts: string[] = [];

  // 1. Extract description from YAML frontmatter (between leading --- fences).
  const fm_desc = _extract_frontmatter_description(full_body);
  if (fm_desc) {
    parts.push(fm_desc);
  }

  // Single-pass over lines: track code-block state to exclude content inside
  // fenced blocks from all three extraction phases (headings, rules, bold).
  // A fence opens or closes when a stripped line starts with ``` or ~~~.
  let in_code_block = false;
  // Frontmatter tracking: skip the leading --- block so field declarations
  // (e.g. "description: ...") are not captured as prose or rule lines.
  // _fm_open/closed follow the first pair of "---" lines at the head of the
  // document; after that, "---" is a normal horizontal rule.
  let in_frontmatter = false;
  const headings: string[] = [];
  const seen_rules = new Set<string>();
  const rule_lines: string[] = [];
  const seen_bold = new Set<string>();
  const bold_lines: string[] = [];
  // Track first prose paragraph for the flat-file fallback (phase 5).
  let first_prose = "";

  const allLines = splitlines(full_body);
  for (let line_idx = 0; line_idx < allLines.length; line_idx++) {
    const line = allLines[line_idx]!;
    const stripped = pyStrip(line);

    // Frontmatter detection: the very first line "---" opens a YAML block;
    // a subsequent "---" closes it. We skip all content inside.
    if (line_idx === 0 && stripped === "---") {
      in_frontmatter = true;
      continue;
    }
    if (in_frontmatter) {
      if (stripped === "---") {
        in_frontmatter = false;
      }
      continue;
    }

    // Track fenced code block state.
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      in_code_block = !in_code_block;
      continue;
    }
    if (in_code_block) {
      continue;
    }

    // 2. H2/H3 headings as table of contents.
    if (stripped.startsWith("## ") || stripped.startsWith("### ")) {
      headings.push(stripped);
      continue;
    }

    if (!stripped) {
      continue;
    }

    // 3. Lines with CRITICAL/MUST/NEVER/RULE (deduplicated, first occurrence).
    if (_RULE_KEYWORDS_RE.exec(stripped) && !seen_rules.has(stripped)) {
      seen_rules.add(stripped);
      rule_lines.push(stripped);
    }

    // 4. Bold-emphasis lines (start with "**").
    if (
      stripped.startsWith("**") &&
      !seen_bold.has(stripped) &&
      !seen_rules.has(stripped)
    ) {
      seen_bold.add(stripped);
      bold_lines.push(stripped);
    }

    // 5. Collect first prose paragraph for flat-file fallback: skip H1 titles
    // and lines that are solely horizontal rules or other Markdown decorators.
    if (
      !first_prose &&
      !stripped.startsWith("#") &&
      !stripped.startsWith(">") &&
      !isSubsetOfDecorators(stripped) &&
      cpLen(stripped) >= 20
    ) {
      first_prose = stripped;
    }
  }

  if (headings.length > 0) {
    parts.push("**Sections:** " + headings.join(" | "));
  }
  if (rule_lines.length > 0) {
    parts.push(rule_lines.join("\n"));
  }
  if (bold_lines.length > 0) {
    parts.push(bold_lines.join("\n"));
  }

  // 5. Flat-file fallback: when none of the structural extractions yielded
  // content beyond a possible frontmatter description, include the first prose
  // paragraph so the manifest is not empty for minimally structured skills.
  if (
    headings.length === 0 &&
    rule_lines.length === 0 &&
    bold_lines.length === 0 &&
    first_prose
  ) {
    const cap = Math.min(cpLen(first_prose), 400);
    let prose_snippet = cpSlice(first_prose, cap);
    if (cap < cpLen(first_prose)) {
      prose_snippet = pyRStrip(prose_snippet) + "…";
    }
    parts.push(prose_snippet);
  }

  let text = parts.join("\n\n");

  // Cap at _COMPACT_MAX_CHARS, breaking at a markdown heading or paragraph
  // boundary when possible so the compact ends at a coherent structural point
  // rather than mid-sentence. Falls back to the last plain newline, then
  // hard-cuts at the byte cap.
  if (cpLen(text) > _COMPACT_MAX_CHARS) {
    let cut = find_markdown_boundary(text, _COMPACT_MAX_CHARS);
    if (cut <= 0) {
      cut = _COMPACT_MAX_CHARS;
    }
    text = pyRStrip(text.slice(0, cut)) + "…";
  }

  return text;
}

/** Python `set(stripped).issubset(set("-_* \t"))` for the prose-skip guard. */
function isSubsetOfDecorators(stripped: string): boolean {
  const allowed = new Set(["-", "_", "*", " ", "\t"]);
  for (const ch of stripped) {
    if (!allowed.has(ch)) {
      return false;
    }
  }
  return true;
}

/**
 * Return the `description` value from YAML frontmatter, or an empty string.
 *
 * Frontmatter is a block delimited by `---` at line 0 and a second `---`
 * later. The `description` field may span multiple lines (block scalar); this
 * implementation handles the simple single-line case (`description: text`) and
 * ignores multi-line scalars to avoid a YAML parser dependency.
 */
function _extract_frontmatter_description(body: string): string {
  const lines = splitlines(body);
  if (lines.length === 0 || pyStrip(lines[0]!) !== "---") {
    return "";
  }
  // Find closing fence.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (pyStrip(lines[i]!) === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return "";
  }
  // Scan frontmatter block for a simple `description: ...` line.
  const desc_re = /^description\s*:\s*(.+)$/i;
  for (const line of lines.slice(1, end)) {
    const m = desc_re.exec(pyStrip(line));
    if (m) {
      const value = pyStripQuotes(pyStrip(m[1]!));
      return value;
    }
  }
  return "";
}

/** Python `s.strip("'\"")`: strip leading/trailing single/double quotes. */
function pyStripQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === "'" || s[start] === '"')) {
    start += 1;
  }
  while (end > start && (s[end - 1] === "'" || s[end - 1] === '"')) {
    end -= 1;
  }
  return s.slice(start, end);
}

/**
 * Build the filesystem-safe compact-file ID for a (session, skill) pair.
 *
 * Uses the same namespace-collision guard as {@link output_id_for}: when
 * *skill_name* contains a `:` (plugin-namespaced form) an `n` suffix is
 * appended to the safe name so `plugin:improve` and `plugin_improve` produce
 * distinct compact file IDs.
 */
function _compact_file_id(session_id: string, skill_name: string): string {
  const safe_session = safe_session_fragment(session_id);
  let safe_name = skill_name.toLowerCase().replace(/:/g, "_");
  if (skill_name.includes(":")) {
    safe_name += "n"; // namespace-collision guard (matches output_id_for)
  }
  return `${safe_session}-${safe_name}-compact`;
}

/**
 * Persist a compact summary for *skill_name* under the skills cache directory.
 *
 * The compact is stored as a plain text file beside the full-body files, keyed
 * by `{session_fragment}-{safe_name}-compact` (collision-safe: see
 * {@link _compact_file_id}). Fail-soft: any I/O error is logged and swallowed so
 * callers are never interrupted.
 *
 * *source_sha* is the sha256 hex digest of the skill body that generated this
 * compact. When supplied, the first 12 hex characters are embedded in the
 * header line so {@link extract_compact_source_sha} can later verify freshness:
 *
 *     `--- compact form (N tokens, sha=ABCD12345678) ---`
 *
 * Callers should pass the `content_sha` from the {@link SkillMeta} entry that
 * was active when the compact was generated. Omitting it (or passing `null`)
 * stores the old header format, which is treated as "unknown sha" by the
 * staleness check and will not trigger a stale-compact warning.
 */
export function store_compact(
  session_id: string,
  skill_name: string,
  compact_text: string,
  source_sha: string | null = null,
): void {
  const name = _safe_skill_name(skill_name);
  if (name === null) {
    _LOG.warning(
      "skill_cache.store_compact: rejected invalid skill_name: %s",
      sanitize_log_str(skill_name, 120),
    );
    return;
  }

  safe_cache_op("store_compact", { log: _LOG }, (): void => {
    const file_id = _compact_file_id(session_id, name);
    const out_dir = _skill_outputs_dir();
    const out_path = path.join(out_dir, file_id);
    // Prepend a header so readers (compaction manifest, CLI, model) immediately
    // know this is the truncated compact form and how large it is relative to
    // the full body. The token estimate uses the 4-chars/token convention
    // consistent with how hooks_skill.py reports body size.
    const compact_tokens = Math.max(1, Math.floor(cpLen(compact_text) / 4));
    // Embed the first 12 hex chars of source_sha when available so the
    // staleness check in cmd_skill_body can detect when the compact was
    // derived from a different version of the body.
    let header: string;
    if (source_sha && source_sha.length >= 8) {
      const sha_fragment = source_sha.slice(0, 12);
      header = `--- compact form (${compact_tokens} tokens, sha=${sha_fragment}) ---\n`;
    } else {
      header = `--- compact form (${compact_tokens} tokens) ---\n`;
    }
    const stored_text = header + compact_text;
    // Use atomic write (temp file + rename) so concurrent sessions writing the
    // same compact cannot produce a torn file. Matches the pattern used by
    // store_blob / session.py for all other cache writes.
    atomicWriteText(out_path, stored_text);
    // Invalidate the directory listing cache so subsequent calls to
    // get_compact_any_session within the same process pick up the newly
    // written compact without waiting for the TTL to expire.
    _dir_listing_cache = null;
    _LOG.debug(
      "skill_cache.store_compact: stored id=%s (%d tokens)",
      file_id,
      compact_tokens,
    );
  });
}

// Minimum number of non-whitespace characters required for a compact to be
// considered valid. Files shorter than this threshold are treated as empty or
// corrupted (e.g. a zero-byte file, a file containing only a stale header, or
// a file produced by a partial write) and callers receive `null` instead of
// the garbage content. 10 chars is low enough to pass any real compact (even a
// trivial one-line "## Rules\nX." snippet is 14 chars) while reliably catching
// empty, header-only, and whitespace-only files.
export const _MIN_COMPACT_CONTENT_CHARS = 10;

/**
 * Return True when *text* looks like a real compact (non-empty, non-stub).
 *
 * Rejects:
 * * Empty strings and whitespace-only strings.
 * * Files whose non-whitespace content is below `_MIN_COMPACT_CONTENT_CHARS`
 *   — these are header-only stubs or zero-byte corruption artifacts.
 *
 * Does NOT validate format/structure; callers that need quality scoring should
 * call {@link score_compact} separately.
 */
export function _is_valid_compact(text: string): boolean {
  const stripped = pyStrip(text);
  if (!stripped) {
    return false;
  }
  let non_ws = 0;
  for (const c of stripped) {
    if (!charIsSpace(c)) {
      non_ws += 1;
    }
  }
  return non_ws >= _MIN_COMPACT_CONTENT_CHARS;
}

/**
 * Return a previously stored compact summary for *skill_name*, or `null`.
 *
 * Looks up by `{session_fragment}-{safe_name}-compact` (collision-safe: see
 * {@link _compact_file_id}) in the skills cache directory. Returns `null` when
 * absent. Fail-soft on I/O errors.
 */
export function get_compact(session_id: string, skill_name: string): string | null {
  const name = _safe_skill_name(skill_name);
  if (name === null) {
    return null;
  }

  try {
    const file_id = _compact_file_id(session_id, name);
    const out_path = path.join(_skill_outputs_dir(), file_id);
    if (!fs.existsSync(out_path)) {
      return null;
    }
    const text = readTextReplace(out_path);
    if (!self._is_valid_compact(text)) {
      _LOG.debug(
        "skill_cache.get_compact: compact file %s is empty or corrupted — returning null",
        file_id,
      );
      return null;
    }
    return text;
  } catch (exc) {
    if (isOSError(exc)) {
      _LOG.debug("skill_cache.get_compact: I/O error for %s: %s", skill_name, exc);
      return null;
    }
    throw exc;
  }
}

/**
 * Return a compact summary for *skill_name* from any session, or `null`.
 *
 * Unlike {@link get_compact}, this performs a cross-session glob search for
 * `*-{safe_name}-compact` files in the skills cache directory, picking the
 * newest match by file mtime. Used by hooks_skill post_skill advisory and by
 * install to verify that a pre-generated compact is visible regardless of
 * which session created it. Fail-soft on I/O errors.
 */
export function get_compact_any_session(skill_name: string): string | null {
  const name = _safe_skill_name(skill_name);
  if (name === null) {
    return null;
  }

  let safe_name = name.toLowerCase().replace(/:/g, "_");
  if (name.includes(":")) {
    safe_name += "n";
  }
  const suffix = `-${safe_name}-compact`;

  try {
    const out_dir = _skill_outputs_dir();
    // Use the process-local directory listing cache to avoid a separate glob()
    // syscall for each skill when multiple skills are looked up during a single
    // manifest render. The cache is refreshed every 5 s so newly written
    // compact files are visible promptly.
    const all_entries = self._get_skills_dir_listing(out_dir);
    const matches = all_entries.filter((p) => path.basename(p).endsWith(suffix));
    if (matches.length === 0) {
      return null;
    }
    // Sort by mtime descending so we try the newest file first. If it is
    // corrupted/empty, fall through to the next-newest one.
    const sorted_matches = [...matches].sort((a, b) => statMtime(b) - statMtime(a));
    for (const candidate of sorted_matches) {
      let text: string;
      try {
        text = readTextReplace(candidate);
      } catch {
        continue;
      }
      if (self._is_valid_compact(text)) {
        return text;
      }
      _LOG.debug(
        "skill_cache.get_compact_any_session: skipping corrupted/empty compact %s",
        path.basename(candidate),
      );
    }
    return null;
  } catch (exc) {
    if (isOSError(exc)) {
      _LOG.debug(
        "skill_cache.get_compact_any_session: I/O error for %s: %s",
        skill_name,
        exc,
      );
      return null;
    }
    throw exc;
  }
}

/**
 * Return the mtime (POSIX seconds) of the stored compact file, or `null`.
 *
 * Used by `token-goat skill-list` to display how old a compact is (separate
 * from body age). Returns `null` when no compact exists for this (session,
 * skill) pair, or on any I/O error (fail-soft).
 *
 * The returned value is the raw `pathlib.Path.stat().st_mtime` float, so
 * callers compute age as `time.time() - get_compact_mtime(...)` when the
 * return value is not `null`.
 */
export function get_compact_mtime(
  session_id: string,
  skill_name: string,
): number | null {
  if (!session_id) {
    return null;
  }
  const name = _safe_skill_name(skill_name);
  if (name === null) {
    return null;
  }
  try {
    const file_id = _compact_file_id(session_id, name);
    const out_path = path.join(_skill_outputs_dir(), file_id);
    if (!fs.existsSync(out_path)) {
      return null;
    }
    return fs.statSync(out_path).mtimeMs / 1000;
  } catch (exc) {
    if (isOSError(exc) || exc instanceof TypeError) {
      _LOG.debug(
        "skill_cache.get_compact_mtime: I/O error for %s: %s",
        skill_name,
        exc,
      );
      return null;
    }
    throw exc;
  }
}

/**
 * Return metadata for all cached skills, optionally filtered by session_id.
 *
 * For each skill, return a dict with keys:
 * - name (str): the skill name
 * - body_len (int): body size in bytes
 * - compact_len (int): compact size in bytes (0 if not cached)
 * - has_marker (bool): True if COMPACT_END_MARKER is present
 *
 * When *session_id* is provided, only skills from that session are returned.
 * When *session_id* is None, all cached skills across all sessions are returned.
 *
 * Used by `token-goat skill-size` to report per-skill token overhead. Returns
 * an empty list when no skills are cached.
 */
export function get_all_cached_skills(
  session_id: string | null = null,
): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];

  let session_metas: SkillMeta[];
  if (session_id !== null) {
    // Filter by session
    session_metas = self.list_by_session(session_id);
  } else {
    // All skills across all sessions (newest version per skill name)
    const all_outputs = self.list_outputs();
    const seen = new Map<string, string>(); // skill_name -> output_id (newest)
    for (const entry of all_outputs) {
      const oid = entry.output_id;
      if (!oid || oid.endsWith("-compact")) {
        continue;
      }
      const meta = self.read_sidecar(oid);
      if (meta !== null && !seen.has(meta.skill_name)) {
        seen.set(meta.skill_name, oid);
      }
    }
    session_metas = [];
    for (const [skill_name, oid] of seen) {
      session_metas.push(new SkillMeta(oid, skill_name, "", 0, 0.0, false));
    }
  }

  for (const meta of session_metas) {
    // Load the full body to calculate metrics.
    const body = self.load_output(meta.output_id);
    if (body === null) {
      continue;
    }

    // Try to load the compact form if it exists.
    let compact_text: string | null = null;
    if (session_id !== null) {
      compact_text = self.get_compact(session_id, meta.skill_name);
    } else {
      // When no session specified, try to find any compact version
      for (const entry of self.list_outputs()) {
        const oid = entry.output_id ?? "";
        if (oid.endsWith("-compact")) {
          // Compact file: {session}-{safe_name}-compact
          const file_id = oid.slice(0, -8); // strip "-compact"
          // Check if this compact matches our skill
          const meta_check = self.read_sidecar(file_id);
          if (meta_check && meta_check.skill_name === meta.skill_name) {
            compact_text = self.load_output(oid);
            break;
          }
        }
      }
    }

    const compact_len = compact_text ? utf8Len(compact_text) : 0;

    // Compute compact_chars: character count of the compact *body* (header
    // stripped) so callers can derive token counts with the same
    // `len(body) // 4` formula used in store_compact — avoiding the
    // double-count from the header line and the byte-vs-char discrepancy for
    // non-ASCII content. See _strip_compact_header for the stripping logic.
    let compact_chars: number;
    if (compact_text) {
      const compact_body_text = _strip_compact_header(compact_text);
      compact_chars = cpLen(compact_body_text);
    } else {
      compact_chars = 0;
    }

    // Check for marker.
    const has_marker = self.extract_compact_from_marker(body) !== null;

    results.push({
      name: meta.skill_name,
      body_len: utf8Len(body),
      body_chars: cpLen(body),
      compact_len: compact_len,
      compact_chars: compact_chars,
      has_marker: has_marker,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// fs/path helpers (Path.* equivalents)
// ---------------------------------------------------------------------------

/** Python `Path.is_dir()`. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Python `Path.is_file()`. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Python `Path(name).suffix` for a basename or full path. */
function pathSuffix(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf(".");
  // A leading dot (dotfile) is not a suffix; Python: ".bashrc".suffix == "".
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot);
}

/** Python `Path(fp).with_suffix(suffix)`. */
function withSuffix(fp: string, suffix: string): string {
  const cur = pathSuffix(fp);
  if (cur) {
    return fp.slice(0, fp.length - cur.length) + suffix;
  }
  return fp + suffix;
}

/** Python `Path.read_text(encoding="utf-8", errors="replace")`. */
function readTextReplace(p: string): string {
  // Node decodes invalid UTF-8 to U+FFFD by default, matching errors="replace".
  return fs.readFileSync(p, "utf8");
}

/** `Path.stat().st_mtime` in POSIX seconds; raises like Python on missing file. */
function statMtime(p: string): number {
  return fs.statSync(p).mtimeMs / 1000;
}

// ---------------------------------------------------------------------------
// __all__ parity (export list mirrors the Python module's __all__).
// All public names + over-exported internals (regexes, constants, helpers a
// test may import or spy on) are exported above via `export function/const/
// class`. This list documents the intended public surface.
// ---------------------------------------------------------------------------
export const __all__ = [
  "COMPACT_END_MARKER",
  "DEFAULT_MAX_TOTAL_BYTES",
  "MAX_COMPACT_FILE_COUNT",
  "SIDECAR_SCHEMA_VERSION",
  "OUTPUT_FILENAME_RE",
  "SkillMeta",
  "_skill_outputs_dir",
  "content_hash",
  "evict_old_entries",
  "find_cross_session_entry",
  "invalidate_for_path",
  "extract_checklist_section",
  "extract_compact_from_marker",
  "extract_all_headings",
  "extract_h2_headings",
  "extract_named_section",
  "_parse_section_ordinal",
  "extract_compact_source_sha",
  "generate_compact_summary",
  "get_all_cached_skills",
  "get_compact",
  "get_compact_any_session",
  "get_compact_mtime",
  "_get_skills_dir_listing",
  "_DIR_LISTING_CACHE_TTL_SECS",
  "_is_valid_compact",
  "_MIN_COMPACT_CONTENT_CHARS",
  "get_skill_file_path",
  "list_by_session",
  "list_outputs",
  "load_output",
  "load_output_meta",
  "lookup_all_by_name",
  "lookup_by_name",
  "output_id_for",
  "read_sidecar",
  "sidecar_meta_path",
  "score_compact",
  "store_compact",
  "store_output",
  "write_sidecar",
] as const;
