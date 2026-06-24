/**
 * bash_compress CLI UTILS (PART A) FILTERS — TypeScript port of the DiffFilter,
 * LsFilter, EzaFilter, FdFilter, WcFilter, and TreeFilter Filter subclasses from
 * src/token_goat/bash_compress.py (plus the module-level ls / diff / tree / fd
 * regexes and the diff helper functions _split_into_hunks / _score_and_cap_hunks
 * and the ls helper functions _ls_ext_from_line / _ls_ext_summary).
 *
 * Six filters subclass the concrete Filter base from ./framework.js:
 *   - DiffFilter — `diff` / `diff3` / `sdiff` / `colordiff` / `wdiff`. Plain
 *                  POSIX diff (NOT git diff — that is GitFilter). Small diffs
 *                  (<=50 lines) pass through; unified diffs cap hunks per file
 *                  then stat-collapse at >20 files; normal diffs dedupe+truncate.
 *   - LsFilter   — `ls` / `eza` / `ll` / `dir`. <=25 lines pass through; longer
 *                  listings keep first 10 entries per section + a by-type
 *                  extension summary marker. Multi-dir sections compressed
 *                  independently.
 *   - EzaFilter  — `eza` / `exa` / `ls`. Overrides matches() (stem-based).
 *                  <=30 non-empty lines pass through; --tree mode keeps head 40
 *                  + tail 10; flat listing keeps header + head 25 + tail 5.
 *   - FdFilter   — `fd` / `fdfind` / `find`. Overrides matches() (stem-based).
 *                  <=40 non-empty lines pass through; else head 35 + tail 5.
 *   - WcFilter   — `wc`. Does not truncate — only strips leading whitespace
 *                  padding POSIX wc emits for column alignment.
 *   - TreeFilter — `tree`. <=30 lines or non-tree output pass through; deeper
 *                  trees collapse depth>=2 items per depth-1 parent into a
 *                  `[N items]` marker; preserves the trailing summary line.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress, _compress_tree, _compress_flat_listing,
 *    _split_and_compress, _compress_one_section, _is_section_header,
 *    _compress_unified, _tree_depth_and_prefix, detect); snake_case module-private
 *    helpers (_split_into_hunks, _score_and_cap_hunks, _ls_ext_from_line,
 *    _ls_ext_summary) and module-private constants (_DIFF_FILE_HEADER_RE,
 *    _DIFF_HUNK_RE, _DIFF_CONTEXT_RE, _DIFF_MAX_HUNKS_PER_FILE,
 *    _DIFF_MAX_FULL_FILES, _LS_PASSTHROUGH, _LS_MAX_ENTRIES, _LS_HIDDEN_MARKER,
 *    _LS_HIDDEN_MARKER_EXT, _TREE_PASSTHROUGH, _FD_COMPRESS_THRESHOLD).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored -> _reMatch (non-global
 *    clone + index===0). .search() -> _reSearch. _nonGlobal/_reMatch/_reSearch
 *    are framework-module-PRIVATE (NOT exported), so they are re-declared here
 *    MODULE-PRIVATE (same source as framework lines 629/917/912) — NOT exported,
 *    to avoid a duplicate-export TS2308 across the barrel export * chain.
 *  - _is_diff_add / _is_diff_remove / split_blocks / dedupe_numeric_runs /
 *    truncate_middle / _head_tail_compress / normalise are framework-PUBLIC and
 *    imported. _combine_output is an INSTANCE method; _finalize / _emit_notes are
 *    STATIC methods on Filter.
 *  - DiffFilter._compress_unified reads config via `config.load().bash_diff`
 *    (mirroring git_diff.ts): hunk_density_cap truthy -> max_hunks_per_file
 *    (defaulting back to 0 when undefined), else 0 (cap disabled). The
 *    ConfigSchema types bash_diff as optional, so `?? {}` guards the chaining.
 *  - Python str.splitlines() splits on \n, \r\n, \r AND bare \v\f\x1c-\x1fU+2028U+2029.
 *    The framework's normalise() already converts \r\n -> \n and strips ANSI
 *    control chars before these filters see the text, but the LsFilter / WcFilter
 *    / TreeFilter compress() methods call .splitlines() on raw merged output
 *    (NOT normalise). To preserve Python's bare-CR handling we route those
 *    through a local _splitlines shim that emulates str.splitlines() (splits on
 *    \r, \r\n, \n, \v, \f, \x1c, \x1d, \x1e, \x85, U+2028, U+2029). DiffFilter /
 *    EzaFilter / FdFilter call .split("\n") in Python (they normalise() first),
 *    so they use the plain JS .split("\n") here too.
 *  - Python _ls_ext_from_line uses str.rfind(".") and treats leading-dot files
 *    (dot_idx <= 0) as no-extension. fname.rstrip("/") strips trailing slashes.
 *  - Python collections.Counter.most_common(n) -> Map sorted by count desc then
 *    insertion order; emulated with a Map (insertion-ordered) sorted by count
 *    desc with a stable tiebreak on insertion index (Python sorts equal counts by
 *    first-seen, which the index-stable sort reproduces).
 *  - Python _ls_ext_summary uses the multiplication sign U+00D7 (×) — preserved
 *    literally (NOT U+2028/2029; safe inside a string literal).
 *  - Python str.format(n=..., ext_summary=...) -> string interpolation. The
 *    _LS_HIDDEN_MARKER / _LS_HIDDEN_MARKER_EXT templates carry literal {n} /
 *    {ext_summary} placeholders and are rendered by a local _fmt helper.
 *  - Python Path(argv[0]).stem.lower() -> _pathStemLower (final component, last
 *    suffix stripped, lowercased). Used by EzaFilter / FdFilter overrides.
 *  - Python str.lstrip() (WcFilter) -> .replace(/^\s+/u, ""). str.rstrip() ->
 *    .replace(/\s+$/u, ""). str.strip() -> combine both.
 *  - TreeFilter.detect(lines) is an INSTANCE method in Python (not static);
 *    preserved as override detect(). _tree_depth_and_prefix is a STATIC method.
 *  - Python list.pop() on the last summary line (TreeFilter) -> Array pop on the
 *    (cloned) body array.
 *  - Module-global mutable state: NONE. Every counter/list/Map is local inside
 *    compress()/helpers; no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - diff   : binaries {diff, diff3, sdiff, colordiff, wdiff}; default
 *             binaries-based matches() (no override).
 *  - ls     : binaries {ls, eza, ll, dir}; default binaries-based matches().
 *  - eza    : binaries {eza, exa, ls}; OVERRIDDEN matches() — stem-based
 *             (Path(argv[0]).stem.lower() in self.binaries).
 *  - fd     : binaries {fd, fdfind, find}; OVERRIDDEN matches() — stem-based.
 *  - wc     : binaries {wc}; default binaries-based matches().
 *  - tree   : binaries {tree}; default binaries-based matches(). compress()
 *             additionally requires detect(lines) (box-drawing connectors) before
 *             applying tree compression — non-tree output passes through.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js) and config is UP one level (../).
 * verbatimModuleSyntax is on -> nothing imported here is type-only.
 * noImplicitOverride is on -> every overridden member carries `override`.
 */

