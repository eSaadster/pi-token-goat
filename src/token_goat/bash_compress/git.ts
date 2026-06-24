/**
 * bash_compress GIT FILTERS — TypeScript port of the six non-diff git filters
 * from src/token_goat/bash_compress.py:
 *
 *   GitFilter             (Python lines ~6282-6322)   — generic git catch-all
 *   GitLogFilter          (Python lines ~6697-6712)   — git log
 *   GitStatusVerboseFilter(Python lines ~7111-7130)   — git status
 *   GitBlameFilter        (Python lines ~7287-7304)   — git blame
 *   GitCommitFilter       (Python lines ~7405-7446)   — git commit
 *   GitPushFilter         (Python lines ~7757-7801)   — git push
 *
 * plus every module-level helper / regex they depend on. The GitDiffFilter
 * (git diff / git show) is INTENTIONALLY OUT OF SCOPE for this run and lives in
 * a separate module; GitFilter still references the BASELINE three-hunk
 * `_compress_git_diff` helper (Python line ~6413) as its diff/show fallback, so
 * that baseline helper (NOT the enhanced GitDiffFilter body) is ported here.
 *
 * In the FILTERS registry the five dedicated subcommand filters are registered
 * BEFORE GitFilter so they claim their subcommand exclusively; GitFilter is the
 * catch-all for every other git subcommand. The registry itself lives in the
 * barrel (../bash_compress.ts) and is wired in a later phase — this module only
 * defines the filter classes.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: snake_case helpers/constants
 *    (_compress_git_status, _GIT_LOG_COMMIT_RE, _LEFTHOOK_PASS_RE, ...) and the
 *    PascalCase class names (GitFilter, GitLogFilter, ...).
 *  - re.compile(...) -> top-level RegExp compiled once, flags preserved
 *    (IGNORECASE -> "i"). re.Pattern.match(line) is START-anchored (not
 *    end-anchored); JS has no anchored-match primitive, so a non-global clone is
 *    used with an index===0 check (_reMatch / _reMatchObj). re.search ->
 *    _reSearch (a non-global .test, no anchoring).
 *  - splitlines() -> _splitlines (split on the universal-newline set Python
 *    recognises, sans the trailing empty element). split("\n") -> String.split.
 *  - str.strip / rstrip / lstrip -> _strip / _rstrip / _lstrip (Unicode ws).
 *  - Path(argv[0]).stem.lower() (GitCommitFilter.matches) -> _pathStemLower,
 *    matching the framework's _pathStem semantics.
 *  - These six filters compress git OUTPUT text; none of them runs git, loads
 *    config, or calls record_cached_stat. (That integration belongs to the
 *    out-of-scope GitDiffFilter body, _compress_git_diff_body.) No module-global
 *    mutable state -> no registerReset wired (mirrors go.ts / node_pm.ts).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden
 * member carries `override`.
 */

import {
  Filter,
  split_blocks,
  dedupe_consecutive,
  _squeeze_blank_lines,
  _is_diff_add,
  _is_diff_remove,
  _positional_args,
} from "./framework.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

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
 * Python re.Pattern.match(line) returning the match (or null), for callers that
 * read capture groups. Non-global clone so lastIndex never leaks.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/** Python re.Pattern.search(line) — boolean "contains a match" (unanchored). */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/** Python re.Pattern.search(line) returning the match (or null), unanchored. */
function _reSearchObj(re: RegExp, line: string): RegExpExecArray | null {
  return _nonGlobal(re).exec(line);
}

/**
 * Python str.splitlines() — split on the universal newline set and drop the
 * trailing empty element that a final line terminator would otherwise produce.
 * Python recognises \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029; the git
 * output this handles only ever carries \n / \r\n, but we mirror the full set so
 * behaviour matches exactly. Unlike split("\n"), an empty string yields [].
 */
function _splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  // Split on the universal-newline set (CRLF first so it is a single break).
  const parts = s.split(
    /\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/,
  );
  // splitlines() does NOT leave a trailing "" when the string ends in a newline.
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Python Path(p).stem.lower() — final path component (after normalising
 * backslashes to forward slashes) with its LAST suffix removed, lowercased.
 * Mirrors the framework's _pathStem: a leading-dot dotfile keeps its name and a
 * trailing dot is not a suffix.
 */
function _pathStemLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name.toLowerCase();
  }
  return name.slice(0, dot).toLowerCase();
}

/** Python Path(p).name.lower() — final path component, lowercased. */
function _pathNameLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return (idx >= 0 ? norm.slice(idx + 1) : norm).toLowerCase();
}

// ===========================================================================
// _ERROR_SIGNAL_RE
//
// The framework's _ERROR_SIGNAL_RE is module-private (not exported), but the
// git-push bundler/pytest paths reference it. It is re-declared here VERBATIM
// from the Python source (one authoritative pattern; identical bytes).
// Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback
//   |exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
// ===========================================================================
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// GitFilter regexes (Python lines ~6273-6279).
// ===========================================================================

// Python: re.compile(r"^(?:On branch|Your branch|Untracked files|Changes
//   (?:not staged|to be committed):|Unmerged paths|Changes to be committed
//   |nothing to commit)")
const _GIT_STATUS_HEADER_RE: RegExp =
  /^(?:On branch|Your branch|Untracked files|Changes (?:not staged|to be committed):|Unmerged paths|Changes to be committed|nothing to commit)/;
// Python: re.compile(r"^commit [0-9a-f]{7,}")
const _GIT_LOG_COMMIT_RE: RegExp = /^commit [0-9a-f]{7,}/;
// Python: re.compile(r"^diff --git ")
const _GIT_DIFF_FILE_RE: RegExp = /^diff --git /;
// Python: re.compile(r"^@@\s")
const _GIT_DIFF_HUNK_RE: RegExp = /^@@\s/;

// ===========================================================================
// GitFilter (Python lines ~6282-6322).
// ===========================================================================

/**
 * Compress `git` output across status / log / diff / show / ls-files.
 *
 * Git is the highest-volume command in any agent session; `git status` after a
 * refactor can be hundreds of lines. Subcommand dispatch table:
 *
 *  - status: keep headers + first 30 changed-file lines, summarize rest.
 *  - log: keep first 10 commits in full, summarize rest by date range.
 *  - diff / show: per-file keep first 3 hunks; replace additional hunks with
 *    `[+N more hunks elided by token-goat]`. For large diffs (> 200 files) drop
 *    file bodies entirely and emit a `--stat`-style summary.
 *  - ls-files / ls-tree: truncate to first 100 + tail summary.
 *  - fetch / pull / push: drop `remote: counting objects` progress, keep the
 *    `->` ref-update lines and any error.
 *  - everything else (rev-parse, config, blame, ...): generic dedupe only.
 */
