/**
 * bash_compress GIT-DIFF FILTER — TypeScript port of GitDiffFilter and its
 * supporting free functions from src/token_goat/bash_compress.py (Python lines
 * ~6717-6985 for the git-diff body/stat/enhanced helpers, plus the shared
 * hunk-scoring helpers _split_into_hunks / _score_and_cap_hunks at Python lines
 * ~14020-14080 which GitDiffFilter's body path depends on).
 *
 * GitDiffFilter subclasses the concrete Filter base from ./framework.js and
 * overrides compress() to delegate to _compress_git_diff_enhanced, which routes
 * `git diff --stat` / `--shortstat` / `--name-only` to a directory-rollup stat
 * compressor and everything else to _compress_git_diff_body. The body path does
 * binary-file collapsing, density-based hunk capping (config-gated via
 * config.load().bash_diff), large-hunk head/tail truncation, repetitive-JSON
 * summarisation, and trailing-context trimming (recording the
 * "git_diff_context_trimmed" cached stat via hooks_common.record_cached_stat).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: PascalCase class name
 *    (GitDiffFilter); snake_case free functions (_compress_git_diff_enhanced,
 *    _compress_git_diff_stat, _diff_stat_dir_rollup, _is_repetitive_json_hunk,
 *    _trim_hunk_trailing_context, _compress_git_diff_body, _split_into_hunks,
 *    _score_and_cap_hunks); and the module-private regex/constant names
 *    (_GIT_DIFF_FILE_RE, _GIT_DIFF_HUNK_RE, _GIT_DIFF_BINARY_RE,
 *    _GIT_DIFF_STAT_FILE_RE, _GIT_DIFF_STAT_SUMMARY_RE, _GIT_DIFF_HEADER_RE,
 *    _DIFF_STAT_DIR_ROLLUP_THRESHOLD, _DIFF_HUNK_RE).
 *  - re.compile(...) -> top-level RegExp compiled once at module load, flags
 *    preserved. Python re.Pattern.match(line) is anchored at the START (NOT
 *    end-anchored); emulated via _reMatch (non-global clone + index===0).
 *  - _GIT_DIFF_HUNK_RE is Python's `^@@\s` (the git-diff hunk splitter used by
 *    _compress_git_diff_body via split_blocks). _DIFF_HUNK_RE is the DiffFilter
 *    family's `^@@ ` (literal space) used ONLY by _split_into_hunks — kept
 *    separate and byte-exact because the two patterns differ (`\s` vs literal
 *    space) and _score_and_cap_hunks splits on _DIFF_HUNK_RE exactly as Python
 *    does. _DIFF_HUNK_RE is defined in the DiffFilter region of the Python source
 *    (line 13920); it is replicated here (not imported) so this module is
 *    self-contained until the DiffFilter module lands and the barrel dedupes.
 *  - split_blocks / _is_diff_add / _is_diff_remove are imported from
 *    ./framework.js (the framework owns the single authoritative implementations
 *    that Python keeps module-level). Filter base is imported from ./framework.js.
 *  - config: `import * as config from "../config.js"` then config.load() reads
 *    bash_diff.max_hunks_per_file / bash_diff.hunk_density_cap. Python:
 *    `_max_hunks = _cfg.bash_diff.max_hunks_per_file if
 *    _cfg.bash_diff.hunk_density_cap else 0`. The TS BashDiffConfig fields are
 *    optional (T | undefined); the gate reads hunk_density_cap truthily exactly
 *    like Python (a falsy/undefined cap -> 0 hunks -> cap disabled) and falls
 *    back to 0 for an undefined max_hunks_per_file (the real config always
 *    populates both; the MagicMock-style test stub sets them explicitly).
 *  - record_cached_stat imported from "../hooks_common.js" (snake_case export).
 *    Called only when any_context_trimmed is truthy, with the count str()-ified,
 *    matching Python `record_cached_stat("git_diff_context_trimmed",
 *    str(any_context_trimmed))`.
 *  - JSON parsing: Python's `_json.loads(stripped)` inside try/except
 *    (ValueError, TypeError) -> JSON.parse inside try/catch. _is_repetitive_json_hunk
 *    counts only objects whose parsed value is a plain dict
 *    (isinstance(obj, dict)); the TS guard mirrors that (object, non-null,
 *    non-array). frozenset(obj.keys()) dedup -> a canonical sorted-keys string in
 *    a Set so two objects with the same key-set collapse identically.
 *  - Stable descending sort: Python `sorted(scored, key=lambda x: x[1],
 *    reverse=True)` is STABLE — equal densities keep original (ascending-index)
 *    order. JS Array.sort is stable (ES2019+); the comparator sorts by density
 *    descending and tie-breaks on ascending original index to reproduce Python's
 *    stable reverse ordering exactly.
 *  - Float formatting: `{avg:.2f}` -> avg.toFixed(2). The tested densities are
 *    averages of small fractions that never land on an exact half-ulp at the 2nd
 *    decimal, so toFixed (half-away-from-zero) and Python's round-half-even agree.
 *  - str.count("+") / str.count("-") -> _countChar (non-overlapping single-char
 *    count). str.lstrip()/rstrip()/strip("{")/rstrip("}") -> local _lstrip /
 *    _rstrip / _stripBrace helpers. dict insertion-order iteration for the rollup
 *    is replaced by sorted(dir_adds) -> Object key sort over a Map (Python sorts
 *    the dir names explicitly, so order is deterministic).
 *  - Module-global mutable state: NONE. All per-call accumulators are locals; no
 *    registerReset seam is needed (the config cache + stat sink live in their own
 *    modules and own their own reset wiring).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js) while config / hooks_common are one
 * level UP (../). verbatimModuleSyntax is on -> nothing imported here is
 * type-only. noImplicitOverride is on -> every overridden member carries
 * `override`.
 */

