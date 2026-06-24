/**
 * bash_compress SEARCH-TOOL FILTERS — TypeScript port of the grep / ripgrep
 * Filter subclasses from src/token_goat/bash_compress.py (Python classes
 * GrepFilter ~line 9975 and RgFilter ~line 10099) plus the module-level
 * threshold constants they consume.
 *
 * Two filters subclass the concrete Filter base from ./framework.js:
 *   - GrepFilter — compress grep / egrep / fgrep / rg / ag / ack / ack-grep and
 *                  `git grep` output. Pass-through under the line threshold;
 *                  otherwise emit a per-file match-count summary. Overrides
 *                  matches() (custom stem derivation + `git grep` form) and
 *                  compress() directly.
 *   - RgFilter   — strip context lines from rg/grep -C/-A/-B output when the
 *                  output is large. Inter-match group compression when many
 *                  "--"-separated groups exist; per-line context stripping
 *                  otherwise. Default binaries-only matches(); overrides
 *                  compress() directly.
 *
 * GrepFilter is intentionally registered BEFORE GitFilter in the barrel so
 * `git grep` is intercepted here (identical output format); the registry
 * ordering is wired by the barrel one level up (out of scope here).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names (GrepFilter,
 *    RgFilter), snake_case methods/fields (matches, compress, _parse_context_depth,
 *    _is_files_only, _is_count_only, _compress_groups), snake_case module
 *    constants (_GREP_COMPRESS_THRESHOLD, _GREP_MAX_FILE_LINES,
 *    _RG_CONTEXT_THRESHOLD, _RG_TOP_GROUPS, _RG_GROUP_THRESHOLD), and the
 *    ClassVar regexes (_CTX_LINE_RE, _MATCH_LINE_RE) / _SEP separator.
 *  - re.compile(...) -> top-level RegExp compiled once at module load; the
 *    ClassVar patterns are plain (non-global) so .match() (start-anchored) is
 *    emulated via _reMatch (non-global clone + index===0).
 *  - GrepFilter.matches reproduces Python's bespoke stem derivation verbatim:
 *    argv[0].lower().split("/")[-1].split("\\")[-1] then strip a trailing ".exe".
 *    This is NOT the framework _pathStem (which strips the final extension); grep
 *    keeps the full basename minus only ".exe", so a local _grepStem is used.
 *  - _positional_args is framework-PUBLIC and imported from ./framework.js.
 *  - contextlib.suppress(ValueError) around int(...) -> a try/catch around a
 *    strict integer parse (_parseIntStrict) that throws on a non-integer token,
 *    matching Python int(...) raising ValueError; the suppress swallows it.
 *  - sorted(range(len(groups)), key=lambda i: -count) is a STABLE descending sort
 *    on the match-line count; Array.prototype.sort is stable in modern V8, and a
 *    (b-a) comparator on the negated key preserves Python's tie-order (original
 *    index ascending). set(scored[:N]) -> a Set of the top-N indices.
 *  - Module-global mutable state: NONE. Every counter/dict/list is a local inside
 *    matches()/compress()/_compress_groups(); no registerReset seam is needed.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import { Filter, _positional_args } from "./framework.js";

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

/**
 * Python int(s) for a base-10 integer literal — raises on any non-integer token
 * (so contextlib.suppress(ValueError) can swallow it). Mirrors Python by
 * rejecting empty/whitespace-only strings, floats, and trailing junk, while
 * accepting an optional leading sign and surrounding whitespace.
 */
function _parseIntStrict(s: string): number {
  const t = s.trim();
  if (t === "" || !/^[+-]?\d+$/.test(t)) {
    throw new Error("invalid literal for int()");
  }
  return parseInt(t, 10);
}

/**
 * GrepFilter's bespoke binary-stem derivation:
 *   argv[0].lower().split("/")[-1].split("\\")[-1], then strip a trailing ".exe".
 * NOTE: unlike framework _pathStem this keeps the full basename minus only the
 * ".exe" suffix (so "ack-grep" stays "ack-grep" and "setup.py" would stay
 * "setup.py").
 */
function _grepStem(arg0: string): string {
  let stem = arg0.toLowerCase();
  const slashIdx = stem.lastIndexOf("/");
  if (slashIdx >= 0) {
    stem = stem.slice(slashIdx + 1);
  }
  const bsIdx = stem.lastIndexOf("\\");
  if (bsIdx >= 0) {
    stem = stem.slice(bsIdx + 1);
  }
  if (stem.endsWith(".exe")) {
    stem = stem.slice(0, stem.length - 4);
  }
  return stem;
}

// ===========================================================================
// grep / rg / ag / ack / git grep — thresholds (Python lines ~9920-9925).
// ===========================================================================

/** Threshold: outputs with more non-empty lines than this are compressed. */
export const _GREP_COMPRESS_THRESHOLD = 30;
/** Maximum number of per-file lines emitted in the summary. */
export const _GREP_MAX_FILE_LINES = 20;

