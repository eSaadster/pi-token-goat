/**
 * Tests for BinaryInspectFilter and FileTypeFilter (xxd/hexdump/od/hd + file).
 *
 * 1:1 port of tests/test_bash_compress_binary_inspect_filter.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python tests are module-level functions, so they sit under one
 * `describe()` per logical block (mirroring the Python section dividers).
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports BinaryInspectFilter + FileTypeFilter + the dispatch surface).
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter_, stdout, argv)` helper below; calls
 *         `filter_.apply(stdout, "", 0, argv).text` (Python's apply_filter
 *         passes stdout/stderr=exit_code=0 positional + argv kwarg).
 *  - Python `from token_goat import bash_detect` + `bash_detect.detect([...])`
 *      -> SKIPPED. bash_detect is a SEPARATE dispatch module (the static
 *         binary->filter-name lookup table in token_goat/bash_detect.py) that
 *         has NOT been ported to TS yet (no ts/src/token_goat/bash_detect.ts).
 *         This matches the precedent set by test_bash_compress_codex.test.ts's
 *         `test_bash_detect_routes_codex` skip. The barrel-level routing is
 *         already covered elsewhere; the three bash_detect cases are left
 *         skipped with a clear reason rather than re-routed through a module
 *         that does not exist.
 *
 * Fixture parity: the Python helpers `_xxd_line(offset, data_hex, ascii_repr)`
 * and `_make_xxd_output(magic_hex, n_extra_lines)` are ported verbatim below as
 * `_xxdLine` / `_makeXxdOutput`. The hex-group layout (groups of 4 hex chars,
 * space-joined, `ljust(39)` then two spaces + ascii) is byte-identical because
 * the inputs are pure ASCII and the JS string ops mirror Python str slicing
 * (offset:%08x -> String padStart(8,"0") base-16; range step 4 -> for-loop with
 * +=4). The `_HEX_DUMP_LINE_RE` in tail_filters.ts must match the first line of
 * every dump for magic detection to fire; this is exercised by the magic-byte
 * cases below.
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks plus one
 * strip-equality. All fixtures and substrings are ASCII, so code-unit length
 * equals byte length; no Buffer arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import {
  BinaryInspectFilter,
  FileTypeFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site). Python's apply_filter signature is
// apply_filter(filter_, stdout="", stderr="", exit_code=0, argv=None); argv
// defaults to [filter_.name] when None. The cases below always pass argv
// explicitly (["xxd"] or ["file"]), matching the Python call sites.
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  opts: { stdout: string; argv: string[]; stderr?: string; exit_code?: number },
): string {
  const stdout = opts.stdout;
  const stderr = opts.stderr ?? "";
  const exit_code = opts.exit_code ?? 0;
  const argv = opts.argv;
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ===========================================================================
// Helpers — port of _xxd_line / _make_xxd_output
// ===========================================================================

/**
 * Build a synthetic xxd output line. Port of Python `_xxd_line`.
 *
 * xxd groups bytes in pairs separated by spaces; 8 pairs per line. The Python
 * helper slices data_hex into 4-char groups (2 bytes each), joins with a single
 * space, left-justifies to width 39, then appends two spaces + ascii_repr.
 */
function _xxdLine(
  offset: number,
  dataHex: string,
  asciiRepr = "................",
): string {
  // Python: [data_hex[i:i+4] for i in range(0, min(len(data_hex), 32), 4)]
  const limit = Math.min(dataHex.length, 32);
  const groups: string[] = [];
  for (let i = 0; i < limit; i += 4) {
    groups.push(dataHex.slice(i, i + 4));
  }
  // Python: " ".join(groups).ljust(39)
  const hexPart = groups.join(" ").padEnd(39, " ");
  // Python: f"{offset:08x}: {hex_part}  {ascii_repr}"
  const offsetHex = offset.toString(16).padStart(8, "0");
  return `${offsetHex}: ${hexPart}  ${asciiRepr}`;
}