import {
  Filter,
  _head_tail_compress,
  _is_diff_add,
  _is_diff_remove,
  dedupe_numeric_runs,
  normalise,
  split_blocks,
  truncate_middle,
} from "./framework.js";
import * as config from "../config.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(line) — anchored at the START (NOT end-anchored). JS
 * has no anchored-match primitive; emulate via a non-global clone and an
 * index===0 check.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/** Python re.search(...) — boolean "matches anywhere". */
function _reSearch(re: RegExp, text: string): boolean {
  return _nonGlobal(re).test(text);
}

/**
 * Python str.splitlines() — splits on \r, \r\n, \n, \v (\x0b), \f (\x0c),
 * \x1c, \x1d, \x1e, \x85, U+2028, U+2029. Does NOT include the line terminator
 * in the result and does NOT emit a trailing empty string for a final terminator
 * (matching CPython str.splitlines behaviour).
 */
function _splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const out: string[] = [];
  let cur = "";
  const n = s.length;
  for (let i = 0; i < n; i += 1) {
    const ch = s[i]!;
    const cc = s.charCodeAt(i);
    if (ch === "\n") {
      out.push(cur);
      cur = "";
    } else if (ch === "\r") {
      out.push(cur);
      cur = "";
      // Skip a paired \n (CRLF) so it does not produce an empty element.
      if (i + 1 < n && s[i + 1] === "\n") {
        i += 1;
      }
    } else if (
      cc === 0x0b || // \v
      cc === 0x0c || // \f
      cc === 0x1c ||
      cc === 0x1d ||
      cc === 0x1e ||
      cc === 0x85 || // NEL (U+0085)
      cc === 0x2028 || // LINE SEPARATOR
      cc === 0x2029 // PARAGRAPH SEPARATOR
    ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  // Python str.splitlines() does not append a trailing empty string when the
  // input ends with a terminator (it just drops it). When the input ends with
  // a non-terminator char, the accumulated `cur` is the final element.
  if (cur !== "" || out.length === 0) {
    // Mirror CPython: only push the trailing segment when it is non-empty OR
    // the entire input was a single unterminated line.
    if (cur !== "") {
      out.push(cur);
    }
  }
  return out;
}

/**
 * pathlib.Path(s).stem.lower() — lowercased final path component with its LAST
 * suffix removed. Matches framework._pathStem semantics (a leading-dot dotfile
 * keeps its name; a trailing dot is not a suffix).
 */
function _pathStemLower(s: string): string {
  const norm = s.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const dot = name.lastIndexOf(".");
  let stem: string;
  if (dot <= 0 || dot === name.length - 1) {
    stem = name;
  } else {
    stem = name.slice(0, dot);
  }
  return stem.toLowerCase();
}

/** Python str.rstrip() — strip trailing ASCII+Unicode whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python str.lstrip() — strip leading ASCII+Unicode whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/u, "");
}

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/**
 * Render a Python str.format-style template with {name} placeholders.
 * Only the keys present in `vals` are substituted; unknown {keys} are left
 * intact (Python would raise KeyError, but the two templates used here always
 * supply every placeholder they reference).
 */
function _fmt(tpl: string, vals: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, key: string) => {
    return key in vals ? String(vals[key]) : `{${key}}`;
  });
}