/**
 * Compress ``grep``, ``rg``, ``ag``, ``ack``, and ``git grep`` output.
 *
 * Pass-through when the total non-empty output lines are ≤ 30; otherwise emit a
 * one-line header (``grep: N matches across F files``) followed by up to 20
 * per-file lines sorted by match count, with a trailing elision note when more
 * than 20 files matched. Exit code semantics are unchanged.
 *
 * ``git grep`` is intercepted here (before GitFilter) because the output format
 * is identical to plain ``grep``.
 */
export class GrepFilter extends Filter {
  override name = "grep";
  /** Standalone grep-family binaries. */
  override binaries: ReadonlySet<string> = new Set([
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "ack",
    "ack-grep",
  ]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _grepStem(argv[0]!);
    // Standalone grep-family binary
    if (this.binaries.has(stem)) {
      return true;
    }
    // git grep (two-token form after prefix stripping)
    if (stem === "git") {
      const positionals = _positional_args(argv.slice(1));
      return positionals.length > 0 && positionals[0] === "grep";
    }
    return false;
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    // Combine stdout and stderr for line counting; stderr is usually empty for
    // grep but may carry "permission denied" notices.
    const text = this._combine_output(stdout, stderr);

    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => ln.trim() !== "");
    if (non_empty.length <= _GREP_COMPRESS_THRESHOLD) {
      // Pass through — small enough to read in full.
      return text;
    }

    // Build per-file match counts. Grep output lines are typically:
    //   path/to/file.py:42:matched content   (grep / rg / ag)
    //   path/to/file.py-42-context line       (rg context lines, ignore)
    //   Binary file path/to/foo matches        (grep binary notice)
    //   matched content                        (no filename, e.g. stdin / single-file)
    const file_counts = new Map<string, number>();
    let unattributed = 0;
    for (const line of non_empty) {
      // Binary file message
      if (line.startsWith("Binary file ") && line.includes(" matches")) {
        // line.split(" ", 2)[2] in Python keeps everything after the 2nd space.
        const fname = _rsplitMatches(_splitMaxsplit(line, " ", 2)[2] ?? "");
        file_counts.set(fname, (file_counts.get(fname) ?? 0) + 1);
        continue;
      }
      // Standard grep/rg match line: "path:lineno:content" or "path:content"
      const colon_idx = line.indexOf(":");
      if (colon_idx > 0) {
        const candidate = line.slice(0, colon_idx);
        // Heuristic: candidate looks like a file path when it contains a dot or
        // a path separator. rg emits "path/to/file:..." on POSIX and
        // "path\to\file:..." on Windows; bare "setup.py" caught by the dot.
        if (candidate.includes(".") || candidate.includes("/") || candidate.includes("\\")) {
          file_counts.set(candidate, (file_counts.get(candidate) ?? 0) + 1);
          continue;
        }
      }
      unattributed += 1;
    }

    let total_matches = unattributed;
    for (const v of file_counts.values()) {
      total_matches += v;
    }
    const num_files = file_counts.size;

    // Emit compact summary.
    const out_lines: string[] = [`grep: ${total_matches} matches across ${num_files} file(s)`];

    // Sort by match count descending, emit top N. Python sorted() is stable;
    // Map preserves insertion order so ties retain first-seen order.
    const sorted_files = [...file_counts.entries()].sort((a, b) => b[1] - a[1]);
    const shown = sorted_files.slice(0, _GREP_MAX_FILE_LINES);
    for (const [fname, count] of shown) {
      out_lines.push(`  ${fname}: ${count} match(es)`);
    }
    if (sorted_files.length > _GREP_MAX_FILE_LINES) {
      const remaining = sorted_files.length - _GREP_MAX_FILE_LINES;
      out_lines.push(
        `  [token-goat: +${remaining} more file(s) elided; ` +
          `use --context or -C flags to narrow]`,
      );
    }
    if (unattributed) {
      out_lines.push(`  (unattributed lines: ${unattributed})`);
    }
    out_lines.push(
      `[token-goat: grep output compressed from ${non_empty.length} lines ` +
        `to ${out_lines.length} — disable via TOKEN_GOAT_BASH_COMPRESS]`,
    );
    return out_lines.join("\n");
  }
}

/**
 * Python str.split(sep, maxsplit) — split on sep at most maxsplit times; the
 * final element keeps any remaining separators. Used for line.split(" ", 2).
 */
