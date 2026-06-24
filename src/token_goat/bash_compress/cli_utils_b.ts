/**
 * bash_compress CLI UTILS-B FILTERS — TypeScript port of the BatFilter,
 * DeltaFilter, FzfFilter, LazyGitFilter, JqFilter, and YqFilter subclasses
 * from src/token_goat/bash_compress.py (Python lines ~11883-12154).
 *
 * Six filters subclass the concrete Filter base from ./framework.js:
 *   - BatFilter    — `bat` / `batcat` syntax-highlighted file viewer. Strips
 *                    ANSI + decorative box-drawing borders; pass-through <= 50
 *                    non-empty lines, else head=40 / tail=10.
 *   - DeltaFilter  — `delta` diff viewer. Strips ANSI + runs of ─/━ separators;
 *                    pass-through <= 80 non-empty lines, else head=60 / tail=20.
 *   - FzfFilter    — `fzf` fuzzy finder. Pass-through <= 50 non-empty lines,
 *                    else head=40 / tail=10. (Default binaries-based matches().)
 *   - LazyGitFilter — `lazygit` TUI. When output is empty OR contains ANSI
 *                    cursor/colour escapes, emit a single "run it in a terminal"
 *                    note; otherwise pass through (rstrip). (Default matches().)
 *   - JqFilter     — `jq` JSON processor. Pass-through <= 200 non-empty lines,
 *                    else head=150 / tail=50.
 *   - YqFilter     — `yq` YAML processor. Pass-through <= 150 non-empty lines,
 *                    else head=100 / tail=50.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress). There are NO module-private regex
 *    constants and NO _compress_* helpers in this group — every filter is a
 *    straight pass-through / head-tail compressor, so the only locals are the
 *    two Python-builtin shims (_pathStemLower, _rstrip).
 *  - re.compile(...) -> N/A here (no regexes). The bat/delta border-line test
 *    is a pure `set(c)` membership check, reproduced verbatim as a Set<char>.
 *  - Python Path(argv[0]).stem.lower() -> local _pathStemLower (final path
 *    component with its LAST suffix removed, lowercased). Matches framework
 *    _pathStemLower semantics (a leading-dot dotfile keeps its name).
 *  - Python str.rstrip() -> local _rstrip (strip trailing ASCII+Unicode
 *    whitespace). Python str.strip() -> String.prototype.trim() (JS trim covers
 *    the same whitespace class for the ASCII-range chars these filters emit).
 *  - Python `[ln for ln in lines if ln.strip()]` -> lines.filter(non-empty).
 *  - Python `"\x1b[" in merged or "\x1b(" in merged` (LazyGitFilter) ->
 *    merged.includes("\x1b[") || merged.includes("\x1b(") — the ESC byte is
 *    written as the \x1b escape, NOT a literal U+001B (which would also work
 *    but the escape is clearer and avoids any editor normalisation surprise).
 *  - strip_ansi / normalise / _head_tail_compress are framework-PUBLIC and
 *    imported. BatFilter and DeltaFilter call strip_ansi(merged) EXPLICITLY and
 *    then normalise(text) LATER — normalise internally calls strip_ansi again,
 *    so the first call is REDUNDANT, but it is reproduced FAITHFULLY (the Python
 *    source does exactly this; dropping the first call would diverge on any
 *    future normalise() change that skipped ansi stripping).
 *  - BatFilter border-character set: the Python literal
 *    "─━─┬┴┌┐└┘│├┤┼═╔╗╚╝║╠╡╢╣╤╥╦╧╨╩" contains a DUPLICATE ─ and an ASCII "-".
 *    Both are reproduced VERBATIM in _BAT_BORDER_CHARS (the duplicate is
 *    harmless inside a Set but kept to mirror the source exactly).
 *  - The BatFilter header/footer trim checks `"──" in stripped_lines[0]` —
 *    reproduced as `.includes("──")` (two U+2500 box-drawing horizontal chars).
 *  - cap_tokens is NOT used by any of these six filters (Python relies solely
 *    on _head_tail_compress for the summarise branch), so it is not imported.
 *
 * MODULE-GLOBAL STATE: none. Every filter is stateless; the only module-level
 * values are the two immutable char sets (_BAT_BORDER_CHARS, _DELTA_SEP_CHARS).
 * No registerReset is wired (mirrors node_pm.ts / pkg.ts).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on ->
 * nothing imported here is type-only. noImplicitOverride is on -> every
 * overridden member carries `override`.
 */