// ===========================================================================
// diff regexes + constants (Python ~13910-13927).
// ===========================================================================

/**
 * A diff file start marker: `diff …` or `--- a/foo`. The `+++ b/foo` line is
 * NOT included here because it always follows immediately after `---` and
 * belongs to the same file block. Including `+++` would split each file into
 * two blocks and inflate the file count.
 *
 * Python: re.compile(r"^(?:diff\s|---\s)")
 */
const _DIFF_FILE_HEADER_RE: RegExp = /^(?:diff\s|---\s)/;
/** Unified diff hunk header: `@@ -N,N +N,N @@ ...`. Python: re.compile(r"^@@ ") */
const _DIFF_HUNK_RE: RegExp = /^@@ /;
/** Lines that are pure context (no change): space-prefixed. Python: re.compile(r"^ ") */
const _DIFF_CONTEXT_RE: RegExp = /^ /;

/** Maximum hunks to keep per file in a plain diff. Python: _DIFF_MAX_HUNKS_PER_FILE = 3 */
const _DIFF_MAX_HUNKS_PER_FILE = 3;
/** Maximum total files to show in full before switching to stat-only view. Python: _DIFF_MAX_FULL_FILES = 20 */
const _DIFF_MAX_FULL_FILES = 20;

// ===========================================================================
// DiffFilter (Python ~13930-14017) + helpers _split_into_hunks / _score_and_cap_hunks
// ===========================================================================

/**
 * Compress `diff` / `diff -u` / `diff -r` output (plain POSIX diff).
 *
 * Small diffs (<=50 lines) pass through unchanged. Unified diffs (detected by
 * `@@ ` hunk headers in the first 20 lines) cap hunks per file
 * (_DIFF_MAX_HUNKS_PER_FILE=3), stat-collapse at >_DIFF_MAX_FULL_FILES files
 * (20), and apply a density-based hunk cap from config. Normal diffs (`<` / `>`
 * markers) dedupe numerically (min_run=5) then truncate the middle (300 lines).
 *
 * Note: `git diff` is handled by GitFilter (richer hunk awareness). DiffFilter
 * handles plain POSIX diff output which lacks the `diff --git` header.
 */