function _splitMaxsplit(s: string, sep: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = s;
  let count = 0;
  while (count < maxsplit) {
    const idx = rest.indexOf(sep);
    if (idx < 0) {
      break;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
    count += 1;
  }
  out.push(rest);
  return out;
}

/**
 * Python s.rsplit(" matches", 1)[0] — everything before the LAST " matches".
 * When " matches" is absent the whole string is returned (matching rsplit's
 * one-element result indexed at [0]).
 */
function _rsplitMatches(s: string): string {
  const idx = s.lastIndexOf(" matches");
  return idx >= 0 ? s.slice(0, idx) : s;
}

// ===========================================================================
// rg / grep context-line suppressor — thresholds (Python lines ~10093-10096).
// ===========================================================================

/** Threshold: outputs with this many or fewer lines pass through unchanged. */
export const _RG_CONTEXT_THRESHOLD = 30;
export const _RG_TOP_GROUPS = 5;
export const _RG_GROUP_THRESHOLD = 10;

/** Strip context lines from rg/grep -C/-A/-B output when output is large. */
export class RgFilter extends Filter {
  override name = "rg";
  override binaries: ReadonlySet<string> = new Set(["rg", "grep"]);

  static readonly _SEP = "--";
  // Python: re.compile(r"^.+-\d+-")
  static readonly _CTX_LINE_RE: RegExp = /^.+-\d+-/;
  // Python: re.compile(r"^.+:\d+:")
  static readonly _MATCH_LINE_RE: RegExp = /^.+:\d+:/;

  static _parse_context_depth(argv: string[]): number {
    // Return max of -A, -B, -C values found in argv (0 if none).
    let depth = 0;
    const long_flags = new Set(["--after-context", "--before-context", "--context"]);
    let i = 0;
    while (i < argv.length) {
      const a = argv[i]!;
      if (
        (a === "-A" || a === "-B" || a === "-C" || long_flags.has(a)) &&
        i + 1 < argv.length
      ) {
        try {
          depth = Math.max(depth, _parseIntStrict(argv[i + 1]!));
        } catch {
          // contextlib.suppress(ValueError)
        }
        i += 2;
        continue;
      }
      for (const short of ["-A", "-B", "-C"]) {
        if (a.startsWith(short) && a.length > 2) {
          try {
            depth = Math.max(depth, _parseIntStrict(a.slice(2)));
          } catch {
            // contextlib.suppress(ValueError)
          }
        }
      }
      i += 1;
    }
    return depth;
  }

  static _is_files_only(argv: string[]): boolean {
    // True if rg was called with -l/--files-with-matches; output already compact.
    return argv.some((a) => a === "-l" || a === "--files-with-matches");
  }

  static _is_count_only(argv: string[]): boolean {
    // True if rg was called with -c/--count; output already compact.
    return argv.some((a) => a === "-c" || a === "--count");
  }

  _compress_groups(groups: string[]): string {
    // Keep top _RG_TOP_GROUPS groups by match-line count; replace rest with sentinel.
    const score = (g: string): number => {
      let c = 0;
      for (const ln of g.split("\n")) {
        if (_reMatch(RgFilter._MATCH_LINE_RE, ln)) {
          c += 1;
        }
      }
      return c;
    };
    // sorted(range(len(groups)), key=lambda i: -score) — stable descending sort.
    const indices = Array.from({ length: groups.length }, (_v, i) => i);
    indices.sort((ia, ib) => -score(groups[ia]!) - -score(groups[ib]!));
    const top_idx = new Set(indices.slice(0, _RG_TOP_GROUPS));
    const kept: string[] = [];
    for (let i = 0; i < groups.length; i += 1) {
      if (top_idx.has(i)) {
        kept.push(groups[i]!);
      }
    }
    const suppressed = groups.length - kept.length;
    const joined = kept.join("\n" + RgFilter._SEP + "\n");
    return (
      joined +
      `\n[token-goat: ${suppressed} more match groups suppressed — rerun with -l for filenames only]`
    );
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const text = this._combine_output(stdout, stderr);
    // Files-only and count-only output is already compact; pass through unchanged.
    if (RgFilter._is_files_only(argv) || RgFilter._is_count_only(argv)) {
      return text;
    }
    const lines = text.split("\n");
    if (lines.length <= _RG_CONTEXT_THRESHOLD) {
      return text;
    }
    if (!lines.some((ln) => ln === RgFilter._SEP)) {
      return text;
    }
    // Inter-match group compression: many groups → keep only the top _RG_TOP_GROUPS.
    const groups = text
      .split("\n" + RgFilter._SEP + "\n")
      .filter((g) => g.trim() !== "");
    if (groups.length > _RG_GROUP_THRESHOLD) {
      return this._compress_groups(groups);
    }
    // Context line stripping for large output with few groups.
    const kept: string[] = [];
    let suppressed = 0;
    for (const ln of lines) {
      if (
        ln === RgFilter._SEP ||
        (_reMatch(RgFilter._CTX_LINE_RE, ln) && !_reMatch(RgFilter._MATCH_LINE_RE, ln))
      ) {
        suppressed += 1;
      } else {
        kept.push(ln);
      }
    }
    if (suppressed === 0) {
      return text;
    }
    kept.push(
      `[token-goat: ${suppressed} context lines suppressed` +
        ` — rerun with -l for filenames only or without -C/-A/-B for matches only]`,
    );
    return kept.join("\n");
  }
}