import {
  Filter,
  _head_tail_compress,
  normalise,
  strip_ansi,
} from "./framework.js";

// ===========================================================================
// Internal Python-builtin shims local to this module.
// ===========================================================================

/**
 * pathlib.Path(p).stem.lower() — the lowercased final path component with its
 * LAST suffix removed. Matches framework._pathStemLower semantics (a leading-dot
 * dotfile keeps its name; a trailing dot is not a suffix).
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

/** Python str.rstrip() — strip trailing ASCII+Unicode whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

// ===========================================================================
// bat — border / separator character sets (Python ~11921, ~11982).
// ===========================================================================

/**
 * bat decorative box-drawing border characters. A line whose every non-space
 * char is in this set is bat's header/footer border and is dropped.
 *
 * Reproduced VERBATIM from the Python literal (which itself contains a duplicate
 * ─ and an ASCII "-"); the Set dedupes at construction time but the source
 * string is mirrored exactly. Includes Unicode box-drawing (─━│┌┐└┘├┤┬┴┼ and
 * the double-line set ═║╔╗╚╝╠╣╡╢╤╥╦╧╨╩) plus the ASCII hyphen.
 */
const _BAT_BORDER_CHARS: ReadonlySet<string> = new Set(
  "─━─┬┴┌┐└┘│├┤┼═╔╗╚╝║╠╡╢╣╤╥╦╧╨╩".split(""),
);

/**
 * delta decorative separator characters. A line whose every non-space char is
 * one of these (─ U+2500 or ━ U+2501) is a delta separator and is dropped.
 */
const _DELTA_SEP_CHARS: ReadonlySet<string> = new Set("─━".split(""));

/** True when every char of s is in the allowed set (Python `all(c in set ...)`). */
function _allCharsIn(s: string, allowed: ReadonlySet<string>): boolean {
  for (const ch of s) {
    if (!allowed.has(ch)) {
      return false;
    }
  }
  return true;
}

// ===========================================================================
// BatFilter (Python ~11883-11940)
// ===========================================================================

/**
 * Compress `bat` / `batcat` syntax-highlighted file viewer output.
 *
 * Strips the decorative chrome (ANSI codes, box-drawing borders, header/footer
 * lines) and preserves only the file content. Pass-through when the normalised
 * output has <= 50 non-empty lines; otherwise keep first 40 + last 10 + an
 * elision marker.
 */
export class BatFilter extends Filter {
  override name = "bat";
  override binaries: ReadonlySet<string> = new Set(["bat", "batcat"]);

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

    // Strip ANSI escape sequences. (normalise() below will strip again — the
    // redundancy is faithful to the Python source.)
    const ansi_stripped = strip_ansi(merged);

    // Strip bat's decorative box-drawing borders (lines made entirely of ─, ━,
    // ═, │, etc.). A line qualifies when it is non-blank and EVERY char of its
    // .strip() form is a known border char.
    const lines = ansi_stripped.split("\n");
    const stripped_lines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== "" && _allCharsIn(trimmed, _BAT_BORDER_CHARS)) {
        continue;
      }
      stripped_lines.push(line);
    }

    // Remove first and last lines if they appear to be headers/footers.
    if (stripped_lines.length > 0) {
      const first = stripped_lines[0]!;
      if (first.trim() === "" || first.includes("──")) {
        stripped_lines.shift();
      }
    }
    if (stripped_lines.length > 0) {
      const last = stripped_lines[stripped_lines.length - 1]!;
      if (last.trim() === "" || last.includes("──")) {
        stripped_lines.pop();
      }
    }

    const joined = stripped_lines.join("\n");
    const text = normalise(joined);

    const norm_lines = text.split("\n");
    const non_empty = norm_lines.filter((ln) => ln.trim() !== "");

    if (non_empty.length <= 50) {
      return _rstrip(text);
    }

    return _rstrip(_head_tail_compress(non_empty, 40, 10, "lines"));
  }
}

// ===========================================================================
// DeltaFilter (Python ~11945-11995)
// ===========================================================================

/**
 * Compress `delta` diff viewer output.
 *
 * Strips ANSI codes and decorative separator lines (runs of ─ / ━), preserving
 * the underlying diff content. Pass-through when the normalised output has
 * <= 80 non-empty lines; otherwise keep first 60 + last 20 + an elision marker.
 */
export class DeltaFilter extends Filter {
  override name = "delta";
  override binaries: ReadonlySet<string> = new Set(["delta"]);

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