export class GitFilter extends Filter {
  override name = "git";
  override binaries: ReadonlySet<string> = new Set(["git"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    // Git writes "counting objects" etc. to stderr, useful only when something fails.
    if (subcommand === "status") {
      return _compress_git_status(stdout, stderr);
    }
    if (subcommand === "log") {
      return _compress_git_log(stdout, stderr);
    }
    if (subcommand === "diff" || subcommand === "show") {
      return _compress_git_diff(stdout, stderr);
    }
    if (subcommand === "ls-files" || subcommand === "ls-tree") {
      return _truncate_listing(stdout, stderr, { head: 100 });
    }
    if (
      subcommand === "fetch" ||
      subcommand === "pull" ||
      subcommand === "push" ||
      subcommand === "clone"
    ) {
      return _compress_git_remote(stdout, stderr);
    }
    // Fallback: ANSI / progress already stripped; dedupe consecutive.
    const merged = this._combine_output(stdout, stderr);
    return _squeeze_blank_lines(dedupe_consecutive(merged.split("\n")).join("\n"));
  }
}

/** Truncate `git status` output, summarising long file lists by category. */
export function _compress_git_status(stdout: string, stderr: string): string {
  const lines = stdout.split("\n");
  const out: string[] = [];
  let kept_files = 0;
  const bucket: Record<string, number> = {};
  for (const line of lines) {
    if (_reMatch(_GIT_STATUS_HEADER_RE, line) || _strip(line) === "" || line.startsWith("\t(")) {
      out.push(line);
      continue;
    }
    if (line.startsWith("\t") || line.startsWith("        ")) {
      kept_files += 1;
      if (kept_files <= 30) {
        out.push(line);
      } else {
        const kind = _git_status_kind(line);
        bucket[kind] = (bucket[kind] ?? 0) + 1;
      }
      continue;
    }
    out.push(line);
  }
  const keys = Object.keys(bucket);
  if (keys.length > 0) {
    let total = 0;
    for (const k of keys) {
      total += bucket[k]!;
    }
    const summary = keys
      .slice()
      .sort()
      .map((kind) => `${bucket[kind]!} ${kind}`)
      .join(", ");
    out.push(`[token-goat: +${total} more files: ${summary}]`);
  }
  if (_strip(stderr) !== "") {
    out.push("---", _rstrip(stderr));
  }
  return out.join("\n");
}

/** Return a short label for a porcelain git status line (modified / new / deleted). */
export function _git_status_kind(line: string): string {
  const stripped = _strip(line);
  if (stripped.startsWith("modified:")) {
    return "modified";
  }
  if (stripped.startsWith("new file:")) {
    return "new";
  }
  if (stripped.startsWith("deleted:")) {
    return "deleted";
  }
  if (stripped.startsWith("renamed:")) {
    return "renamed";
  }
  if (stripped.startsWith("typechange:")) {
    return "typechange";
  }
  return "other";
}

/** Keep the first *max_commits* commit blocks in full, summarising the rest. */
export function _compress_git_log(
  stdout: string,
  stderr: string,
  opts?: { max_commits?: number },
): string {
  const max_commits = opts?.max_commits ?? 10;
  const blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE);
  // split_blocks returns leading non-commit text as block 0; preserve it.
  if (blocks.length === 0) {
    return stdout;
  }
  const prelude = !_reMatch(_GIT_LOG_COMMIT_RE, blocks[0]!) ? blocks[0]! : "";
  const commits = blocks.filter((b) => _reMatch(_GIT_LOG_COMMIT_RE, b));
  if (commits.length <= max_commits) {
    return stdout;
  }
  const kept = commits.slice(0, max_commits);
  const elided = commits.slice(max_commits);
  // Extract first and last commit refs from the elided set for context.
  const first_elided = elided[0]!.split("\n", 1)[0]!;
  const last_elided = elided[elided.length - 1]!.split("\n", 1)[0]!;
  const summary =
    `\n[token-goat: +${elided.length} earlier commits elided; ` +
    `oldest: ${last_elided.slice(0, 80)}; first elided: ${first_elided.slice(0, 80)}]`;
  let text = (prelude ? prelude + "\n" : "") + kept.join("\n") + summary;
  if (_strip(stderr) !== "") {
    text += "\n---\n" + _rstrip(stderr);
  }
  return text;
}

/** Compress git diff: keep first N hunks per file, summarise the rest. */
export function _compress_git_diff(
  stdout: string,
  stderr: string,
  opts?: { max_hunks_per_file?: number },
): string {
  const max_hunks_per_file = opts?.max_hunks_per_file ?? 3;
  const file_blocks = split_blocks(stdout, _GIT_DIFF_FILE_RE);
  if (file_blocks.length === 0) {
    return stdout;
  }
  // When > 200 files, drop bodies and emit a stat-style summary instead.
  const real_files = file_blocks.filter((b) => _reMatch(_GIT_DIFF_FILE_RE, b));
  if (real_files.length > 200) {
    const stat_lines: string[] = [];
    for (const b of real_files) {
      const header = b.split("\n", 1)[0]!;
      const blines = b.split("\n");
      const adds = blines.filter((ln) => _is_diff_add(ln)).length;
      const dels = blines.filter((ln) => _is_diff_remove(ln)).length;
      stat_lines.push(`${header}  +${adds} -${dels}`);
    }
    return (
      `[token-goat: large diff (${real_files.length} files); showing stat-only view]\n` +
      stat_lines.join("\n")
    );
  }
  const out_blocks: string[] = [];
  for (const block of file_blocks) {
    if (!_reMatch(_GIT_DIFF_FILE_RE, block)) {
      out_blocks.push(block);
      continue;
    }
    const hunks = split_blocks(block, _GIT_DIFF_HUNK_RE);
    if (hunks.length <= max_hunks_per_file + 1) {
      out_blocks.push(block);
      continue;
    }
    // The first hunk-block is the diff header (no @@), keep it.
    const head = hunks.slice(0, max_hunks_per_file + 1);
    const elided = hunks.slice(max_hunks_per_file + 1);
    out_blocks.push(
      head.join("\n") + `\n[token-goat: +${elided.length} more hunks in this file elided]`,
    );
  }
  let text = out_blocks.join("\n");
  if (_strip(stderr) !== "") {
    text += "\n---\n" + _rstrip(stderr);
  }
  return text;
}

/** Truncate a flat list output (one item per line) to the first *head* lines. */
export function _truncate_listing(
  stdout: string,
  stderr: string,
  opts?: { head?: number },
): string {
  const head = opts?.head ?? 100;
  const lines = stdout.split("\n");
  let merged: string;
  if (lines.length <= head) {
    merged = stdout;
  } else {
    merged =
      lines.slice(0, head).join("\n") +
      `\n[token-goat: +${lines.length - head} more lines elided]`;
  }
  if (_strip(stderr) !== "") {
    merged += "\n---\n" + _rstrip(stderr);
  }
  return merged;
}

// Python: re.compile(r"^(?:From |To |   [a-f0-9]+\.\.[a-f0-9]+|\s+\*\s|\s+!\s
//   |\s+\+\s|fatal:|error:|warning:)")
const _GIT_REMOTE_KEEP_RE: RegExp =
  /^(?:From |To |   [a-f0-9]+\.\.[a-f0-9]+|\s+\*\s|\s+!\s|\s+\+\s|fatal:|error:|warning:)/;
// Python: re.compile(r"^(?:remote: (?:Counting|Compressing|Total|Enumerating
//   |Receiving|Resolving) objects|Receiving objects:|Resolving deltas:
//   |Unpacking objects:|Updating files:)")
const _GIT_REMOTE_DROP_RE: RegExp =
  /^(?:remote: (?:Counting|Compressing|Total|Enumerating|Receiving|Resolving) objects|Receiving objects:|Resolving deltas:|Unpacking objects:|Updating files:)/;