import {
  Filter,
  split_blocks,
  _is_diff_add,
  _is_diff_remove,
} from "./framework.js";
import * as config from "../config.js";
import { record_cached_stat } from "../hooks_common.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(line) — anchored at the START of the string (NOT
 * end-anchored). JS has no anchored-match primitive; emulate by checking the
 * match index is 0.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/** Python str.rstrip() — strip trailing ASCII+Unicode whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python str.lstrip() — strip leading ASCII+Unicode whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/u, "");
}

/** Python str.strip() — strip leading AND trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/**
 * Python "...".lstrip("{").rstrip("}") for the rename-notation path-part: strip
 * leading "{" chars then trailing "}" chars.
 */
function _stripBrace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "{") {
    start += 1;
  }
  while (end > start && s[end - 1] === "}") {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Python str.count(ch) — count of non-overlapping single-char occurrences. */
function _countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ch) {
      n += 1;
    }
  }
  return n;
}

// ===========================================================================
// Module-level regexes / constants (Python lines ~6278, ~6717-6730, ~13920).
// ===========================================================================

// Python: re.compile(r"^diff --git ")
const _GIT_DIFF_FILE_RE: RegExp = /^diff --git /;
// Python: re.compile(r"^@@\s")
const _GIT_DIFF_HUNK_RE: RegExp = /^@@\s/;
// Python: re.compile(r"^Binary files? .+ (?:and .+ )?differ$")
const _GIT_DIFF_BINARY_RE: RegExp = /^Binary files? .+ (?:and .+ )?differ$/;
// Python: re.compile(r"^\s+\S.*\|\s+\d+")  — "  path/to/file | N ++-"
const _GIT_DIFF_STAT_FILE_RE: RegExp = /^\s+\S.*\|\s+\d+/;
// Python: re.compile(r"^\s*\d+ files? changed")
const _GIT_DIFF_STAT_SUMMARY_RE: RegExp = /^\s*\d+ files? changed/;
// Files above this count trigger per-directory rollup grouping in --stat output.
const _DIFF_STAT_DIR_ROLLUP_THRESHOLD = 20;
// Python: re.compile(r"^(?:diff --git|index |--- |[+]{3} )")
const _GIT_DIFF_HEADER_RE: RegExp = /^(?:diff --git|index |--- |[+]{3} )/;
// Python (DiffFilter region, line 13920): re.compile(r"^@@ ")  — literal space.
// Used ONLY by _split_into_hunks; distinct from _GIT_DIFF_HUNK_RE (`^@@\s`).
const _DIFF_HUNK_RE: RegExp = /^@@ /;

