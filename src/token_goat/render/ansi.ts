/**
 * ANSI 24-bit colour primitives and text-alignment helpers for terminal
 * rendering.
 *
 * Faithful, byte-for-byte port of src/token_goat/render/ansi.py. Pure,
 * dependency-free, sync. No relative imports outside this package.
 *
 * Exports (mirroring the Python `__all__`):
 *   - fg / bg        : 24-bit foreground/background SGR escape builders.
 *   - vlen           : visible (non-ANSI) length of a string.
 *   - padR / padL    : pad ANSI-coded strings to a fixed visible width.
 *   - lerpRgb        : linear interpolation between two RGB triples.
 *   - stripAnsi      : strip all ANSI/VT escapes + Private-Use-Area icons.
 *   - fmtBytes       : plain-text human-readable byte count (no ANSI codes).
 *   - colorStdout / colorStderr : TTY + NO_COLOR probe per stream.
 *   - C              : shared colour palette (GitHub dark-inspired green accent).
 *   - RESET          : canonical SGR reset escape (`\x1b[0m`).
 *   - USE_COLOR      : true when stdout is a TTY and NO_COLOR is unset.
 *
 * Parity notes:
 *   - fg/bg build their escape sequences with the EXACT same template literals
 *     as ansi.py (`\x1b[38;2;r;g;bm` / `\x1b[48;2;r;g;bm`). The Python tests
 *     assert these byte sequences directly, so they are load-bearing.
 *   - lerpRgb uses Math.round on each component. Python's round() is
 *     banker's-rounding (round-half-to-even) while Math.round is
 *     round-half-up; for every value the tests assert (t in {0, 0.2, 0.5, 1}
 *     over the given endpoints) both modes produce the same integer, so the
 *     parity is exact on the tested inputs and on the colour-gradient stops in
 *     C (which interpolate between integer endpoints at clean fractions).
 *   - stripAnsi reproduces the three layers of ansi.py.strip_ansi in order:
 *       (1) ESC-byte fast path (`\x1b` not in s -> return s unchanged). The
 *           PUA layer is skipped on this path, matching the Python design
 *           tradeoff (PUA is rare in bash output; scanning for it would
 *           negate the ~10x speedup).
 *       (2) four-alternation regex: CSI | OSC | DCS/SOS/PM/APC | 2-byte ESC.
 *           The alternations and char classes are copied verbatim from the
 *           Python VERBOSE pattern (see _ANSI_ESCAPE_RE) — same ordering
 *           matters: CSI must come before the 2-byte fallback so the CSI
 *           branch wins on `\x1b[...`.
 *       (3) Private-Use-Area strip: U+E000–U+F8FF (BMP) and U+F0000–U+FFFDD
 *           (supplementary PUA). Copied verbatim.
 *   - vlen reproduces ansi.py.vlen: it strips via the four-alternation regex
 *     only — NOT the PUA layer. This divergence from stripAnsi is deliberate
 *     (a PUA icon occupies a terminal cell, so it counts toward visible
 *     width for padding). padR/padL build on vlen, so they inherit this.
 *   - USE_COLOR is computed once at module load from process.stdout.isTTY
 *     and the NO_COLOR env var (no-color.org convention: presence of the env
 *     var — any value, including empty string — disables colour). Callers
 *     that need a live re-check (e.g. after stdout is redirected at runtime)
 *     should call colorStdout() instead; USE_COLOR mirrors Python's
 *     module-level `USE_COLOR: bool = color_stdout()` which is evaluated
 *     once at import.
 *   - C is a plain object literal, not a class: the Python `C` was a class
 *     with only class attributes (no methods, no __init__), so an object
 *     literal preserves the exact same shape (`C.GREEN1` reads a fixed RGB)
 *     with no allocation per access. Every RGB value is copied verbatim from
 *     ansi.py including the inline hex comment.
 *
 * Non-ported surface (intentionally out of scope for this layer):
 *   - This module does NOT register a reset fn with reset.ts. ansi.py owns no
 *     mutable module-global cache (USE_COLOR is computed once and frozen for
 *     the process lifetime, exactly as Python does); there is nothing for
 *     clearModuleCaches() to wipe here. See reset.ts parity notes for why
 *     every other port module does register.
 */