/** Drop `remote: Counting/Compressing objects` progress; keep ref updates. */
export function _compress_git_remote(stdout: string, stderr: string): string {
  const merged_lines =
    _strip(stderr) === ""
      ? stdout.split("\n")
      : [...stdout.split("\n"), "---", ...stderr.split("\n")];
  const kept: string[] = [];
  let dropped = 0;
  for (const line of merged_lines) {
    if (_reMatch(_GIT_REMOTE_DROP_RE, line)) {
      dropped += 1;
      continue;
    }
    // When neither side matches a keep/drop pattern, keep it (could be an
    // unanticipated diagnostic).
    kept.push(line);
    void _GIT_REMOTE_KEEP_RE; // documents what we *intend* to keep
  }
  if (dropped) {
    kept.push(`[token-goat: dropped ${dropped} 'remote:' progress lines]`);
  }
  return kept.join("\n");
}

// ===========================================================================
// GitLogFilter helpers (Python lines ~6502-6712).
// ===========================================================================

// Python: re.compile(r"^[0-9a-f]{7,}\s")  (short hash + space — --oneline)
const _GIT_LOG_ONELINE_RE: RegExp = /^[0-9a-f]{7,}\s/;
// Python: re.compile(r"^@@\s")
const _GIT_LOG_DIFF_HUNK_RE: RegExp = /^@@\s/;
// Python: re.compile(r"^Merge:")
const _GIT_LOG_MERGE_RE: RegExp = /^Merge:/;
// Python: re.compile(r"^\s*\d+ files? changed")
const _GIT_LOG_STAT_SUMMARY_RE: RegExp = /^\s*\d+ files? changed/;
// Python: re.compile(r"^Author:\s+(.+)")
const _GIT_LOG_AUTHOR_RE: RegExp = /^Author:\s+(.+)/;
// Python: re.compile(r"^Date:\s+(.+)")
const _GIT_LOG_DATE_RE: RegExp = /^Date:\s+(.+)/;

/**
 * Compress `git log` output with format-aware strategies.
 *
 * Dispatch table (examined in order):
 *  - --oneline / --format=oneline: keep first 50 lines, collapse rest.
 *  - -p / --patch: full-log + patch; collapse large patch sections.
 *  - --stat: keep first commit stat blocks; collapse remaining files.
 *  - Full format (default): collapse each commit block to one line when >10.
 */
export function _compress_git_log_enhanced(stdout: string, stderr: string, argv: string[]): string {
  const flags = new Set(argv);

  // ------------------------------------------------------------------ oneline
  let is_oneline =
    flags.has("--oneline") ||
    flags.has("--format=oneline") ||
    flags.has("--pretty=oneline") ||
    argv.some((a) => a.startsWith("--format=%h") || a.startsWith("--pretty=%h"));
  // Heuristic: if every non-empty line matches the short-hash pattern it's oneline.
  const non_empty = stdout.split("\n").filter((ln) => _strip(ln) !== "");
  if (
    non_empty.length > 0 &&
    non_empty.slice(0, 5).every((ln) => _reMatch(_GIT_LOG_ONELINE_RE, ln))
  ) {
    is_oneline = true;
  }

  if (is_oneline) {
    const lines = stdout.split("\n").filter((ln) => _strip(ln) !== "");
    // --oneline output is already maximally compact (~50 bytes/line); use a
    // higher cap of 50 lines before collapsing (vs 10 for full-format logs).
    const _ONELINE_CAP = 50;
    let kept_lines: string[];
    if (lines.length > _ONELINE_CAP) {
      const elided = lines.length - _ONELINE_CAP;
      kept_lines = [...lines.slice(0, _ONELINE_CAP), `[token-goat: +${elided} more commits]`];
    } else {
      kept_lines = lines;
    }
    let out = kept_lines.join("\n");
    if (_strip(stderr) !== "") {
      out += "\n---\n" + _rstrip(stderr);
    }
    return out;
  }

  // ----------------------------------------------------------------- -p patch
  const is_patch = flags.has("-p") || flags.has("--patch") || flags.has("-u");
  if (is_patch) {
    return _compress_git_log_patch(stdout, stderr);
  }

  // -------------------------------------------------------------------- --stat
  const is_stat = flags.has("--stat") || flags.has("--shortstat") || flags.has("--name-status");
  if (is_stat) {
    return _compress_git_log_stat(stdout, stderr);
  }

  // ---------------------------------------------------------- full format (default)
  return _compress_git_log_full(stdout, stderr);
}

/** Collapse each commit block to one line when there are more than 10 commits. */
export function _compress_git_log_full(stdout: string, stderr: string): string {
  const blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE);
  if (blocks.length === 0) {
    return stdout;
  }
  const prelude = !_reMatch(_GIT_LOG_COMMIT_RE, blocks[0]!) ? blocks[0]! : "";
  const commits = blocks.filter((b) => _reMatch(_GIT_LOG_COMMIT_RE, b));
  if (commits.length <= 10) {
    return stdout;
  }

  const collapsed: string[] = [];
  for (const block of commits) {
    const lines = block.split("\n");
    const hash_line = lines.length > 0 ? lines[0]! : "";
    // Preserve merge indicator.
    const merge = lines.find((ln) => _reMatch(_GIT_LOG_MERGE_RE, ln)) ?? "";
    let author = "";
    let date_str = "";
    let subject = "";
    for (const ln of lines) {
      if (!author) {
        const m = _reMatchObj(_GIT_LOG_AUTHOR_RE, ln);
        if (m) {
          author = _strip(m[1]!.split("<")[0]!);
        }
      }
      if (!date_str) {
        const m = _reMatchObj(_GIT_LOG_DATE_RE, ln);
        if (m) {
          date_str = _strip(m[1]!);
        }
      }
      // Subject is the first non-empty indented line after a blank line.
      if (!subject && ln.startsWith("    ") && _strip(ln) !== "") {
        subject = _strip(ln);
      }
    }
    const parts = [hash_line];
    if (merge) {
      parts.push(merge);
    }
    const detail_parts: string[] = [];
    if (author) {
      detail_parts.push(author);
    }
    if (date_str) {
      detail_parts.push(date_str);
    }
    if (subject) {
      detail_parts.push(`"${subject}"`);
    }
    if (detail_parts.length > 0) {
      parts.push("  " + detail_parts.join(" | "));
    }
    collapsed.push(parts.join("\n"));
  }

  let text = (prelude ? prelude + "\n" : "") + collapsed.join("\n\n");
  if (_strip(stderr) !== "") {
    text += "\n---\n" + _rstrip(stderr);
  }
  return text;
}

/** Compress `git log -p`: collapse large per-commit diff sections. */
export function _compress_git_log_patch(stdout: string, stderr: string): string {
  const _MAX_PATCH_LINES_PER_COMMIT = 30;
  const blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE);
  if (blocks.length === 0) {
    return stdout;
  }
  const prelude = !_reMatch(_GIT_LOG_COMMIT_RE, blocks[0]!) ? blocks[0]! : "";
  const commits = blocks.filter((b) => _reMatch(_GIT_LOG_COMMIT_RE, b));

  const out_blocks: string[] = [];
  for (const block of commits) {
    const lines = block.split("\n");
    // Separate the commit header from the diff body.
    let diff_start: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (_reMatch(_GIT_DIFF_FILE_RE, lines[i]!)) {
        diff_start = i;
        break;
      }
    }
    if (diff_start === null) {
      // No diff section — keep as-is.
      out_blocks.push(block);
      continue;
    }
    const header_lines = lines.slice(0, diff_start);
    let diff_lines = lines.slice(diff_start);
    if (diff_lines.length > _MAX_PATCH_LINES_PER_COMMIT) {
      const elided = diff_lines.length - _MAX_PATCH_LINES_PER_COMMIT;
      diff_lines = [
        ...diff_lines.slice(0, _MAX_PATCH_LINES_PER_COMMIT),
        `--- patch: ${elided} lines omitted by token-goat ---`,
      ];
    }
    out_blocks.push([...header_lines, ...diff_lines].join("\n"));
  }

  let text = (prelude ? prelude + "\n" : "") + out_blocks.join("\n");
  if (_strip(stderr) !== "") {
    text += "\n---\n" + _rstrip(stderr);
  }
  return text;
}