export class DiffFilter extends Filter {
  override name = "diff";
  override binaries: ReadonlySet<string> = new Set([
    "diff",
    "diff3",
    "sdiff",
    "colordiff",
    "wdiff",
  ]);

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const text = this._combine_output(stdout, stderr);
    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => ln !== "");

    // Small diff: pass through.
    if (non_empty.length <= 50) {
      return text;
    }

    // Detect unified diff (has hunk headers) vs. normal diff (< / > markers).
    const has_unified = lines.slice(0, 20).some((ln) => _reMatch(_DIFF_HUNK_RE, ln));
    if (has_unified) {
      return this._compress_unified(lines);
    }
    // Normal diff: dedupe numerically and truncate middle.
    const deduped = dedupe_numeric_runs(lines, { min_run: 5 });
    return _splitlinesHack(truncate_middle(deduped, 300)).join("\n");
  }

  /** Compress a unified diff by capping hunks per file. */
  _compress_unified(lines: string[]): string {
    // split_blocks operates on a string; join the lines first.
    const text = lines.join("\n");
    // Split into per-file blocks (each block starts at a file-header line).
    const file_blocks_str = split_blocks(text, _DIFF_FILE_HEADER_RE);
    const real_files = file_blocks_str.filter((b) =>
      _reMatch(_DIFF_FILE_HEADER_RE, b.split("\n", 1)[0]!),
    );

    if (real_files.length > _DIFF_MAX_FULL_FILES) {
      // Stat-only view for very wide diffs.
      const stat_lines: string[] = [
        `[token-goat: large diff (${real_files.length} files); stat-only view]`,
      ];
      for (const block_str of real_files) {
        const block_lines = block_str.split("\n");
        const header = block_lines[0]!;
        const adds = block_lines.filter((ln) => _is_diff_add(ln)).length;
        const dels = block_lines.filter((ln) => _is_diff_remove(ln)).length;
        stat_lines.push(`${header}  +${adds} -${dels}`);
      }
      return stat_lines.join("\n");
    }

    const out_parts: string[] = [];
    for (const block_str of file_blocks_str) {
      const block_lines = block_str.split("\n");
      const first_line = block_lines.length > 0 ? block_lines[0]! : "";
      if (!first_line || !_reMatch(_DIFF_FILE_HEADER_RE, first_line)) {
        out_parts.push(block_str);
        continue;
      }
      // Apply density cap first, then positional cap.
      // config.load() always populates bash_diff (Python reads
      // _cfg.bash_diff.* directly); the optional chaining here keeps TS strict
      // happy against the ConfigSchema's `bash_diff?` typing while reproducing
      // Python's gate: hunk_density_cap truthy -> use max_hunks_per_file, else
      // 0 (cap disabled).
      const _cfg = config.load();
      const _bash_diff = _cfg.bash_diff ?? {};
      const _max_hunks = _bash_diff.hunk_density_cap
        ? (_bash_diff.max_hunks_per_file ?? 0)
        : 0;
      const capped = _score_and_cap_hunks(block_lines, _max_hunks);
      // Split this file's block into hunks.
      const hunk_blocks = _split_into_hunks(capped);
      if (hunk_blocks.length <= _DIFF_MAX_HUNKS_PER_FILE + 1) {
        out_parts.push(capped.join("\n"));
        continue;
      }
      const head = hunk_blocks.slice(0, _DIFF_MAX_HUNKS_PER_FILE + 1);
      const elided = hunk_blocks.length - _DIFF_MAX_HUNKS_PER_FILE - 1;
      const flat: string[] = [];
      for (const chunk of head) {
        flat.push(...chunk);
      }
      flat.push(`[token-goat: +${elided} more hunks in this file elided]`);
      out_parts.push(flat.join("\n"));
    }
    return out_parts.join("\n");
  }
}

/**
 * Split a per-file diff block into sub-lists at `@@ …` hunk boundaries.
 *
 * The first sub-list is the file header (before the first `@@` line);
 * subsequent sub-lists each start with an `@@` line. Mirrors the hunk-splitting
 * logic in git_diff but operates on a `string[]` rather than a single string.
 */