// _GIT_DIFF_HEADER_RE is part of the Python __all__-adjacent module surface but
// has no in-module caller here; referenced in a no-op so the import-time
// compilation is observable and the symbol is retained for parity with the
// Python module that defines it alongside the other git-diff regexes.
void _GIT_DIFF_HEADER_RE;

// ===========================================================================
// git diff --stat compression
// ===========================================================================

/**
 * Compress git diff / git show with stat-aware strategies.
 *
 * --stat / --shortstat: if >20 files, keep first 10 + summary.
 * Default: binary file diffs -> one-line summary; large hunks -> truncated.
 */
export function _compress_git_diff_enhanced(stdout: string, stderr: string, argv: string[]): string {
  const flags = new Set(argv);
  const is_stat = flags.has("--stat") || flags.has("--shortstat") || flags.has("--name-only");

  if (is_stat) {
    return _compress_git_diff_stat(stdout, stderr, argv);
  }

  return _compress_git_diff_body(stdout, stderr);
}

/**
 * Collapse git diff --stat output using directory rollups when over threshold.
 *
 * When the stat lists more than _DIFF_STAT_DIR_ROLLUP_THRESHOLD files and no
 * explicit pathspec (-- path) is present, files are grouped into one rollup line
 * per top-level directory so a 50-file stat becomes 3-5 lines instead of 50.
 * When a pathspec is present the caller already scoped to a path, so per-file
 * listing is kept (truncated to the first 10 when still over-threshold). The
 * total summary line (N files changed, X insertions(+), Y deletions(-)) is always
 * preserved. Works for both git diff --stat and git show --stat.
 */
export function _compress_git_diff_stat(
  stdout: string,
  stderr: string,
  argv?: string[] | undefined,
): string {
  const lines = stdout.split("\n");
  const stat_lines = lines.filter((ln) => _reMatch(_GIT_DIFF_STAT_FILE_RE, ln));
  const summary_lines = lines.filter((ln) => _reMatch(_GIT_DIFF_STAT_SUMMARY_RE, ln));
  const other_lines = lines.filter(
    (ln) => !_reMatch(_GIT_DIFF_STAT_FILE_RE, ln) && !_reMatch(_GIT_DIFF_STAT_SUMMARY_RE, ln),
  );

  let out: string;
  if (stat_lines.length <= _DIFF_STAT_DIR_ROLLUP_THRESHOLD) {
    out = stdout;
  } else {
    // When a pathspec (-- path) is supplied the user explicitly scoped the diff;
    // keep individual file lines, just truncate to _HEAD_FILES if still large.
    const has_pathspec = argv !== undefined && argv.includes("--");
    let out_lines: string[];
    if (has_pathspec) {
      const _HEAD_FILES = 10;
      const elided = stat_lines.length - _HEAD_FILES;
      let adds = 0;
      let dels = 0;
      for (const ln of stat_lines.slice(_HEAD_FILES)) {
        adds += _countChar(ln, "+");
        dels += _countChar(ln, "-");
      }
      const kept_stat = [
        ...stat_lines.slice(0, _HEAD_FILES),
        ` [token-goat: +${elided} more files changed, +${adds} -${dels} lines]`,
      ];
      out_lines = [...other_lines, ...kept_stat, ...summary_lines];
    } else {
      out_lines = [...other_lines, ..._diff_stat_dir_rollup(stat_lines), ...summary_lines];
    }
    out = out_lines.join("\n");
  }

  if (_strip(stderr) !== "") {
    out = _rstrip(out) + "\n---\n" + _rstrip(stderr);
  }
  return out;
}

/**
 * Group git diff --stat file lines by top-level directory.
 *
 * Returns one rollup string per directory, e.g. `  scripts/ (12 files, +234/-89)`.
 * Files at the repo root (no slash in path) are grouped under `(root)`. Rename
 * notation (`old => new` or `{old => new}/rest`) is resolved to the destination.
 */
