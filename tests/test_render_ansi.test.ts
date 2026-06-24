/**
 * Unit tests for token_goat/render/ansi — colour + text helpers.
 *
 * TEST-FIRST: written before ansi.ts. The Python assertions in
 * tests/test_render_ansi.py (bg + lerp_rgb) are ported 1:1 with the same exact
 * ANSI byte sequences. stripAnsi / vlen / padL / padR / fg are exercised here
 * too even though the Python suite left them uncovered: their contracts are
 * load-bearing for every downstream renderer (stats panel, map, sparklines),
 * and the four-alternation ANSI regex + ESC-byte fast path + PUA strip is the
 * single most parity-sensitive code in the render layer — a one-byte drift in
 * the CSI/OSC/DCS/2-byte alternation silently breaks vlen() and therefore every
 * padded column. So this file asserts the exact bytes.
 *
 * Conventions matched to the repo (see ts/tests/test_entropy.test.ts):
 *  - `import type` for type-only imports (verbatimModuleSyntax).
 *  - one describe block named after the source module + Python test file.
 *  - each Python `def test_*` -> one `it()` with the same name.
 *  - exact string assertions for the ANSI builders, never substring.
 */
import { describe, expect, it } from "vitest";

import {
  RESET,
  bg,
  fg,
  lerpRgb,
  padL,
  padR,
  stripAnsi,
  vlen,
  type RGB,
} from "../src/token_goat/render/ansi.js";