// ===========================================================================
// Environment: TTY + NO_COLOR probe.
// ===========================================================================
// Python's _color_stream(stream) returns True iff NO_COLOR is unset AND the
// stream's isatty() returns True. We mirror both halves: NO_COLOR presence
// (any value, even "") disables colour per the no-color.org convention; the
// isatty check gates on the actual stream.

/**
 * Return true when the given stream is a TTY and the NO_COLOR env-var is unset.
 *
 * Follows the no-color.org convention: any value of NO_COLOR (including the
 * empty string) disables colour. Shared by colorStdout and colorStderr so the
 * rule lives in one place — the direct port of ansi.py's _color_stream.
 *
 * @param stream A Node stream-like object with an optional isatty() method.
 */
function _colorStream(stream: { isatty?(): boolean }): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  const isatty = stream.isatty;
  return Boolean(isatty && isatty.call(stream));
}

/**
 * Return true when stdout supports ANSI colour.
 *
 * Checks both process.stdout.isatty() and the NO_COLOR env-var per the
 * no-color.org convention. Use for output written to stdout (stats panels,
 * map output, etc.).
 */
export function colorStdout(): boolean {
  // process.stdout is typed as `WriteStream & { fd: 1 }` (@types/node), which
  // shares no structurally-visible member with the helper's narrow param type;
  // the cast is cosmetic — the stream does expose isatty() at runtime.
  return _colorStream(process.stdout as unknown as { isatty?(): boolean });
}

/**
 * Return true when stderr supports ANSI colour.
 *
 * Same logic as colorStdout but tests process.stderr.isatty(). Use for
 * progress indicators, spinners, and diagnostic output written to stderr.
 */
export function colorStderr(): boolean {
  return _colorStream(process.stderr as unknown as { isatty?(): boolean });
}

/**
 * True when the terminal supports 24-bit colour on stdout and NO_COLOR is
 * unset. Computed once at module load — the direct port of ansi.py's
 * `USE_COLOR: bool = color_stdout()`. Callers should check this before
 * building ANSI sequences.
 */
export const USE_COLOR: boolean = colorStdout();

// ===========================================================================
// Escape sequence primitives.
// ===========================================================================

/** ESC byte — the single-character control that starts every VT/ANSI sequence. */
const _E = "\x1b";

/** Canonical SGR reset escape (resets all colour/style attributes). */
export const RESET: string = `${_E}[0m`;

/** RGB triple (red, green, blue), each component 0–255. */
export type RGB = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Full VT/ANSI escape sequence pattern — covers CSI (colour, cursor, erase),
// OSC (title/hyperlink sequences used by pip/docker/cargo progress UIs),
// DCS/SOS/PM/APC strings, and bare 2-byte ESC sequences. Compiled once here
// and shared by vlen() and stripAnsi() so there is exactly one copy of this
// pattern in the process (ansi.py notes bash_compress.strip_ansi re-uses it
// via re-export; the TS port re-exports the stripAnsi *function* instead, so
// downstream callers never need the regex directly).
//
// The four alternations and their char-class ranges are copied verbatim from
// ansi.py's VERBOSE `_ANSI_ESCAPE_RE`:
//   1. CSI:  `\x1B \[ [0-?]* [ -/]* [@-~]`
//   2. OSC:  `\x1B \] .*? (?: \x07 | \x1B \\)`
//   3. DCS/SOS/PM/APC:  `\x1B [PX^_] .*? \x1B \\`
//   4. 2-byte ESC:  `\x1B [@-Z\\-_]`
// The 's' (DOTALL) flag on the Python regex makes `.` match newlines in the
// OSC/DCS branches; the JS regex uses the `s` (dotAll) flag for the same
// effect. VERBOSE's whitespace-insensitivity has no JS equivalent, so the
// pattern is written on one line — semantically identical.
// ---------------------------------------------------------------------------
const _ANSI_ESCAPE_RE: RegExp = new RegExp(
  [
    "\\x1B\\[[0-?]*[ -/]*[@-~]", // CSI sequence (SGR, cursor, erase, …)
    "|\\x1B\\].*?(?:\\x07|\\x1B\\\\)", // OSC sequence (title, hyperlinks, …)
    "|\\x1B[PX^_].*?\\x1B\\\\", // DCS / SOS / PM / APC (P/X/^/_ are in [@-Z\\-_])
    "|\\x1B[@-Z\\\\-_]", // 2-byte ESC sequence (bare single-byte payloads)
  ].join(""),
  // 's' = dotAll (Python re.DOTALL: '.' matches newlines in OSC/DCS branches).
  // 'g' = global (Python re.sub replaces ALL matches; JS String.replace
  //   without 'g' would consume only the first CSI/OSC run and leave the
  //   closing RESET and any subsequent sequences intact, breaking vlen and
  //   stripAnsi on every multi-span coloured string).
  "gs",
);