export function _diff_stat_dir_rollup(stat_lines: string[]): string[] {
  const dir_adds = new Map<string, number>();
  const dir_dels = new Map<string, number>();
  const dir_count = new Map<string, number>();

  for (const ln of stat_lines) {
    const stripped = _lstrip(ln);
    if (!stripped.includes(" | ")) {
      continue;
    }
    let path_part = _strip(stripped.split(" | ")[0]!);
    // Resolve rename notation: "old/path => new/path" or "{old => new}/rest"
    if (path_part.includes(" => ")) {
      const segs = path_part.split(" => ");
      path_part = _stripBrace(_strip(segs[segs.length - 1]!));
    }
    const top_dir = path_part.includes("/") ? path_part.split("/")[0]! + "/" : "(root)";
    const stat_part = stripped.includes(" | ") ? _splitOnce(stripped, " | ")[1] : "";
    dir_adds.set(top_dir, (dir_adds.get(top_dir) ?? 0) + _countChar(stat_part, "+"));
    dir_dels.set(top_dir, (dir_dels.get(top_dir) ?? 0) + _countChar(stat_part, "-"));
    dir_count.set(top_dir, (dir_count.get(top_dir) ?? 0) + 1);
  }

  const rollup: string[] = [];
  for (const dir_name of [...dir_adds.keys()].sort()) {
    const n = dir_count.get(dir_name)!;
    const a = dir_adds.get(dir_name)!;
    const d = dir_dels.get(dir_name)!;
    rollup.push(`  ${dir_name} (${n} file${n !== 1 ? "s" : ""}, +${a}/-${d})`);
  }
  return rollup;
}

/** Python str.split(sep, 1) — split on the FIRST occurrence into at most two parts. */
function _splitOnce(s: string, sep: string): [string, string] {
  const idx = s.indexOf(sep);
  if (idx < 0) {
    return [s, ""];
  }
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

// ===========================================================================
// git diff body compression (binary collapsing + hunk truncation)
// ===========================================================================

/**
 * Return true when the hunk is dominated by repetitive JSON-object lines.
 *
 * Triggers when >=75% of added lines parse as JSON dicts and all parsed objects
 * share <=5 distinct key-sets — i.e. machine-generated structured data such as
 * JSONL audit logs, test fixtures, or mutation records.
 */
export function _is_repetitive_json_hunk(hunk_lines: string[]): boolean {
  const added = hunk_lines.filter((ln) => _is_diff_add(ln)).map((ln) => ln.slice(1));
  if (added.length < 8) {
    return false;
  }
  let valid = 0;
  const key_sets = new Set<string>();
  for (const line of added) {
    const stripped = _strip(line);
    if (!stripped) {
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(stripped);
    } catch {
      // (ValueError, TypeError) — not parseable JSON; skip.
      continue;
    }
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      valid += 1;
      // frozenset(obj.keys()) dedup: canonicalise the key-set so two objects
      // with the same keys (any order) collapse to one entry.
      const keys = Object.keys(obj as Record<string, unknown>).sort();
      key_sets.add(JSON.stringify(keys));
    }
  }
  if (valid < 8) {
    return false;
  }
  return valid / added.length >= 0.75 && key_sets.size <= 5;
}

/**
 * Trim trailing context lines beyond max_trail after the last changed line.
 *
 * Returns [trimmed_lines, n_trimmed]; when nothing is trimmed the input list is
 * returned with a 0 count.
 */
export function _trim_hunk_trailing_context(
  hunk_lines: string[],
  max_trail = 2,
): [string[], number] {
  // Find the last changed line (+ or -), then drop context lines beyond max_trail.
  let last_changed = -1;
  for (let i = 0; i < hunk_lines.length; i += 1) {
    const ln = hunk_lines[i]!;
    if (ln.startsWith("+") || ln.startsWith("-")) {
      last_changed = i;
    }
  }
  if (last_changed === -1) {
    return [hunk_lines, 0];
  }
  const trailing_context = hunk_lines.slice(last_changed + 1).filter((ln) => ln.startsWith(" "));
  const n_trim = Math.max(0, trailing_context.length - max_trail);
  if (n_trim === 0) {
    return [hunk_lines, 0];
  }
  const keep_up_to = last_changed + 1 + max_trail;
  return [hunk_lines.slice(0, keep_up_to), n_trim];
}