/** Compress `git log --stat`: collapse file-stat sections when >20 files. */
export function _compress_git_log_stat(stdout: string, stderr: string): string {
  const _MAX_STAT_FILES = 20;
  const blocks = split_blocks(stdout, _GIT_LOG_COMMIT_RE);
  if (blocks.length === 0) {
    return stdout;
  }
  const prelude = !_reMatch(_GIT_LOG_COMMIT_RE, blocks[0]!) ? blocks[0]! : "";
  const commits = blocks.filter((b) => _reMatch(_GIT_LOG_COMMIT_RE, b));

  const out_blocks: string[] = [];
  for (let block of commits) {
    const lines = block.split("\n");
    // Count lines that look like file-stat entries (contain "|" with +/-).
    const stat_lines = lines.filter(
      (ln) => ln.includes(" | ") && (ln.includes("++") || ln.includes("--")),
    );
    if (stat_lines.length > _MAX_STAT_FILES) {
      const elided = stat_lines.length - _MAX_STAT_FILES;
      // Replace all stat lines with first N + summary.
      const new_lines: string[] = [];
      let stat_idx = 0;
      let replaced = false;
      for (const ln of lines) {
        if (ln.includes(" | ") && (ln.includes("++") || ln.includes("--"))) {
          if (stat_idx < _MAX_STAT_FILES) {
            new_lines.push(ln);
          } else if (!replaced) {
            new_lines.push(`[token-goat: +${elided} more stat lines omitted]`);
            replaced = true;
          }
          stat_idx += 1;
        } else {
          new_lines.push(ln);
        }
      }
      block = new_lines.join("\n");
    }
    out_blocks.push(block);
  }

  let text = (prelude ? prelude + "\n" : "") + out_blocks.join("\n");
  if (_strip(stderr) !== "") {
    text += "\n---\n" + _rstrip(stderr);
  }
  return text;
}

/**
 * Compress `git log` output with format-aware strategies.
 *
 * Registered before GitFilter so it claims `git log` exclusively. Handles
 * --oneline, -p / --patch, --stat, and the default full format.
 */