function _split_into_hunks(block: string[]): string[][] {
  const hunks: string[][] = [];
  let current: string[] = [];
  for (const line of block) {
    if (_reMatch(_DIFF_HUNK_RE, line) && current.length > 0) {
      hunks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    hunks.push(current);
  }
  return hunks;
}

/**
 * Keep top `max_hunks` hunks by change density; replace dropped ones with a
 * sentinel.
 *
 * Density = (added_lines + deleted_lines) / total_content_lines, where content
 * lines exclude the @@ header. 0.0 = pure context; 1.0 = every line changed.
 * Hunks scoring lower than the Nth-highest are dropped and summarised in a
 * single sentinel line so the model sees the high-signal hunks without
 * whitespace/formatting noise.
 *
 * When `max_hunks` is 0, returns `hunk_lines` unchanged (cap disabled). When
 * the file has <= `max_hunks` hunks, returns `hunk_lines` unchanged.
 */
function _score_and_cap_hunks(hunk_lines: string[], max_hunks: number): string[] {
  if (max_hunks <= 0) {
    return [...hunk_lines];
  }
  const hunks = _split_into_hunks(hunk_lines);
  // hunks[0] is the file header block (--- / +++ lines before first @@)
  const actual = hunks.slice(1);
  if (actual.length <= max_hunks) {
    return [...hunk_lines];
  }

  const _density = (h: string[]): number => {
    // Skip the @@ header line (index 0) for the ratio; it is not content.
    const content = h.length > 0 ? h.slice(1) : [];
    const total = content.length;
    if (total === 0) {
      return 0.0;
    }
    let changed = 0;
    for (const ln of content) {
      if (ln.startsWith("+") || ln.startsWith("-")) {
        changed += 1;
      }
    }
    return changed / total;
  };

  // scored: (original-index-in-actual, density). Preserve insertion order so
  // the density sort is stable on ties (Python sorts tuples by index second).
  const scored: Array<[number, number]> = actual.map((h, i) => [i, _density(h)]);
  // Keep the top `max_hunks` by density (desc). Stable on equal densities by
  // relying on the input index order (Array.prototype.sort is stable in ES2019+).
  const keep_set = new Set<number>(
    [...scored]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max_hunks)
      .map((x) => x[0]),
  );
  const dropped_densities = scored.filter((x) => !keep_set.has(x[0])).map((x) => x[1]);
  const avg =
    dropped_densities.length > 0
      ? dropped_densities.reduce((acc, d) => acc + d, 0) / dropped_densities.length
      : 0.0;

  const out: string[] = [...hunks[0]!];
  for (let i = 0; i < actual.length; i += 1) {
    if (keep_set.has(i)) {
      out.push(...actual[i]!);
    }
  }
  const n_dropped = dropped_densities.length;
  out.push(
    `[... ${n_dropped} more hunks, avg density ${avg.toFixed(2)} — likely whitespace/formatting]`,
  );
  return out;
}

// NOTE: _DIFF_CONTEXT_RE is referenced by the Python module (for documentation
// of the space-prefixed context check) but is NOT used directly by DiffFilter's
// compress path — it is retained here verbatim for source parity. Keeping it
// module-private (no export) avoids the barrel TS2308 duplicate-export hazard.

/**
 * No-op passthrough shim named to make the one call site read clearly: Python
 * calls `"\n".join(truncate_middle(deduped, 300))` where truncate_middle
 * already returns a `list[str]`. The TS framework truncate_middle likewise
 * returns a `string[]`, so this just returns the array unchanged. (Present so
 * the compress() body mirrors the Python line shape one-for-one.)
 */
function _splitlinesHack(lines: string[]): string[] {
  return lines;
}

// ===========================================================================
// ls constants + helpers (Python ~11496-11547).
// ===========================================================================

/** Pass-through threshold: listings no longer than this are returned unchanged. */
const _LS_PASSTHROUGH = 25;
/** Maximum file/dir entry lines to keep per section before the summary marker. */
const _LS_MAX_ENTRIES = 10;
/** Marker emitted when entries are hidden (no extension summary available). */
const _LS_HIDDEN_MARKER =
  "[token-goat: {n} more entries — use eza --tree or ls | grep PATTERN to filter]";
/** Marker emitted when entries are hidden with an extension summary appended. */
const _LS_HIDDEN_MARKER_EXT = "[token-goat: {n} more entries — by type: {ext_summary}]";

/**
 * Extract the lowercase extension from a directory-listing entry line.
 * Returns null for directories (skipped), "" for files with no extension.
 */
function _ls_ext_from_line(line: string): string | null {
  const stripped = _rstrip(line);
  if (stripped.endsWith("/")) {
    return null;
  }
  const parts = stripped.split(/\s+/u).filter((p) => p !== "");
  if (parts.length === 0) {
    return null;
  }
  // Long-format ls -la: first field is permissions; leading 'd' means directory.
  const first = parts[0]!;
  if (first.length > 0 && first[0] === "d") {
    return null;
  }
  const fname = _rstrip(parts[parts.length - 1]!).replace(/\/+$/u, "");
  const dot_idx = fname.lastIndexOf(".");
  // dot_idx <= 0 covers both "no dot" and leading-dot-only (.gitignore) cases.
  if (dot_idx <= 0) {
    return "";
  }
  return fname.slice(dot_idx).toLowerCase();
}