/** Compress full diff body: binary summaries + large-hunk truncation. */
export function _compress_git_diff_body(stdout: string, stderr: string): string {
  const _MAX_HUNK_LINES = 50;
  const _HUNK_HEAD_KEEP = 20;
  const _HUNK_TAIL_KEEP = 5;

  const file_blocks = split_blocks(stdout, _GIT_DIFF_FILE_RE);
  if (file_blocks.length === 0) {
    return stdout;
  }

  const out_blocks: string[] = [];
  let any_context_trimmed = 0;
  for (let block of file_blocks) {
    if (!_reMatch(_GIT_DIFF_FILE_RE, block)) {
      out_blocks.push(block);
      continue;
    }

    let block_lines = block.split("\n");

    // Binary file: collapse to the summary line (already one line in git output).
    if (block_lines.some((ln) => _reMatch(_GIT_DIFF_BINARY_RE, ln))) {
      const binary_summary = block_lines.find((ln) => _reMatch(_GIT_DIFF_BINARY_RE, ln)) ?? null;
      // Keep the diff --git header line for file context.
      const header = block_lines.length > 0 ? block_lines[0]! : "";
      if (binary_summary) {
        out_blocks.push(header + "\n" + binary_summary);
      } else {
        out_blocks.push(block);
      }
      continue;
    }

    // Apply density hunk cap before large-hunk truncation. config.load() always
    // populates bash_diff (Python reads _cfg.bash_diff.* directly); the optional
    // chaining here keeps TS strict happy against the ConfigSchema's `bash_diff?`
    // typing while reproducing Python's gate: hunk_density_cap truthy -> use
    // max_hunks_per_file, else 0 (cap disabled).
    const _cfg = config.load();
    const _bash_diff = _cfg.bash_diff ?? {};
    const _max_hunks = _bash_diff.hunk_density_cap ? (_bash_diff.max_hunks_per_file ?? 0) : 0;
    block_lines = _score_and_cap_hunks(block_lines, _max_hunks);
    block = block_lines.join("\n");
    // Large-hunk truncation: compress each hunk independently.
    const hunks = split_blocks(block, _GIT_DIFF_HUNK_RE);
    if (hunks.length <= 1) {
      // No hunks or single hunk smaller than threshold — pass through.
      out_blocks.push(block);
      continue;
    }

    const compressed_hunks: string[] = [];
    for (const hunk of hunks) {
      const hunk_lines = hunk.split("\n");
      // Keep all --- +++ header lines (they are in the non-hunk first block).
      const changed = hunk_lines.filter((ln) => ln.startsWith("+") || ln.startsWith("-"));
      if (changed.length > _MAX_HUNK_LINES) {
        if (_is_repetitive_json_hunk(hunk_lines)) {
          // Machine-generated JSON/JSONL: emit semantic summary + 2-line sample
          // so the compaction LLM understands what changed without keeping
          // hundreds of near-identical records.
          const n_added = hunk_lines.filter((ln) => _is_diff_add(ln)).length;
          const n_removed = hunk_lines.filter((ln) => _is_diff_remove(ln)).length;
          const sample = hunk_lines.filter((ln) => _is_diff_add(ln)).slice(0, 2);
          const parts = [`+${n_added} JSON records added`];
          if (n_removed) {
            parts.push(`-${n_removed} removed`);
          }
          compressed_hunks.push(
            hunk_lines[0]! +
              `\n[token-goat: repetitive JSON/JSONL block (${parts.join(", ")}); 2-line sample:]\n` +
              sample.join("\n") +
              "\n[use `token-goat bash-output <id>` for full content]",
          );
        } else {
          const head = hunk_lines.slice(0, _HUNK_HEAD_KEEP);
          const tail = hunk_lines.slice(hunk_lines.length - _HUNK_TAIL_KEEP);
          const omitted = hunk_lines.length - _HUNK_HEAD_KEEP - _HUNK_TAIL_KEEP;
          compressed_hunks.push(
            head.join("\n") +
              `\n... ${omitted} lines omitted by token-goat ...\n` +
              tail.join("\n"),
          );
        }
      } else {
        const [trimmed_lines, n_trimmed] = _trim_hunk_trailing_context(hunk_lines);
        if (n_trimmed > 0) {
          any_context_trimmed += n_trimmed;
          compressed_hunks.push(
            trimmed_lines.join("\n") +
              `\n[token-goat: ${n_trimmed} trailing context line(s) trimmed]`,
          );
        } else {
          compressed_hunks.push(hunk);
        }
      }
    }
    out_blocks.push(compressed_hunks.join("\n"));
  }

  if (any_context_trimmed) {
    record_cached_stat("git_diff_context_trimmed", String(any_context_trimmed));
  }
  let text = out_blocks.join("\n");
  if (_strip(stderr) !== "") {
    text += "\n---\n" + _rstrip(stderr);
  }
  return text;
}