/**
 * Build a fake xxd dump with the given magic bytes in the first line.
 * Port of Python `_make_xxd_output`.
 *
 * Pads magic to 32 hex chars (16 bytes) for a full first line, then appends
 * n_extra_lines lines of all-zero bytes at offsets i*16. Lines joined by "\n"
 * with a trailing "\n".
 */
function _makeXxdOutput(magicHex: string, nExtraLines = 10): string {
  // Python: (magic_hex + "00" * 16)[:32]
  const padded = (magicHex + "00".repeat(16)).slice(0, 32);
  const lines: string[] = [_xxdLine(0, padded)];
  for (let i = 1; i <= nExtraLines; i += 1) {
    lines.push(_xxdLine(i * 16, "00".repeat(16)));
  }
  return lines.join("\n") + "\n";
}

// ===========================================================================
// Fixtures — exact ports of the Python module-level dump constants
// ===========================================================================

const _PNG_DUMP = _makeXxdOutput("89504e470d0a1a0a0000000d49484452", 20);
const _JPEG_DUMP = _makeXxdOutput("ffd8ffe000104a464946000101000048", 20);
const _PDF_DUMP = _makeXxdOutput("255044462d312e350a0a", 20);
const _ZIP_DUMP = _makeXxdOutput("504b0304140000000800", 20);
const _ELF_DUMP = _makeXxdOutput("7f454c4602010100000000000000000", 20);
const _EXE_DUMP = _makeXxdOutput("4d5a900003000000040000ffff0000b8", 20);
const _GZIP_DUMP = _makeXxdOutput("1f8b080800000000000003", 20);
const _SEVENZ_DUMP = _makeXxdOutput("377abcaf271c000000000000", 20);
const _UNKNOWN_DUMP = _makeXxdOutput("deadbeef1234567890abcdef", 20);

// Module-level filter instances (Python uses _FILTER / _FILE_FILTER globals).
const _FILTER = new BinaryInspectFilter();
const _FILE_FILTER = new FileTypeFilter();

// ===========================================================================
// BinaryInspectFilter — magic byte detection
// ===========================================================================

describe("TestBinaryInspectFilterMagic", () => {
  it("test_png_magic_detected", () => {
    const result = _compress(_FILTER, { stdout: _PNG_DUMP, argv: ["xxd"] });
    expect(result).toContain("PNG image");
    expect(result).toContain("89504e47");
  });

  it("test_jpeg_magic_detected", () => {
    const result = _compress(_FILTER, { stdout: _JPEG_DUMP, argv: ["xxd"] });
    expect(result).toContain("JPEG image");
    expect(result).toContain("ffd8ff");
  });

  it("test_zip_magic_detected", () => {
    const result = _compress(_FILTER, { stdout: _ZIP_DUMP, argv: ["xxd"] });
    expect(result).toContain("ZIP archive");
    expect(result).toContain("504b0304");
  });

  it("test_elf_magic_detected", () => {
    const result = _compress(_FILTER, { stdout: _ELF_DUMP, argv: ["xxd"] });
    expect(result).toContain("ELF binary");
    expect(result).toContain("7f454c46");
  });

  it("test_windows_exe_magic_detected", () => {
    const result = _compress(_FILTER, { stdout: _EXE_DUMP, argv: ["xxd"] });
    expect(result).toContain("Windows EXE/DLL");
    expect(result).toContain("4d5a");
  });

  it("test_gzip_magic_detected", () => {
    const result = _compress(_FILTER, { stdout: _GZIP_DUMP, argv: ["xxd"] });
    expect(result).toContain("gzip archive");
  });

  it("test_unknown_binary_shows_magic_bytes", () => {
    const result = _compress(_FILTER, { stdout: _UNKNOWN_DUMP, argv: ["xxd"] });
    expect(result).toContain("unknown binary type");
    expect(result).toContain("deadbeef");
  });

  it("test_first_two_lines_preserved", () => {
    const result = _compress(_FILTER, { stdout: _PNG_DUMP, argv: ["xxd"] });
    const inputLines = _PNG_DUMP.split("\n");
    const resultLines = result.split("\n");
    // First two hex lines must appear verbatim in the output.
    expect(resultLines).toContain(inputLines[0]!);
    expect(resultLines).toContain(inputLines[1]!);
  });

  it("test_suppressed_line_count_accurate", () => {
    // _make_xxd_output with n_extra_lines=20 -> 21 lines total.
    const result = _compress(_FILTER, { stdout: _PNG_DUMP, argv: ["xxd"] });
    expect(result).toContain("21 lines");
  });

  it("test_short_output_passes_through", () => {
    // <=4 lines should never be compressed.
    const short = _makeXxdOutput("89504e47", 1); // 2 lines
    const result = _compress(_FILTER, { stdout: short, argv: ["xxd"] });
    expect(result).not.toContain("[token-goat:");
    // apply() may strip a trailing newline; compare stripped content.
    expect(result.trim()).toBe(short.trim());
  });
});