/**
 * Build a "by type" extension summary from a list of ls entry lines.
 * Returns a string like ".py×18 .js×12 .ts×8 other×9", or "" when there is no
 * data. Mirrors Python collections.Counter.most_common(top_n) — top_n defaults
 * to 4. Equal counts break ties by first-seen insertion order (Python's
 * Counter.most_common is insertion-ordered for ties).
 */
function _ls_ext_summary(entries: string[], top_n = 4): string {
  const ext_counts = new Map<string, number>();
  const order: string[] = []; // insertion order for stable tiebreak
  let other_count = 0;
  for (const ln of entries) {
    const ext = _ls_ext_from_line(ln);
    if (ext === null) {
      continue;
    }
    if (ext === "") {
      other_count += 1;
    } else {
      const prev = ext_counts.get(ext) ?? 0;
      if (prev === 0) {
        order.push(ext);
      }
      ext_counts.set(ext, prev + 1);
    }
  }
  // most_common(top_n): sort by count desc, stable on insertion order.
  const sorted = order
    .map((ext) => [ext, ext_counts.get(ext)!] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, top_n);
  const parts: string[] = top.map(([ext, cnt]) => `${ext}×${cnt}`);
  const top_total = top.reduce((acc, [, c]) => acc + c, 0);
  const all_total = sorted.reduce((acc, [, c]) => acc + c, 0);
  const remaining = all_total - top_total + other_count;
  if (remaining > 0) {
    parts.push(`other×${remaining}`);
  }
  return parts.join(" ");
}

// ===========================================================================
// LsFilter (Python ~11550-11633)
// ===========================================================================

/**
 * Compress `ls` / `eza` / `ll` / `dir` directory listing output.
 *
 * Pass-through when total output is <=25 lines — small listings are fully
 * readable. Truncate for longer output: keep `total N` disk-usage header when
 * present, keep the first 10 entry lines, then append a count marker (with a
 * by-type extension summary when available) for hidden entries. Multi-section
 * output (`ls dir1 dir2` introduces each target with a `dirname:` header line)
 * keeps every header and compresses entries independently per section.
 *
 * Deliberately avoids parsing permission bits, timestamps, or owner fields —
 * only line count matters.
 */
export class LsFilter extends Filter {
  override name = "ls";
  override binaries: ReadonlySet<string> = new Set(["ls", "eza", "ll", "dir"]);

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = _splitlines(merged);
    if (lines.length <= _LS_PASSTHROUGH) {
      return merged;
    }
    return this._split_and_compress(lines);
  }

  /** True when `line` looks like a multi-dir ls section header (e.g. `./dir:`). */
  static _is_section_header(line: string): boolean {
    const stripped = _rstrip(line);
    if (stripped === "" || !stripped.endsWith(":")) {
      return false;
    }
    // Permission lines start with - d l c b p s (file type chars).
    if ("-dlcbps".includes(stripped[0]!)) {
      return false;
    }
    // Section headers are single tokens (no internal spaces except at start).
    const token = stripped.slice(0, -1); // strip trailing colon
    return !token.trim().includes(" ");
  }

  /** Compress one ls section; expects blank lines already removed. */
  static _compress_one_section(lines: string[]): string[] {
    const out: string[] = [];
    let entries: string[];
    if (lines.length > 0 && _lstrip(lines[0]!).startsWith("total ")) {
      out.push(lines[0]!);
      entries = lines.slice(1);
    } else {
      entries = lines;
    }
    if (entries.length <= _LS_MAX_ENTRIES) {
      out.push(...entries);
      return out;
    }
    out.push(...entries.slice(0, _LS_MAX_ENTRIES));
    const hidden = entries.length - _LS_MAX_ENTRIES;
    const ext_part = _ls_ext_summary(entries);
    if (ext_part !== "") {
      out.push(_fmt(_LS_HIDDEN_MARKER_EXT, { n: hidden, ext_summary: ext_part }));
    } else {
      out.push(_fmt(_LS_HIDDEN_MARKER, { n: hidden }));
    }
    return out;
  }

  /** Split at section headers and compress each section independently. */
  _split_and_compress(lines: string[]): string {
    // sections: list of [header-or-null, body-lines]
    const sections: Array<[string | null, string[]]> = [];
    let cur_header: string | null = null;
    let cur_lines: string[] = [];
    for (const ln of lines) {
      if (LsFilter._is_section_header(ln)) {
        sections.push([cur_header, cur_lines]);
        cur_header = ln;
        cur_lines = [];
      } else {
        cur_lines.push(ln);
      }
    }
    sections.push([cur_header, cur_lines]);

    const out: string[] = [];
    for (const [header, sec] of sections) {
      if (header !== null) {
        out.push(header);
      }
      const non_blank = sec.filter((ln) => _strip(ln) !== "");
      if (non_blank.length === 0) {
        continue;
      }
      out.push(...LsFilter._compress_one_section(non_blank));
    }
    return out.join("\n");
  }
}