    // Strip ANSI escape sequences. (Redundant with normalise() below — faithful.)
    const ansi_stripped = strip_ansi(merged);

    // Remove decorative separator lines (runs of ─ / ━).
    const lines = ansi_stripped.split("\n");
    const stripped_lines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== "" && _allCharsIn(trimmed, _DELTA_SEP_CHARS)) {
        continue;
      }
      stripped_lines.push(line);
    }

    const joined = stripped_lines.join("\n");
    const text = normalise(joined);

    const norm_lines = text.split("\n");
    const non_empty = norm_lines.filter((ln) => ln.trim() !== "");

    if (non_empty.length <= 80) {
      return _rstrip(text);
    }

    return _rstrip(_head_tail_compress(non_empty, 60, 20, "lines"));
  }
}

// ===========================================================================
// FzfFilter (Python ~12000-12032)
// ===========================================================================

/**
 * Compress `fzf` fuzzy finder output.
 *
 * fzf output is typically compact (1–5 lines); pass-through when the normalised
 * output has <= 50 non-empty lines, otherwise keep first 40 + last 10 + an
 * elision marker. Uses the default binaries-based matches() (no override).
 */
export class FzfFilter extends Filter {
  override name = "fzf";
  override binaries: ReadonlySet<string> = new Set(["fzf"]);

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const text = normalise(merged);

    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => ln.trim() !== "");

    if (non_empty.length <= 50) {
      return _rstrip(text);
    }

    return _rstrip(_head_tail_compress(non_empty, 40, 10, "lines"));
  }
}

// ===========================================================================
// LazyGitFilter (Python ~12037-12073)
// ===========================================================================

/**
 * Compress `lazygit` terminal UI output.
 *
 * lazygit is an interactive TUI; run non-interactively (piped / no TTY) it emits
 * terminal control sequences and incomplete state dumps. When the merged output
 * is empty OR contains ANSI cursor/colour escapes, emit a single helpful note
 * instead of confusing the agent with raw terminal data. Otherwise (plain text,
 * unusual) pass through with trailing whitespace stripped. Uses the default
 * binaries-based matches() (no override).
 */
export class LazyGitFilter extends Filter {
  override name = "lazygit";
  override binaries: ReadonlySet<string> = new Set(["lazygit"]);

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);

    // Check for terminal control sequences (ANSI escapes). The ESC byte (U+001B)
    // is written as the \x1b escape to avoid embedding a raw control char.
    const has_ansi = merged.includes("\x1b[") || merged.includes("\x1b(");
    const is_empty = merged.trim() === "";

    if (is_empty || has_ansi) {
      // lazygit is a terminal UI — not meant to be run non-interactively.
      return "[lazygit is an interactive terminal UI — run it in a terminal session, not piped]";
    }

    // Plain text (unusual for lazygit, but pass through).
    return _rstrip(merged);
  }
}

// ===========================================================================
// JqFilter (Python ~12078-12114)
// ===========================================================================

/**
 * Compress `jq` JSON processor output.
 *
 * jq emits pretty-printed JSON that is already compact; compression mainly caps
 * large/deeply-nested structures. Pass-through when the normalised output has
 * <= 200 non-empty lines; otherwise keep first 150 + last 50 + an elision marker.
 */
export class JqFilter extends Filter {
  override name = "jq";
  override binaries: ReadonlySet<string> = new Set(["jq"]);

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
    const non_empty = lines.filter((ln) => ln.trim() !== "");

    if (non_empty.length <= 200) {
      return _rstrip(text);
    }

    return _rstrip(_head_tail_compress(non_empty, 150, 50, "lines"));
  }
}

// ===========================================================================
// YqFilter (Python ~12119-12154)
// ===========================================================================

/**
 * Compress `yq` YAML processor output.
 *
 * yq emits pretty-printed YAML / structured output that is already compact;
 * compression mainly caps large structures. Pass-through when the normalised
 * output has <= 150 non-empty lines; otherwise keep first 100 + last 50 + an
 * elision marker.
 */
export class YqFilter extends Filter {
  override name = "yq";
  override binaries: ReadonlySet<string> = new Set(["yq"]);

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
    const non_empty = lines.filter((ln) => ln.trim() !== "");

    if (non_empty.length <= 150) {
      return _rstrip(text);
    }

    return _rstrip(_head_tail_compress(non_empty, 100, 50, "lines"));
  }
}