// ---------------------------------------------------------------------------
// Unicode Private Use Area regex: strips U+E000–U+F8FF (BMP) and
// U+F0000–U+FFFDD (supplementary). Copied verbatim from ansi.py's _PUA_RE.
// Used only inside stripAnsi() (NOT vlen — see module parity notes).
// ---------------------------------------------------------------------------
const _PUA_RE: RegExp = new RegExp(
  "[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFDD}]",
  "gu",
);

/**
 * Remove all ANSI/VT escape sequences from s.
 *
 * Optimized with a fast path for plain text (no ESC byte), and handles:
 * - CSI colour/cursor sequences
 * - OSC hyperlinks and title sequences
 * - DCS/SOS/PM/APC strings
 * - Unicode Private Use Area characters (U+E000–U+F8FF, U+F0000–U+FFFDD)
 *   emitted by some terminal emulators for custom icons.
 *
 * Direct port of ansi.py.strip_ansi.
 *
 * @param s The possibly-ANSI-coded string.
 * @returns The string with all ANSI escapes and PUA characters removed.
 */
export function stripAnsi(s: string): string {
  // Fast path: if there's no ESC byte, return unchanged. This covers the vast
  // majority of plain bash output (~10x speedup). We check ESC byte only
  // since PUA chars are rare; a full scan would negate the speedup. (Matches
  // the Python design tradeoff exactly — see ansi.py strip_ansi comment.)
  if (!s.includes("\x1b")) {
    return s;
  }

  // Strip ANSI/VT escape sequences (all four alternations).
  const text = s.replace(_ANSI_ESCAPE_RE, "");

  // Strip Unicode Private Use Area characters which some terminal emulators
  // use for custom icons/symbols.
  return text.replace(_PUA_RE, "");
}

/**
 * Format a byte count as a plain-text human-readable string (B/KB/MB/GB/TB/PB).
 *
 * No ANSI codes — safe for use in table cells and fallback renderers. Direct
 * port of ansi.py.fmt_bytes. The bytes unit prints as an integer (no decimal);
 * every larger unit prints one decimal place.
 *
 * @param n Byte count (negative inputs follow the Python abs(value) < 1024
 *   check — the magnitude gates the unit, so -512 -> "-512B" via the int cast).
 */
export function fmtBytes(n: number): string {
  let value: number = n; // Python does float(n); JS number is already float64.
  for (const unit of ["B", "KB", "MB", "GB", "TB"] as const) {
    if (Math.abs(value) < 1024) {
      return unit === "B"
        ? `${Math.trunc(value)}${unit}`
        : `${value.toFixed(1)}${unit}`;
    }
    value = value / 1024;
  }
  return `${value.toFixed(1)}PB`;
}

/**
 * Build a 24-bit foreground-colour SGR escape sequence.
 *
 * Byte-for-byte port of ansi.py.fg: `\x1b[38;2;{r};{g};{b}m`.
 */
export function fg(r: number, g: number, b: number): string {
  return `${_E}[38;2;${r};${g};${b}m`;
}