// ===========================================================================
// EzaFilter (Python ~11636-11728)
// ===========================================================================

/**
 * Compress `eza` / `exa` / `ls` directory listing output.
 *
 * Pass-through when output is short (<=30 non-empty lines). `--tree` mode keeps
 * the first 40 + last 10 lines with a marker when total >60. Flat listing keeps
 * the header, first 25 entries, last 5 entries with a summary when total >30.
 * Summary lines (`3 directories, 14 files`) are preserved.
 */
export class EzaFilter extends Filter {
  override name = "eza";
  override binaries: ReadonlySet<string> = new Set(["eza", "exa", "ls"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return this.binaries.has(stem);
  }

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    argv: string[],
  ): string {
    // Combine and normalise output.
    const merged = this._combine_output(stdout, stderr);
    const text = normalise(merged);

    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => _strip(ln) !== "");

    // Pass through small outputs unchanged.
    if (non_empty.length <= 30) {
      return text;
    }

    // Detect tree mode by checking for --tree flag in argv.
    const is_tree = argv.some(
      (arg) => arg === "--tree" || arg.startsWith("--tree="),
    );

    if (is_tree) {
      return this._compress_tree(lines, non_empty);
    }
    return this._compress_flat_listing(lines, non_empty, argv);
  }

  /** Compress tree output: keep first 40 + last 10 + marker. */
  _compress_tree(lines: string[], non_empty: string[]): string {
    if (non_empty.length <= 60) {
      return _rstrip(lines.join("\n"));
    }
    return _rstrip(_head_tail_compress(non_empty, 40, 10, "items"));
  }

  /** Compress flat listing: keep header, first 25 items, last 5. */
  _compress_flat_listing(
    _lines: string[],
    non_empty: string[],
    _argv: string[],
  ): string {
    if (non_empty.length <= 30) {
      return _rstrip(_lines.join("\n"));
    }

    // Identify header line (column names like "permissions size date").
    let header_idx = 0;
    if (
      non_empty.length > 0 &&
      ["permission", "size", "date", "user", "name"].some((kw) =>
        non_empty[0]!.toLowerCase().includes(kw),
      )
    ) {
      header_idx = 1;
    }

    const kept: string[] = [];

    // Add header lines.
    if (header_idx > 0) {
      kept.push(...non_empty.slice(0, header_idx));
    }

    // Compress data lines using the helper.
    const data_lines = non_empty.slice(header_idx);
    if (data_lines.length > 30) {
      const data_compressed = _head_tail_compress(data_lines, 25, 5, "entries");
      kept.push(...data_compressed.split("\n"));
    } else {
      kept.push(...data_lines);
    }

    // Preserve summary lines (e.g., "3 directories, 14 files") if present.
    const tail_start = Math.max(0, non_empty.length - 3);
    const summary_lines = non_empty
      .slice(tail_start)
      .filter((ln) => ["director", "file", "total"].some((kw) => ln.includes(kw)));
    if (summary_lines.length > 0 && !kept.includes(summary_lines[0]!)) {
      kept.push(...summary_lines);
    }

    return _rstrip(kept.join("\n"));
  }
}

// ===========================================================================
// tree (Python ~11731-11809)
// ===========================================================================

/** Pass-through threshold: tree outputs with this many lines or fewer are returned unchanged. */
const _TREE_PASSTHROUGH = 30;