// ===========================================================================
// Dispatch: xxd / hexdump / od / hd all route to BinaryInspectFilter
//
// The Python parametrized `test_dispatch_hex_binaries` imports bash_detect and
// asserts `bash_detect.detect([binary]) == "xxd"` for each of xxd/hexdump/od/hd.
// SKIPPED here: bash_detect (token_goat/bash_detect.py) is a separate static
// dispatch module that has NOT been ported to TS yet. The per-binary `matches()`
// membership on BinaryInspectFilter.binaries is the closest barrel-level proxy
// and is NOT what the Python case asserts, so we keep the case skipped rather
// than substitute a different check.
// ===========================================================================

describe("TestBinaryInspectFilterDispatch", () => {
  // reason: Python `from token_goat import bash_detect; bash_detect.detect([...])`
  // routes through a SEPARATE dispatch module (token_goat/bash_detect.py) that
  // has NOT been ported to TS yet (no ts/src/token_goat/bash_detect.ts exists).
  // The parametrized case covered xxd/hexdump/od/hd -> "xxd" via that table.
  it.skip("test_dispatch_hex_binaries", () => {
    expect(true).toBe(true);
  });
});

// ===========================================================================
// FileTypeFilter — pass-through and batch truncation
// ===========================================================================

describe("TestFileTypeFilter", () => {
  it("test_file_command_short_passes_through", () => {
    const output =
      "foo.png: PNG image data, 800 x 600, 8-bit/color RGBA, non-interlaced\n";
    const result = _compress(_FILE_FILTER, { stdout: output, argv: ["file"] });
    // apply() may strip a trailing newline; compare stripped content.
    expect(result.trim()).toBe(output.trim());
  });

  it("test_file_command_batch_truncated", () => {
    // Generate 25 file output lines.
    const lines = Array.from({ length: 25 }, (_v, i) => `file_${String(i).padStart(3, "0")}.bin: data\n`);
    const bigOutput = lines.join("");
    const result = _compress(_FILE_FILTER, { stdout: bigOutput, argv: ["file"] });
    expect(result).toContain("5 more file entries truncated");
    // First 20 lines should be present.
    expect(result).toContain("file_000.bin");
    expect(result).toContain("file_019.bin");
    // Line 21 should NOT be present verbatim.
    expect(result).not.toContain("file_020.bin");
  });

  // reason: Python `from token_goat import bash_detect; bash_detect.detect(["file"])`
  // routes through a SEPARATE dispatch module (token_goat/bash_detect.py) that
  // has NOT been ported to TS yet (no ts/src/token_goat/bash_detect.ts exists).
  // The Python case asserts that table maps "file" -> "file"; kept skipped
  // rather than substituted with a barrel-level proxy.
  it.skip("test_file_filter_dispatch", () => {
    expect(true).toBe(true);
  });
});