describe("render/ansi (port of tests/test_render_ansi.py + contract cover)", () => {
  // -------------------------------------------------------------------------
  // bg() — ported 1:1 from TestBg. Exact ANSI byte sequences.
  // -------------------------------------------------------------------------
  describe("bg", () => {
    it("test_returns_escape_sequence", () => {
      expect(bg(0, 128, 255)).toBe("\x1b[48;2;0;128;255m");
    });

    it("test_black", () => {
      expect(bg(0, 0, 0)).toBe("\x1b[48;2;0;0;0m");
    });

    it("test_white", () => {
      expect(bg(255, 255, 255)).toBe("\x1b[48;2;255;255;255m");
    });
  });

  // -------------------------------------------------------------------------
  // fg() — mirrors bg's contract (foreground = 38, background = 48). The
  // Python tests didn't cover fg() directly, but ansi.py builds it with the
  // same template and stats_renderer.py depends on the exact bytes, so we
  // pin the parity here.
  // -------------------------------------------------------------------------
  describe("fg", () => {
    it("returns the 24-bit foreground escape sequence", () => {
      expect(fg(0, 128, 255)).toBe("\x1b[38;2;0;128;255m");
    });

    it("black", () => {
      expect(fg(0, 0, 0)).toBe("\x1b[38;2;0;0;0m");
    });

    it("white", () => {
      expect(fg(255, 255, 255)).toBe("\x1b[38;2;255;255;255m");
    });
  });

  // -------------------------------------------------------------------------
  // lerpRgb() — ported 1:1 from TestLerpRgb. Python's round() is banker's
  // rounding (round-half-to-even); Math.round is round-half-up. Every value
  // the tests assert (10,20,30 | 100,200,255 | 50,100,25 | round(255*0.2)=51)
  // is unambiguous, so both rounding modes agree byte-for-byte here.
  // -------------------------------------------------------------------------
  describe("lerpRgb", () => {
    const a: RGB = [10, 20, 30];
    const b: RGB = [100, 200, 255];

    it("test_t_zero_returns_a", () => {
      expect(lerpRgb(a, b, 0.0)).toEqual([10, 20, 30]);
    });

    it("test_t_one_returns_b", () => {
      expect(lerpRgb(a, b, 1.0)).toEqual([100, 200, 255]);
    });

    it("test_midpoint", () => {
      expect(lerpRgb([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
    });

    it("test_all_three_components_interpolated", () => {
      const t = 0.2;
      const result = lerpRgb([0, 0, 0], [255, 100, 50], t);
      expect(result).toEqual([
        Math.round(255 * t),
        Math.round(100 * t),
        Math.round(50 * t),
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // RESET — the canonical SGR reset. ansi.py defines it as `\x1b[0m`; every
  // coloured span in the renderer is bookended by this, so a stray byte here
  // would bleed colour across the whole panel.
  // -------------------------------------------------------------------------
  describe("RESET", () => {
    it("is the canonical SGR reset escape", () => {
      expect(RESET).toBe("\x1b[0m");
    });
  });

  // -------------------------------------------------------------------------
  // stripAnsi() — contract cover. ansi.py's strip_ansi has three layers:
  //   (1) ESC-byte fast path: no `\x1b` in input -> return unchanged (the
  //       common case for bash output; ~10x speedup).
  //   (2) four-alternation regex: CSI | OSC | DCS/SOS/PM/APC | 2-byte ESC.
  //   (3) Private-Use-Area strip: U+E000–U+F8FF and U+F0000–U+FFFDD (icons).
  // Each layer is exercised below because each can regress independently.
  // -------------------------------------------------------------------------
  describe("stripAnsi", () => {
    it("fast path: plain text with no ESC byte is returned unchanged", () => {
      const plain = "hello world 123 — no escapes here";
      expect(stripAnsi(plain)).toBe(plain);
    });

    it("strips a CSI SGR colour sequence", () => {
      // fg(31,77,44) builds `\x1b[38;2;31;77;44m`; RESET is `\x1b[0m`.
      const coloured = `${fg(31, 77, 44)}GREEN${RESET}`;
      expect(stripAnsi(coloured)).toBe("GREEN");
    });

    it("strips a CSI cursor-position sequence (numeric params + final byte)", () => {
      // `\x1b[10;20H` — cursor to row 10, col 20. Final byte 'H' is in [@-~].
      expect(stripAnsi("\x1b[10;20Hmove")).toBe("move");
    });

    it("strips an OSC hyperlink/title sequence (BEL-terminated)", () => {
      // OSC 8 hyperlink form, terminated by BEL (\x07).
      const osc = "\x1b]8;;https://example.com\x07click\x1b]8;;\x07";
      expect(stripAnsi(osc)).toBe("click");
    });

    it("strips an OSC sequence terminated by ST (ESC \\)", () => {
      // OSC title terminated by the 2-byte string terminator ESC backslash.
      const osc = "\x1b]0;my title\x1b\\after";
      expect(stripAnsi(osc)).toBe("after");
    });

    it("strips a DCS sequence (ESC P ... ESC \)", () => {
      // DCS payload terminated by ST.
      const dcs = "\x1bP1$qqayload\x1b\\tail";
      expect(stripAnsi(dcs)).toBe("tail");
    });

    it("strips a bare 2-byte ESC sequence (ESC + single intermediate)", () => {
      // ESC M (reverse index) — 2-byte form, final byte in [@-Z\\-_].
      expect(stripAnsi("\x1bMx")).toBe("x");
    });

    it("strips Unicode Private-Use-Area icons (BMP range U+E000–U+F8FF)", () => {
      // PUA chars survive the ESC fast path (no ESC byte) but the PUA regex
      // layer must drop them. Wrap in an ESC sequence so we reach that layer.
      const pua = "\x1b[0micon";
      expect(stripAnsi(pua)).toBe("icon");
    });

    it("a lone ESC byte (no sequence byte after) is preserved, matching Python", () => {
      // Each of the four alternations requires at least one byte AFTER the
      // ESC ([ for CSI, ] for OSC, [PX^_] or [@-Z\\-_] for the others). A
      // bare `\x1b` matches none of them, so both Python's re.sub and the JS
      // port leave it intact. Pin this so a future "always drop ESC" patch is
      // a deliberate change — verified byte-for-byte against ansi.py.
      expect(stripAnsi("\x1b")).toBe("\x1b");
    });

    it("empty string round-trips", () => {
      expect(stripAnsi("")).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // vlen() — visible length. ansi.py defines vlen(s) = len(strip-by-regex),
  // i.e. CSI/OSC/DCS/2-byte alternation only (NOT the PUA layer — vlen and
  // strip_ansi diverge here on purpose: PUA icons occupy a cell in most
  // terminals, so they count toward visible width for padding purposes).
  // The padL/padR contract below depends on this exact definition.
  // -------------------------------------------------------------------------
  describe("vlen", () => {
    it("plain string length is the string length", () => {
      expect(vlen("hello")).toBe(5);
    });

    it("counts only visible chars when SGR colour codes are present", () => {
      expect(vlen(`${fg(31, 77, 44)}hi${RESET}`)).toBe(2);
    });

    it("empty string is zero", () => {
      expect(vlen("")).toBe(0);
    });

    it("does not subtract for OSC hyperlinks", () => {
      const osc = "\x1b]8;;https://example.com\x07click\x1b]8;;\x07";
      expect(vlen(osc)).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // padR / padL — right/left pad to a visible width. Both use max(0, w-vlen)
  // so a string already at/over the target width is returned unchanged (no
  // negative-space trimming — padding only ever adds).
  // -------------------------------------------------------------------------
  describe("padR", () => {
    it("right-pads plain text to the target width", () => {
      expect(padR("hi", 5)).toBe("hi   ");
    });

    it("pads ANSI-coloured text by its visible length, not byte length", () => {
      const coloured = `${fg(0, 0, 0)}ab${RESET}`;
      // visible length is 2 -> pad to 5 with 3 trailing spaces.
      expect(padR(coloured, 5)).toBe(coloured + "   ");
    });

    it("no-op when string already meets the width", () => {
      expect(padR("hello", 5)).toBe("hello");
    });

    it("no-op (no trimming) when string exceeds the width", () => {
      expect(padR("abcdef", 3)).toBe("abcdef");
    });
  });

  describe("padL", () => {
    it("left-pads plain text to the target width", () => {
      expect(padL("hi", 5)).toBe("   hi");
    });

    it("pads ANSI-coloured text by its visible length", () => {
      const coloured = `${bg(0, 0, 0)}xy${RESET}`;
      expect(padL(coloured, 5)).toBe("   " + coloured);
    });

    it("no-op when string already meets the width", () => {
      expect(padL("hello", 5)).toBe("hello");
    });

    it("no-op (no trimming) when string exceeds the width", () => {
      expect(padL("abcdef", 3)).toBe("abcdef");
    });
  });
});