/**
 * Compress `tree` directory tree output for deeply nested structures.
 *
 * Trees with <=30 lines pass through unchanged. Deeper trees collapse items at
 * depth >=2 (two or more indent groups) into a single `[N items]` marker per
 * depth-1 parent directory. The trailing `N directories, M files` summary line
 * is always preserved.
 */
export class TreeFilter extends Filter {
  override name = "tree";
  override binaries: ReadonlySet<string> = new Set(["tree"]);

  /** Return true when `lines` look like `tree` command output. */
  detect(lines: string[]): boolean {
    const head = lines.slice(0, 10);
    return head.some((ln) => ln.includes("├──") || ln.includes("└──"));
  }

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = _splitlines(merged);
    if (lines.length <= _TREE_PASSTHROUGH) {
      return merged;
    }
    if (!this.detect(lines)) {
      return merged;
    }
    return this._compress_tree(lines);
  }

  /**
   * Return (depth, prefix) for a tree connector line, or (-1, "") for
   * non-entries. Depth is 0-indexed: 0 = first level under root, 1 = second
   * level, etc.
   */
  static _tree_depth_and_prefix(line: string): [number, string] {
    for (const connector of ["├── ", "└── "]) {
      const idx = line.indexOf(connector);
      if (idx >= 0) {
        // Python uses idx // 4 (the connectors are 4 chars wide: 3 box chars
        // + space, or a 4-space indent group for deeper levels).
        return [Math.floor(idx / 4), line.slice(0, idx)];
      }
    }
    return [-1, ""];
  }

  /** Collapse depth>=2 items per depth-1 parent into a '[N items]' marker. */
  _compress_tree(lines: string[]): string {
    const body = [...lines];
    let summary = "";
    if (body.length > 0 && _reMatch(/^\d+ director/, body[body.length - 1]!.trim())) {
      summary = body.pop()!;
    }

    const out: string[] = [];
    let pending_count = 0;
    let pending_prefix = "";

    const flush = (): void => {
      if (pending_count) {
        out.push(`${pending_prefix}└── [${pending_count} items]`);
        pending_count = 0;
        pending_prefix = "";
      }
    };

    for (const line of body) {
      const [depth, prefix] = TreeFilter._tree_depth_and_prefix(line);
      if (depth < 0) {
        // Non-connector line (root '.', blank lines, etc.)
        flush();
        out.push(line);
      } else if (depth <= 1) {
        // Depth <=2: keep verbatim.
        flush();
        out.push(line);
      } else {
        // Depth >=3: collect under nearest depth-1 parent.
        if (pending_prefix === "") {
          pending_prefix = prefix;
        }
        pending_count += 1;
      }
    }
    flush();
    if (summary !== "") {
      out.push(summary);
    }
    return out.join("\n");
  }
}

// ===========================================================================
// fd / fdfind (Python ~11812-11852)
// ===========================================================================

/** Threshold: outputs with more lines than this are compressed. */
const _FD_COMPRESS_THRESHOLD = 40;

/**
 * Compress `fd` / `fdfind` / `find` file search output.
 *
 * Pass-through when output has <=40 lines — fully readable. Summarise when
 * output exceeds 40 lines: keep first 35 lines + last 5 lines + a marker.
 */
export class FdFilter extends Filter {
  override name = "fd";
  override binaries: ReadonlySet<string> = new Set(["fd", "fdfind", "find"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return this.binaries.has(stem);
  }

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const text = normalise(merged);

    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => _strip(ln) !== "");

    if (non_empty.length <= _FD_COMPRESS_THRESHOLD) {
      return _rstrip(text);
    }

    return _head_tail_compress(non_empty, 35, 5, "paths");
  }
}

// ===========================================================================
// wc (Python ~11855-11878)
// ===========================================================================

/**
 * Normalise `wc` word/line/byte count output.
 *
 * `wc` output is already tiny (usually 1–3 lines with a handful of numbers),
 * so this filter does not truncate — it only strips the leading whitespace that
 * POSIX `wc` pads for alignment, producing a cleaner representation.
 */
export class WcFilter extends Filter {
  override name = "wc";
  override binaries: ReadonlySet<string> = new Set(["wc"]);

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const text = normalise(merged);
    const lines = _splitlines(text);
    const stripped = lines.map((ln) => _lstrip(ln));
    return _rstrip(stripped.join("\n"));
  }
}