export class GitLogFilter extends Filter {
  override name = "git-log";
  override binaries: ReadonlySet<string> = new Set(["git"]);
  override subcommands: ReadonlySet<string> = new Set(["log"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    return _compress_git_log_enhanced(stdout, stderr, argv);
  }
}

// ===========================================================================
// GitStatusVerboseFilter helpers (Python lines ~6986-7108).
// ===========================================================================

// Python: re.compile(r"^[MADRCU?! ][MADRCU?! ] ")
const _SHORT_STATUS_RE: RegExp = /^[MADRCU?! ][MADRCU?! ] /;
// Python: re.compile(r"^(Changes to be committed|Changes not staged for commit
//   |Untracked files|Ignored files|Unmerged paths):")
const _GIT_STATUS_SECTION_RE: RegExp =
  /^(Changes to be committed|Changes not staged for commit|Untracked files|Ignored files|Unmerged paths):/;
const _GIT_STATUS_SECTION_KEYS: Readonly<Record<string, string>> = {
  "Changes to be committed": "staged",
  "Changes not staged for commit": "unstaged",
  "Untracked files": "untracked",
  "Ignored files": "ignored",
  "Unmerged paths": "unmerged",
};
// Python: re.compile(r'^\s*\(use "git '
//   r"|^no changes added to commit"
//   r"|^nothing added to commit but untracked files present")
const _GIT_STATUS_ADVICE_RE: RegExp =
  /^\s*\(use "git |^no changes added to commit|^nothing added to commit but untracked files present/;

/**
 * Return true when output is the compact short/porcelain form.
 *
 * Detected either by an explicit -s / --short / --porcelain flag in *argv*
 * (covers --porcelain=v2 whose rows the body sniffer misses) or by sniffing:
 * every non-empty line begins with the two-char XY status code.
 */
export function _git_status_is_short(argv: string[] | null | undefined, lines: string[]): boolean {
  for (const tok of argv ?? []) {
    if (tok === "-s" || tok === "--short" || tok === "--porcelain" || tok === "-z") {
      return true;
    }
    if (tok.startsWith("--porcelain=")) {
      return true;
    }
    // Combined single-dash flags such as "-sb" / "-uno -s".
    if (tok.startsWith("-") && !tok.startsWith("--") && tok.includes("s")) {
      return true;
    }
  }
  const non_empty = lines.filter((ln) => _strip(ln) !== "");
  return (
    non_empty.length > 0 &&
    non_empty.slice(0, 5).every((ln) => _reMatch(_SHORT_STATUS_RE, ln))
  );
}

/**
 * Map one verbose status file entry to its grouping label.
 *
 * Staged / unstaged entries are "<label>:   <path>" (modified, deleted, new
 * file, renamed, ...). Untracked / ignored entries have no label, so the
 * section name itself is used.
 */
export function _git_status_file_label(line: string, section: string): string {
  const body = _strip(line);
  if (section === "untracked" || section === "ignored") {
    return section;
  }
  if (body.includes(":")) {
    return _strip(body.split(":", 1)[0]!);
  }
  return section;
}

/**
 * Compress full `git status`.
 *
 *  - Short / porcelain format is passed through unchanged — already compact.
 *  - Full verbose format collapses each change section's per-file listing to a
 *    grouped count (`3 modified, 1 deleted`) and strips boilerplate advice
 *    lines. Preserved verbatim: branch / tracking lines, the clean-tree line,
 *    and `Unmerged paths` conflict entries.
 */
export function _compress_git_status_verbose(
  stdout: string,
  stderr: string,
  argv?: string[] | null,
): string {
  const lines = stdout.split("\n");
  if (lines.length === 0) {
    return stdout;
  }

  if (_git_status_is_short(argv ?? null, lines)) {
    let out = stdout;
    if (_strip(stderr) !== "") {
      out = _rstrip(out) + "\n---\n" + _rstrip(stderr);
    }
    return out;
  }

  const kept: string[] = [];
  let section: string | null = null;
  let counts: Record<string, number> = {};

  const flush = (): void => {
    // Unmerged entries are emitted inline (preserved); only grouped sections
    // accumulate counts that need a summary line on flush.
    const count_keys = Object.keys(counts);
    if (section !== null && section !== "unmerged" && count_keys.length > 0) {
      const parts = count_keys.map((label) => `${counts[label]!} ${label}`);
      kept.push("\t" + parts.join(", "));
    }
    counts = {};
  };

  for (const line of lines) {
    const header = _reMatchObj(_GIT_STATUS_SECTION_RE, line);
    if (header) {
      flush();
      section = _GIT_STATUS_SECTION_KEYS[header[1]!]!;
      kept.push(line);
      continue;
    }
    if (_reMatch(_GIT_STATUS_ADVICE_RE, line)) {
      continue;
    }
    if (section !== null && line.startsWith("\t") && _strip(line) !== "") {
      if (section === "unmerged") {
        kept.push(line); // preserve conflict markers verbatim
      } else {
        const label = _git_status_file_label(line, section);
        counts[label] = (counts[label] ?? 0) + 1;
      }
      continue;
    }
    // Any other line (branch, tracking, blank, clean-tree) ends the section.
    flush();
    section = null;
    kept.push(line);
  }

  flush();

  let out = kept.join("\n");
  if (_strip(stderr) !== "") {
    out = _rstrip(out) + "\n---\n" + _rstrip(stderr);
  }
  return _squeeze_blank_lines(out);
}

/**
 * Compress `git status` output.
 *
 *  - Passes short / porcelain format (-s / --short / --porcelain) through.
 *  - Full verbose format: collapses each section's per-file listing to a
 *    grouped count, strips boilerplate advice lines, preserves branch /
 *    clean-tree / merge-conflict lines.
 *
 * Registered before GitFilter for higher-fidelity status handling.
 */
export class GitStatusVerboseFilter extends Filter {
  override name = "git-status";
  override binaries: ReadonlySet<string> = new Set(["git"]);
  override subcommands: ReadonlySet<string> = new Set(["status"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    return _compress_git_status_verbose(stdout, stderr, argv);
  }
}

// ===========================================================================
// GitBlameFilter helpers (Python lines ~7133-7304).
// ===========================================================================

// Python: re.compile(r"^([0-9a-f]{7,40})\s")
const _GIT_BLAME_LINE_RE: RegExp = /^([0-9a-f]{7,40})\s/;
// Python: re.compile(r"^\^?([0-9a-f]{7,40})\s+\(([^)]+?)\s+\d{4}-\d\d-\d\d")
const _GIT_BLAME_AUTHOR_RE: RegExp =
  /^\^?([0-9a-f]{7,40})\s+\(([^)]+?)\s+\d{4}-\d\d-\d\d/;
// Python: re.compile(r"^[0-9a-f]{40} \d+ \d+")
const _GIT_BLAME_PORCELAIN_RE: RegExp = /^[0-9a-f]{40} \d+ \d+/;
// Python: re.compile(r"^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$")
const _GIT_BLAME_PORCELAIN_HEADER_RE: RegExp = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;
// Python: re.compile(r"^author (.+)")
const _GIT_BLAME_AUTHOR_LINE_RE: RegExp = /^author (.+)/;

/**
 * Compress `git blame`: collapse consecutive same-commit runs.
 *
 * For each run of lines attributed to the same commit hash, emit the first line
 * of the run verbatim followed by a collapse marker; subsequent lines in the
 * run are dropped.
 */
export function _compress_git_blame(stdout: string, stderr: string): string {
  const lines = stdout.split("\n");
  if (lines.length === 0) {
    return stdout;
  }

  // Determine if this is porcelain format (40-hex-char at start).
  const is_porcelain = lines
    .slice(0, 5)
    .filter((ln) => _strip(ln) !== "")
    .some((ln) => _reMatch(_GIT_BLAME_PORCELAIN_RE, ln));

  if (is_porcelain) {
    return _compress_git_blame_porcelain(lines, stderr);
  }

  return _compress_git_blame_annotated(lines, stderr);
}

/** Collapse same-author runs in standard annotated blame format. */
export function _compress_git_blame_annotated(lines: string[], stderr: string): string {
  const out: string[] = [];
  let current_hash: string | null = null;
  let current_author: string | null = null;
  let run_count = 0;
  let run_start_line = "";

  const _flush = (): void => {
    if (run_count === 0) {
      return;
    }
    out.push(run_start_line);
    if (run_count > 1) {
      out.push(
        `[token-goat: ${run_count - 1} more lines by ${current_author} (${current_hash ? current_hash.slice(0, 8) : "?"})]`,
      );
    }
  };

  for (const line of lines) {
    const m = _reMatchObj(_GIT_BLAME_AUTHOR_RE, line);
    if (m) {
      const commit_hash = m[1]!.slice(0, 8);
      const author = _strip(m[2]!);
      if (commit_hash === current_hash) {
        run_count += 1;
      } else {
        _flush();
        current_hash = commit_hash;
        current_author = author;
        run_start_line = line;
        run_count = 1;
      }
    } else {
      // Non-blame line (empty, separator, etc.) — flush and emit as-is.
      _flush();
      current_hash = null;
      current_author = null;
      run_count = 0;
      run_start_line = "";
      out.push(line);
    }
  }

  _flush();
  let out_text = out.join("\n");
  if (_strip(stderr) !== "") {
    out_text += "\n---\n" + _rstrip(stderr);
  }
  return out_text;
}

/** Collapse same-commit runs in porcelain blame format (`git blame --porcelain`). */
export function _compress_git_blame_porcelain(lines: string[], stderr: string): string {
  const out: string[] = [];
  let current_hash: string | null = null;
  let current_author: string | null = null;
  let run_count = 0;
  let block_lines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = _reMatchObj(_GIT_BLAME_PORCELAIN_HEADER_RE, line);
    if (m) {
      const commit_hash = m[1]!;
      if (commit_hash === current_hash) {
        // Same commit — scan forward past this block's metadata to the content line.
        run_count += 1;
        i += 1;
        while (i < lines.length && !lines[i]!.startsWith("\t")) {
          i += 1;
        }
        i += 1; // skip the content line
        continue;
      } else {
        // New commit — flush previous run.
        if (block_lines.length > 0) {
          out.push(...block_lines);
          if (run_count > 1) {
            out.push(
              `[token-goat: ${run_count - 1} more lines by ` +
                `${current_author} (${current_hash ? current_hash.slice(0, 8) : "?"})]`,
            );
          }
        }
        // Start new block.
        current_hash = commit_hash;
        current_author = null;
        run_count = 1;
        block_lines = [line];
        i += 1;
        // Collect metadata lines until the content line.
        while (i < lines.length && !lines[i]!.startsWith("\t")) {
          const meta = lines[i]!;
          const am = _reMatchObj(_GIT_BLAME_AUTHOR_LINE_RE, meta);
          if (am) {
            current_author = _strip(am[1]!);
          }
          block_lines.push(meta);
          i += 1;
        }
        if (i < lines.length) {
          block_lines.push(lines[i]!); // content line
          i += 1;
        }
        continue;
      }
    } else {
      out.push(line);
      i += 1;
    }
  }

  // Flush final block.
  if (block_lines.length > 0) {
    out.push(...block_lines);
    if (run_count > 1) {
      out.push(
        `[token-goat: ${run_count - 1} more lines by ` +
          `${current_author} (${current_hash ? current_hash.slice(0, 8) : "?"})]`,
      );
    }
  }

  let out_text = out.join("\n");
  if (_strip(stderr) !== "") {
    out_text += "\n---\n" + _rstrip(stderr);
  }
  return out_text;
}

/**
 * Compress `git blame` output by collapsing same-commit/author runs.
 *
 * Handles both the default annotated format and --porcelain. Registered before
 * GitFilter so it claims `git blame` exclusively.
 */
export class GitBlameFilter extends Filter {
  override name = "git-blame";
  override binaries: ReadonlySet<string> = new Set(["git"]);
  override subcommands: ReadonlySet<string> = new Set(["blame"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    return _compress_git_blame(stdout, stderr);
  }
}

// ===========================================================================
// GitCommitFilter (Python lines ~7307-7446).
// ===========================================================================

// Python: re.compile(r"lefthook", re.IGNORECASE)
const _LEFTHOOK_BANNER_RE: RegExp = /lefthook/i;
// "✔️ lint (0.11 seconds)" or "✔️ lint" from lefthook summary
// Python: re.compile(r"[✔✓](?:️)?\s+(\S+)")
const _LEFTHOOK_PASS_RE: RegExp = /[✔✓](?:️)?\s+(\S+)/;
// "✖ lint" from lefthook summary when a hook fails
// Python: re.compile(r"[✖✗✘]\s+(\S+)")
const _LEFTHOOK_FAIL_RE: RegExp = /[✖✗✘]\s+(\S+)/;
// "[main d112339] feat: message"
// Python: re.compile(r"^\[(\S+)\s+([0-9a-f]+)\]\s+(.+)$")
const _GIT_COMMIT_SUMMARY_RE: RegExp = /^\[(\S+)\s+([0-9a-f]+)\]\s+(.+)$/;
// "2 files changed, 238 insertions(+), 1 deletion(-)"
// Python: re.compile(r"^\s*(\d+\s+files?\s+changed.*)")
const _GIT_COMMIT_STAT_RE: RegExp = /^\s*(\d+\s+files?\s+changed.*)/;
// Pure-dot progress lines emitted by lefthook/pytest runners (e.g. "......[100%]")
// Python: re.compile(r"^[.\s]+(?:\[\s*\d+%\])?$")
const _DOT_LINE_RE: RegExp = /^[.\s]+(?:\[\s*\d+%\])?$/;

/**
 * Compress `git commit` output.
 *
 * When lefthook is present, collapse the hook-runner banner and per-hook
 * progress lines into a one-line summary. The commit ref line and files-changed
 * stat are always preserved. On hook failure the error block is kept but
 * stripped of pure-dot progress lines.
 */
export function _compress_git_commit(stdout: string, stderr: string): string {
  const merged =
    _strip(stderr) !== "" ? _strip(_rstrip(stdout) + "\n" + _rstrip(stderr)) : stdout;

  // Use splitlines() instead of split('\n') to handle both CRLF and LF.
  const lines = _splitlines(merged);
  const has_lefthook = lines.some((ln) => _reSearch(_LEFTHOOK_BANNER_RE, ln));

  // Extract always-useful commit summary lines (present regardless of lefthook).
  let commit_line = "";
  let stat_line = "";
  for (const ln of lines) {
    if (!commit_line) {
      const m = _reMatchObj(_GIT_COMMIT_SUMMARY_RE, _strip(ln));
      if (m) {
        commit_line = _strip(ln);
      }
    }
    if (!stat_line) {
      const m2 = _reMatchObj(_GIT_COMMIT_STAT_RE, ln);
      if (m2) {
        stat_line = _strip(m2[1]!);
      }
    }
  }

  if (!has_lefthook) {
    // No lefthook — output is already short; passthrough.
    return merged;
  }

  // Detect hook failures and passes: extract ANY "✔️ name" or "✖ name" lines.
  const fail_hooks: string[] = [];
  const pass_hooks: string[] = [];
  for (const ln of lines) {
    const fm = _reSearchObj(_LEFTHOOK_FAIL_RE, ln);
    if (fm) {
      fail_hooks.push(fm[1]!);
    }
    const pm = _reSearchObj(_LEFTHOOK_PASS_RE, ln);
    if (pm && !fm) {
      const name = pm[1]!;
      // Avoid duplicate (e.g. same hook listed twice in verbose output).
      if (!pass_hooks.includes(name)) {
        pass_hooks.push(name);
      }
    }
  }

  if (fail_hooks.length > 0) {
    // Keep the output but strip pure-dot progress lines (e.g. pytest dots).
    const kept = lines.filter((ln) => !_reMatch(_DOT_LINE_RE, ln));
    return kept.join("\n");
  }

  // All hooks passed — build one-line summary.
  const hook_parts = pass_hooks.map((h) => `✔ ${h}`).join(" ");
  const parts: string[] = [];
  if (hook_parts) {
    parts.push(`pre-commit ${hook_parts}`);
  }
  if (commit_line) {
    parts.push(commit_line);
  }
  if (stat_line) {
    parts.push(stat_line);
  }
  return parts.length > 0 ? parts.join(" | ") : merged;
}

/**
 * Compress `git commit` output, especially when lefthook is configured.
 *
 * Matches `git commit`, `git commit --amend`, and `git commit --fixup`.
 * Registered before GitFilter so it claims `git commit` exclusively.
 */
export class GitCommitFilter extends Filter {
  override name = "git-commit";
  override binaries: ReadonlySet<string> = new Set(["git"]);
  override subcommands: ReadonlySet<string> = new Set(["commit"]);

  /** Match `git commit` with any variant including --amend, --fixup. */
  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    if (!this.binaries.has(stem) && !this.binaries.has(name)) {
      return false;
    }
    if (this.subcommands.size === 0) {
      return true;
    }
    // Check if any of the first 3 positional args is "commit".
    const positionals = _positional_args(argv.slice(1));
    return positionals.slice(0, 3).some((tok) => this.subcommands.has(tok));
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    return _compress_git_commit(stdout, stderr);
  }
}

// ===========================================================================
// GitPushFilter (Python lines ~7449-7801).
// ===========================================================================

// Matches pure-dot/progress pytest output lines.
// Python: re.compile(r"^[.sF ]+(?:\[\s*\d+%\])?$")
const _PYTEST_DOT_LINE_RE: RegExp = /^[.sF ]+(?:\[\s*\d+%\])?$/;
// Final pytest summary: "8333 passed in 5m 30s" or "3 failed, 8330 passed in ..."
// Python: re.compile(r"(\d+\s+(?:failed|passed|error(?:ed)?|warning)[,\s].*?
//   (?:in\s+[\d:]+[smh.]+)?)", re.IGNORECASE)
const _PYTEST_SUMMARY_RE: RegExp =
  /(\d+\s+(?:failed|passed|error(?:ed)?|warning)[,\s].*?(?:in\s+[\d:]+[smh.]+)?)/i;
// Git push ref-update lines: "   abc123..def456  main -> origin/main"
// Python: re.compile(r"^\s*(?:To\s|->|\+|\*|!|\s+[0-9a-f]+\.\.[0-9a-f]+)")
const _GIT_PUSH_REF_RE: RegExp = /^\s*(?:To\s|->|\+|\*|!|\s+[0-9a-f]+\.\.[0-9a-f]+)/;
// Branch tracking line: "Branch 'main' set up to track remote branch 'main'"
// Python: re.compile(r"^Branch\s+'[^']+'\s+set\s+up\s+to\s+track")
const _GIT_PUSH_TRACK_RE: RegExp = /^Branch\s+'[^']+'\s+set\s+up\s+to\s+track/;
// Remote-side object-transfer progress.
// Python: re.compile(r"^remote:\s+(?:Resolving deltas|Enumerating objects
//   |Counting objects|Compressing objects|Writing objects):\s+\d+%")
const _GIT_REMOTE_PROGRESS_RE: RegExp =
  /^remote:\s+(?:Resolving deltas|Enumerating objects|Counting objects|Compressing objects|Writing objects):\s+\d+%/;
// Local client-side progress.
// Python: re.compile(r"^(?:Enumerating objects|Counting objects
//   |Compressing objects|Writing objects):\s+\d+%")
const _GIT_LOCAL_PROGRESS_RE: RegExp =
  /^(?:Enumerating objects|Counting objects|Compressing objects|Writing objects):\s+\d+%/;
// Blank remote line with no content after the colon: "remote: " or "remote:"
// Python: re.compile(r"^remote:\s*$")
const _GIT_REMOTE_BLANK_RE: RegExp = /^remote:\s*$/;

// Pre-push hook task-runner trigger lines.
// Python: re.compile(r"^\s*(?:>\s+|❯\s+|\$\s+)?
//   (?:lefthook|husky|pre-commit|simple-git-hooks)\b|^\s*>\s+\S+@", re.IGNORECASE)
const _PREPUSH_HOOK_TRIGGER_RE: RegExp =
  /^\s*(?:>\s+|❯\s+|\$\s+)?(?:lefthook|husky|pre-commit|simple-git-hooks)\b|^\s*>\s+\S+@/i;
// Bundler signature lines proving a pre-push block contains build output.
// Python: re.compile(r"^\s*vite\s+v[\d.]+|building for production
//   |modules?\s+transformed|rendering chunks|computing gzip size
//   |transforming\s*\(|^\s*webpack\s+\d[\d.]+\s+compiled
//   |^\s*(?:Asset|asset)\s+\S+\s+\d
//   |^\s*[\w./-]+\.(?:js|css|html|mjs|map|svg|png|woff2?)\s+[\d.]+\s*(?:k|m|g)?i?b\b
//   |gzip:\s*[\d.]+\s*(?:k|m|g)?i?b|^\s*[⚡✨]?\s*esbuild", re.IGNORECASE)
const _BUNDLER_SIGNATURE_RE: RegExp =
  /^\s*vite\s+v[\d.]+|building for production|modules?\s+transformed|rendering chunks|computing gzip size|transforming\s*\(|^\s*webpack\s+\d[\d.]+\s+compiled|^\s*(?:Asset|asset)\s+\S+\s+\d|^\s*[\w./-]+\.(?:js|css|html|mjs|map|svg|png|woff2?)\s+[\d.]+\s*(?:k|m|g)?i?b\b|gzip:\s*[\d.]+\s*(?:k|m|g)?i?b|^\s*[⚡✨]?\s*esbuild/i;
// Lines inside a bundler block that are pure progress/noise.
// Python: re.compile(r"building for production
//   |^\s*[✓√]?\s*\d+\s+modules?\s+transformed|rendering chunks
//   |computing gzip size|^\s*transforming\s*\(
//   |^\s*[\w./-]+\.(?:js|css|html|mjs|map|svg|png|woff2?)\s+[\d.]+\s*(?:k|m|g)?i?b\b
//   |^\s+\./node_modules/|^\s*modules by path
//   |^\s+\+\s+\d+\s+modules?\s*$|^\s*runtime modules\s", re.IGNORECASE)
const _BUNDLER_NOISE_RE: RegExp =
  /building for production|^\s*[✓√]?\s*\d+\s+modules?\s+transformed|rendering chunks|computing gzip size|^\s*transforming\s*\(|^\s*[\w./-]+\.(?:js|css|html|mjs|map|svg|png|woff2?)\s+[\d.]+\s*(?:k|m|g)?i?b\b|^\s+\.\/node_modules\/|^\s*modules by path|^\s+\+\s+\d+\s+modules?\s*$|^\s*runtime modules\s/i;
// Final bundler success markers — kept (one line) as the block's outcome.
// Python: re.compile(r"^\s*[✓√]\s+built in\s
//   |^\s*webpack\s+\d[\d.]+\s+compiled\s+successfully
//   |^\s*[⚡✨]\s+Done in\s", re.IGNORECASE)
const _BUNDLER_DONE_RE: RegExp =
  /^\s*[✓√]\s+built in\s|^\s*webpack\s+\d[\d.]+\s+compiled\s+successfully|^\s*[⚡✨]\s+Done in\s/i;
// Inline stage regex used by _compress_git_push_remote_progress.
// Python: re.match(r"^(?:remote:\s+)?(\w[\w ]+?):\s+\d+%", stripped)
const _GIT_PUSH_STAGE_RE: RegExp = /^(?:remote:\s+)?(\w[\w ]+?):\s+\d+%/;

/**
 * Collapse a pre-push hook's bundler output inside `git push` capture.
 *
 * Detects the contiguous bundler block, drops the noise rows (asset tables,
 * module lists, transform/render progress), and replaces them with a single
 * `[pre-push hook: bundler output suppressed — N lines]` summary.
 *
 * Preserved verbatim: the hook-trigger line, any error/warning lines, the final
 * bundler success marker, and all git push output. When no bundler signature is
 * present the input is returned unchanged.
 */
export function _compress_git_push_bundler(lines: string[]): string[] {
  if (!lines.some((ln) => _reSearch(_BUNDLER_SIGNATURE_RE, ln))) {
    return lines;
  }

  const result: string[] = [];
  let suppressed = 0;

  const _flush = (): void => {
    if (suppressed) {
      const plural = suppressed !== 1 ? "s" : "";
      result.push(`[pre-push hook: bundler output suppressed — ${suppressed} line${plural}]`);
      suppressed = 0;
    }
  };

  for (const ln of lines) {
    const stripped = _rstrip(ln);
    // Git push result lines and the hook trigger always survive; flush any
    // pending suppression summary first so ordering is preserved.
    if (
      _reMatch(_GIT_PUSH_REF_RE, stripped) ||
      _reMatch(_GIT_PUSH_TRACK_RE, stripped) ||
      _reMatch(_PREPUSH_HOOK_TRIGGER_RE, stripped) ||
      _reMatch(_BUNDLER_DONE_RE, stripped)
    ) {
      _flush();
      result.push(stripped);
      continue;
    }
    // Surface errors/warnings unconditionally — a failed build must show.
    if (_reSearch(_ERROR_SIGNAL_RE, stripped) && !_reSearch(_BUNDLER_NOISE_RE, stripped)) {
      _flush();
      result.push(stripped);
      continue;
    }
    if (_reSearch(_BUNDLER_NOISE_RE, stripped) || _reSearch(_BUNDLER_SIGNATURE_RE, stripped)) {
      suppressed += 1;
      continue;
    }
    // Blank lines inside the block fold into the suppression count rather than
    // fragmenting the summary; blank lines outside pass through.
    if (!stripped) {
      if (suppressed) {
        suppressed += 1;
        continue;
      }
      result.push(stripped);
      continue;
    }
    _flush();
    result.push(stripped);
  }

  _flush();
  return result;
}

/**
 * Collapse repeated remote/local git-push percentage-progress lines.
 *
 * Only the final line for each consecutive run of the same stage is kept;
 * intermediate lines are silently dropped. Blank `remote:` lines are also
 * dropped. All other lines pass through unchanged.
 */
export function _compress_git_push_remote_progress(lines: string[]): string[] {
  const result: string[] = [];
  let current_stage = "";
  let stage_last_line = "";

  const _flush = (): void => {
    if (stage_last_line) {
      result.push(stage_last_line);
    }
    current_stage = "";
    stage_last_line = "";
  };

  for (const ln of lines) {
    const stripped = _rstrip(ln);
    if (_reMatch(_GIT_REMOTE_PROGRESS_RE, stripped) || _reMatch(_GIT_LOCAL_PROGRESS_RE, stripped)) {
      const m = _reMatchObj(_GIT_PUSH_STAGE_RE, stripped);
      const stage = m ? _strip(m[1]!) : "?";
      if (stage !== current_stage) {
        _flush();
        current_stage = stage;
      }
      stage_last_line = stripped;
    } else if (_reMatch(_GIT_REMOTE_BLANK_RE, stripped)) {
      _flush();
      // Drop blank "remote:" lines — they are visual padding.
    } else {
      _flush();
      result.push(stripped);
    }
  }

  _flush();
  return result;
}

/**
 * Compress `git push` output.
 *
 * Handles three distinct sources of verbosity: verbose remote/local progress;
 * pre-push hook runs pytest; pre-push hook runs a bundler. The cases may occur
 * together. When none is present the output passes through unchanged.
 */
export function _compress_git_push(stdout: string, stderr: string): string {
  const merged =
    _strip(stderr) !== "" ? _strip(_rstrip(stdout) + "\n" + _rstrip(stderr)) : stdout;
  // Use splitlines() instead of split('\n') to handle both CRLF and LF.
  let lines = _splitlines(merged);

  // Detect which compression paths are needed.
  const has_dot_lines = lines.some((ln) => _reMatch(_PYTEST_DOT_LINE_RE, ln));
  const has_remote_progress = lines.some(
    (ln) =>
      _reMatch(_GIT_REMOTE_PROGRESS_RE, _rstrip(ln)) ||
      _reMatch(_GIT_LOCAL_PROGRESS_RE, _rstrip(ln)),
  );
  const has_bundler = lines.some((ln) => _reSearch(_BUNDLER_SIGNATURE_RE, ln));

  if (!has_dot_lines && !has_remote_progress && !has_bundler) {
    // Nothing to compress; standard passthrough.
    return merged;
  }

  // Always apply remote/local progress compression first — it is a no-op when no
  // progress lines exist, and it reduces line count before the pytest path runs.
  if (has_remote_progress) {
    lines = _compress_git_push_remote_progress(lines);
  }

  // Collapse any pre-push bundler block before the pytest path — a no-op when no
  // bundler signature is present.
  if (has_bundler) {
    lines = _compress_git_push_bundler(lines);
  }

  // Re-check for pytest dots after remote/bundler compression.
  const dot_lines = lines.filter((ln) => _reMatch(_PYTEST_DOT_LINE_RE, ln));
  if (dot_lines.length === 0) {
    // Only remote/local progress and/or bundler output was present — already
    // compressed.
    return lines.join("\n");
  }

  // --- Pytest pre-push hook path ---
  // Extract pytest summary line (last matching line wins — it's the total).
  let pytest_summary = "";
  for (const ln of lines) {
    if (_reMatch(_PYTEST_DOT_LINE_RE, ln)) {
      continue;
    }
    const m = _reSearchObj(_PYTEST_SUMMARY_RE, ln);
    if (m && (ln.toLowerCase().includes("passed") || ln.toLowerCase().includes("failed"))) {
      pytest_summary = _strip(ln);
    }
  }

  // Extract push result lines.
  const push_lines = lines
    .filter((ln) => _reMatch(_GIT_PUSH_REF_RE, ln) || _reMatch(_GIT_PUSH_TRACK_RE, ln))
    .map((ln) => _strip(ln));

  // Detect failures.
  const failed = pytest_summary ? pytest_summary.toLowerCase().includes("failed") : false;

  if (failed) {
    // Keep dot-free output but preserve the error block (first FAILED test).
    const kept: string[] = [];
    let in_error = false;
    let error_lines_kept = 0;
    const _MAX_ERROR_LINES = 30;
    for (const ln of lines) {
      if (_reMatch(_PYTEST_DOT_LINE_RE, ln)) {
        continue;
      }
      if (ln.includes("FAILED") || ln.includes("ERROR") || _reSearch(_ERROR_SIGNAL_RE, ln)) {
        in_error = true;
      }
      if (in_error && error_lines_kept < _MAX_ERROR_LINES) {
        kept.push(ln);
        error_lines_kept += 1;
      } else if (!in_error) {
        kept.push(ln);
      }
    }
    const summary_prefix = pytest_summary ? `pre-push FAILED: ${pytest_summary}` : "pre-push FAILED";
    return summary_prefix + "\n" + kept.join("\n");
  }

  // All tests passed — build 1-2 line summary.
  const parts: string[] = [];
  if (pytest_summary) {
    parts.push(`pre-push ✔ ${pytest_summary}`);
  }
  if (push_lines.length > 0) {
    parts.push("pushed " + push_lines.join(" | "));
  }
  return parts.length > 0 ? parts.join("\n") : lines.join("\n");
}

/**
 * Compress `git push` output.
 *
 * Handles verbose object-transfer progress, pre-push hook pytest runs, and
 * pre-push hook bundler runs. When none of these patterns is detected the output
 * is passed through unchanged. Registered before GitFilter so it claims
 * `git push` exclusively.
 */
export class GitPushFilter extends Filter {
  override name = "git-push";
  override binaries: ReadonlySet<string> = new Set(["git"]);
  override subcommands: ReadonlySet<string> = new Set(["push"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    return _compress_git_push(stdout, stderr);
  }
}

// ===========================================================================
// Re-exported regexes / constants that the Python __all__ surface and/or the
// porting tests reference by name (so a later test module can import them).
// ===========================================================================

export {
  _ERROR_SIGNAL_RE,
  _GIT_STATUS_HEADER_RE,
  _GIT_LOG_COMMIT_RE,
  _GIT_DIFF_FILE_RE,
  _GIT_DIFF_HUNK_RE,
  _GIT_REMOTE_KEEP_RE,
  _GIT_REMOTE_DROP_RE,
  _GIT_LOG_ONELINE_RE,
  _GIT_LOG_DIFF_HUNK_RE,
  _GIT_LOG_MERGE_RE,
  _GIT_LOG_STAT_SUMMARY_RE,
  _GIT_LOG_AUTHOR_RE,
  _GIT_LOG_DATE_RE,
  _SHORT_STATUS_RE,
  _GIT_STATUS_SECTION_RE,
  _GIT_STATUS_SECTION_KEYS,
  _GIT_STATUS_ADVICE_RE,
  _GIT_BLAME_LINE_RE,
  _GIT_BLAME_AUTHOR_RE,
  _GIT_BLAME_PORCELAIN_RE,
  _GIT_BLAME_PORCELAIN_HEADER_RE,
  _GIT_BLAME_AUTHOR_LINE_RE,
  _LEFTHOOK_BANNER_RE,
  _LEFTHOOK_PASS_RE,
  _LEFTHOOK_FAIL_RE,
  _GIT_COMMIT_SUMMARY_RE,
  _GIT_COMMIT_STAT_RE,
  _DOT_LINE_RE,
  _PYTEST_DOT_LINE_RE,
  _PYTEST_SUMMARY_RE,
  _GIT_PUSH_REF_RE,
  _GIT_PUSH_TRACK_RE,
  _GIT_REMOTE_PROGRESS_RE,
  _GIT_LOCAL_PROGRESS_RE,
  _GIT_REMOTE_BLANK_RE,
  _PREPUSH_HOOK_TRIGGER_RE,
  _BUNDLER_SIGNATURE_RE,
  _BUNDLER_NOISE_RE,
  _BUNDLER_DONE_RE,
};