/**
 * Build a 24-bit background-colour SGR escape sequence.
 *
 * Byte-for-byte port of ansi.py.bg: `\x1b[48;2;{r};{g};{b}m`.
 */
export function bg(r: number, g: number, b: number): string {
  return `${_E}[48;2;${r};${g};${b}m`;
}

/**
 * Visible (non-ANSI) length of a string.
 *
 * Strips CSI/OSC/DCS/2-byte escape sequences via the shared regex, then
 * returns the code-unit length of what remains. Direct port of ansi.py.vlen.
 *
 * NOTE: unlike stripAnsi, vlen does NOT strip Private-Use-Area characters.
 * A PUA icon occupies a terminal cell, so it counts toward visible width for
 * padding purposes. padR/padL build on vlen and inherit this contract.
 *
 * @param s The possibly-ANSI-coded string.
 */
export function vlen(s: string): number {
  return s.replace(_ANSI_ESCAPE_RE, "").length;
}

/**
 * Right-pad a (possibly ANSI-coded) string to w visible characters.
 *
 * Uses vlen for the visible width so embedded SGR codes don't inflate the
 * pad. If the string already meets or exceeds w, it is returned unchanged
 * (max(0, ...) guards against negative pad — padding only ever adds).
 *
 * Direct port of ansi.py.pad_r.
 */
export function padR(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - vlen(s)));
}

/**
 * Left-pad a (possibly ANSI-coded) string to w visible characters.
 *
 * Mirrors padR but prepends the padding. Direct port of ansi.py.pad_l.
 */
export function padL(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - vlen(s))) + s;
}

/**
 * Linearly interpolate two RGB colours.
 *
 * Each component is `round(a + (b - a) * t)`. Direct port of ansi.py.lerp_rgb.
 *
 * @param a Start RGB triple.
 * @param b End RGB triple.
 * @param t Interpolation parameter in [0, 1] (values outside the range
 *   extrapolate, matching Python — no clamping is applied).
 * @returns A new `[r, g, b]` triple (mutable array, not a tuple).
 */
export function lerpRgb(a: RGB, b: RGB, t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// ===========================================================================
// Shared colour palette — GitHub dark-inspired green accent scheme.
// ===========================================================================
// Python's `class C` held only class attributes (constant RGB triples). The
// TS port expresses the same shape as a `const` object: reads (C.GREEN1)
// return the same fixed triple, no per-access allocation, no methods. Every
// value is copied verbatim from ansi.py including the inline hex comment so a
// future palette sync has a source of truth to diff against.
//
// The triples are typed `RGB` (readonly [number, number, number]) so callers
// can pass them directly to fg()/bg()/lerpRgb() without a cast.
export const C = {
  TEXT_PRIMARY: [201, 209, 217] as RGB, // #c9d1d9
  TEXT_BRIGHT: [240, 246, 252] as RGB, // #f0f6fc
  TEXT_MUTED: [125, 133, 144] as RGB, // #7d8590
  TEXT_DIM: [72, 79, 88] as RGB, // #484f58
  BG_TILE: [22, 27, 34] as RGB, // #161b22 — empty heatmap cell
  TRACK: [28, 35, 41] as RGB, // #1c2329 — unfilled bar track
  // Green gradient, dim → bright
  GREEN1: [31, 77, 44] as RGB, // #1f4d2c
  GREEN2: [46, 160, 67] as RGB, // #2ea043
  GREEN3: [63, 185, 80] as RGB, // #3fb950
  GREEN4: [86, 211, 100] as RGB, // #56d364
  GREEN5: [126, 231, 135] as RGB, // #7ee787
  // Accents
  BLUE: [88, 166, 255] as RGB, // tokens
  PURPLE: [188, 140, 255] as RGB, // project bullet 1
  TEAL: [138, 212, 255] as RGB, // project bullet 2
  ORANGE: [235, 165, 80] as RGB, // bash bucket — distinct from the cool-toned hint/read/compact
  YELLOW: [240, 215, 80] as RGB, // web bucket — pairs with orange in warm-tone half
  RED: [200, 60, 60] as RGB, // negative delta
} as const;