// ===========================================================================
// Hunk density scoring (shared with DiffFilter; ported here for the body path).
// ===========================================================================

/**
 * Split a per-file diff block into sub-lists at `@@ …` hunk boundaries.
 *
 * The first sub-list is the file header (before the first `@@` line); subsequent
 * sub-lists each start with an `@@` line. Mirrors the hunk splitting logic in
 * _compress_git_diff but operates on a string[] rather than a single string.
 */
export function _split_into_hunks(block: string[]): string[][] {
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
 * Keep top max_hunks hunks by change density; replace dropped ones with a
 * sentinel.
 *
 * Density = (added_lines + deleted_lines) / total_content_lines, where content
 * lines exclude the @@ header. 0.0 = pure context; 1.0 = every line changed.
 * Hunks scoring lower than the Nth-highest are dropped and summarised in a single
 * sentinel line so the model sees the high-signal hunks without
 * whitespace/formatting noise.
 *
 * When max_hunks is 0, returns hunk_lines unchanged (cap disabled). When the file
 * has <= max_hunks hunks, returns hunk_lines unchanged.
 */
export function _score_and_cap_hunks(hunk_lines: string[], max_hunks: number): string[] {
  if (max_hunks <= 0) {
    return hunk_lines;
  }
  const hunks = _split_into_hunks(hunk_lines);
  // hunks[0] is the file header block (--- / +++ lines before first @@)
  const actual = hunks.slice(1);
  if (actual.length <= max_hunks) {
    return hunk_lines;
  }

  const _density = (h: string[]): number => {
    // Skip the @@ header line (index 0) for the ratio; it is not content.
    const content = h.length > 0 ? h.slice(1) : [];
    const total = content.length;
    if (total === 0) {
      return 0.0;
    }
    const changed = content.filter((ln) => ln.startsWith("+") || ln.startsWith("-")).length;
    return changed / total;
  };

  const scored: Array<[number, number]> = actual.map((h, i) => [i, _density(h)]);
  // Python sorted(..., key=x[1], reverse=True) is STABLE: equal densities keep
  // ascending-index order. JS Array.sort is stable; tie-break on ascending index
  // to reproduce Python's stable reverse ordering exactly.
  const ranked = [...scored].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const keep_set = new Set<number>(ranked.slice(0, max_hunks).map(([idx]) => idx));
  const dropped_densities = scored.filter(([i]) => !keep_set.has(i)).map(([, d]) => d);
  const avg =
    dropped_densities.length > 0
      ? dropped_densities.reduce((s, d) => s + d, 0) / dropped_densities.length
      : 0.0;

  const out: string[] = [...(hunks[0] ?? [])];
  for (let i = 0; i < actual.length; i += 1) {
    if (keep_set.has(i)) {
      out.push(...actual[i]!);
    }
  }
  const n_dropped = dropped_densities.length;
  out.push(`[... ${n_dropped} more hunks, avg density ${avg.toFixed(2)} — likely whitespace/formatting]`);
  return out;
}

// ===========================================================================
// GitDiffFilter
// ===========================================================================

/**
 * Compress git diff and git show output.
 *
 * Handles binary-file summaries, large-hunk truncation, and --stat mode.
 * Registered before GitFilter so it claims git diff / git show exclusively with
 * richer compression than the baseline three-hunk cap.
 */
export class GitDiffFilter extends Filter {
  override name = "git-diff";
  override binaries: ReadonlySet<string> = new Set(["git"]);
  override subcommands: ReadonlySet<string> = new Set(["diff", "show"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    return _compress_git_diff_enhanced(stdout, stderr, argv);
  }
}
