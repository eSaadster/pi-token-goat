/**
 * Tests for image-shrink integration in the pre_read hook — Phase 12.
 *
 * 1:1 port of tests/test_hooks_image.py. image_shrink.ts is ported (sharp /
 * libvips) and wired into hooks_read via the _setImageShrinkModule seam (which
 * now DEFAULTS to the real module), so these end-to-end dispatch tests are LIVE.
 *
 * Parity notes (Python -> TS):
 *  - hook_helpers.assert_continue / make_large_jpeg / make_small_jpeg are
 *    reproduced inline (the sharp analogue of the Pillow originals — sharp and
 *    Pillow are not byte-identical, but the only contract these tests need is "a
 *    file reliably > SIZE_THRESHOLD_BYTES" / "a file reliably <= it").
 *  - hooks_cli.pre_read / hooks_cli.dispatch are ASYNC in the TS port (the
 *    handler awaits image_shrink.shrink, which is libvips-backed). Every call is
 *    awaited; the it() bodies are async.
 *  - hooks_read._try_shrink_image is ASYNC; the bypass-telemetry tests await it.
 *  - patch("token_goat.db.record_stat", side_effect=...) -> vi.spyOn(db,
 *    "recordStat"). The recorded opts use the TS camelCase param names
 *    (bytesSaved / tokensSaved / detail), not the Python snake_case kwargs.
 *  - tmp_data_dir autouse fixture -> tests/setup.ts (setDataDirOverride +
 *    clearModuleCaches, registered globally via vitest setupFiles).
 *  - tmp_path fixture -> fs.mkdtempSync wrapped in fs.realpathSync (macOS /var
 *    symlink vs the real path image_shrink computes for the cache dir).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as hooks_cli from "../src/token_goat/hooks_cli.js";
import * as image_shrink from "../src/token_goat/image_shrink.js";
import * as db from "../src/token_goat/db.js";
import type { HookPayload } from "../src/token_goat/types.js";

// The integration tests drive the full handler via hooks_cli.dispatch; the
// bypass-telemetry tests call hooks_read._try_shrink_image directly.

// ---------------------------------------------------------------------------
// Shared helpers (ports of hook_helpers + the image-synthesis fixtures).
// ---------------------------------------------------------------------------

/** Verbatim port of hook_helpers.assert_continue. */
function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

const _tmpRoots: string[] = [];

/** Throwaway tmp dir (pytest tmp_path analogue), realpath-resolved. */
function tmpPath(prefix = "tg-himg-"): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  _tmpRoots.push(d);
  return d;
}

/**
 * Return a path to a synthetic >100 KB image (default .jpg) in `dir`.
 * 1100x825 random pixels: long edge (1100) exceeds MAX_LONG_EDGE (1024) so
 * shrink() resizes, and random-noise JPEG at q95 is reliably > 100 KB. Falls
 * back to a lossless PNG (still named .jpg) if somehow under threshold.
 * (Python hook_helpers.make_large_jpeg.)
 */
async function makeLargeJpeg(dir: string, name = "large.jpg"): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const raw = (await import("node:crypto")).randomBytes(1100 * 825 * 3);
  await sharp(raw, { raw: { width: 1100, height: 825, channels: 3 } })
    .jpeg({ quality: 95 })
    .toFile(p);
  if (fs.statSync(p).size <= image_shrink.SIZE_THRESHOLD_BYTES) {
    // Guarantee > threshold with a lossless PNG written under the same name.
    await sharp(raw, { raw: { width: 1100, height: 825, channels: 3 } }).png().toFile(p);
  }
  return p;
}

/** Return a path to a synthetic sub-threshold JPEG (50x50). (make_small_jpeg.) */
async function makeSmallJpeg(dir: string, name = "small.jpg"): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const raw = Buffer.alloc(50 * 50 * 3);
  for (let i = 0; i < 50 * 50; i++) {
    raw[i * 3] = 128;
    raw[i * 3 + 1] = 64;
    raw[i * 3 + 2] = 32;
  }
  await sharp(raw, { raw: { width: 50, height: 50, channels: 3 } }).jpeg({ quality: 75 }).toFile(p);
  return p;
}

// These integration tests run a REAL sharp shrink through the hook dispatch.
// The default format for photographic content is AVIF, whose libaom encode is
// slow + memory-heavy; under the vitest forks pool two parallel workers both
// encoding AVIF starve each other and the encode fails -> shrink()=null -> no
// savings hint (flaky, parallel-only — production shrinks one image per hook).
// Force the fast, low-memory JPEG encoder: these tests assert the savings-hint
// FORMATTING, not the chosen format (AVIF selection is covered by
// test_image_shrink.test.ts). Removed in afterEach.
beforeEach(() => {
  process.env.TOKEN_GOAT_IMAGE_FORMAT = "jpeg";
});

afterEach(() => {
  delete process.env.TOKEN_GOAT_IMAGE_FORMAT;
  vi.restoreAllMocks();
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// 11. Large image → hook returns updatedInput with shrunken path
// ---------------------------------------------------------------------------

describe("TestPreReadHookLargeImage", () => {
  it("test_large_image_returns_updated_input", async () => {
    const tmp = tmpPath();
    const src = await makeLargeJpeg(tmp);
    expect(fs.statSync(src).size).toBeGreaterThan(image_shrink.SIZE_THRESHOLD_BYTES);

    const payload: HookPayload = {
      session_id: "img_s1",
      tool_name: "Read",
      tool_input: { file_path: src },
      cwd: tmp,
    };
    const result = await hooks_cli.dispatch("pre-read", payload);

    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true); // Expected hookSpecificOutput for large image

    const hso = result["hookSpecificOutput"] as Record<string, unknown>;
    expect("updatedInput" in hso).toBe(true); // Expected updatedInput in hookSpecificOutput
    const updated = hso["updatedInput"] as Record<string, unknown>;
    expect("file_path" in updated).toBe(true);

    const shrunken_path = updated["file_path"] as string;
    expect(fs.existsSync(shrunken_path)).toBe(true); // Shrunken path must exist
    expect(shrunken_path).not.toBe(src); // Shrunken path must differ from source
    expect(fs.statSync(shrunken_path).size).toBeLessThan(fs.statSync(src).size);
  });

  it("test_large_image_additional_context_mentions_savings", async () => {
    const tmp = tmpPath();
    const src = await makeLargeJpeg(tmp);

    const payload: HookPayload = {
      session_id: "img_s2",
      tool_name: "Read",
      tool_input: { file_path: src },
    };
    const result = await hooks_cli.dispatch("pre-read", payload);

    const hso = (result["hookSpecificOutput"] as Record<string, unknown> | undefined) ?? {};
    const ctx = (hso["additionalContext"] as string | undefined) ?? "";
    expect(ctx.includes("token-goat")).toBe(true);
    // New format: "X MB → Y KB (saving ~Z%)" — verify sizes and % are present.
    expect(ctx.includes("→")).toBe(true);
    expect(ctx.includes("saving ~")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Small image → no updatedInput, falls through
// ---------------------------------------------------------------------------

describe("TestPreReadHookSmallImage", () => {
  it("test_small_image_no_updated_input", async () => {
    const tmp = tmpPath();
    const src = await makeSmallJpeg(tmp);
    expect(fs.statSync(src).size).toBeLessThanOrEqual(image_shrink.SIZE_THRESHOLD_BYTES);

    const payload: HookPayload = {
      session_id: "img_s3",
      tool_name: "Read",
      tool_input: { file_path: src },
      cwd: tmp,
    };
    const result = await hooks_cli.dispatch("pre-read", payload);

    _assert_continue(result);
    // Small image → falls through to hint logic → no hookSpecificOutput
    // (no session cache hit either, so plain continue:true)
    const hso = (result["hookSpecificOutput"] as Record<string, unknown> | undefined) ?? {};
    expect("updatedInput" in hso).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. Non-image file → no updatedInput, falls through to hint logic
// ---------------------------------------------------------------------------

describe("TestPreReadHookNonImage", () => {
  it("test_non_image_no_updated_input", async () => {
    const tmp = tmpPath();
    const p = path.join(tmp, "source.py");
    fs.writeFileSync(p, "x = 1\n".repeat(100));

    const payload: HookPayload = {
      session_id: "img_s4",
      tool_name: "Read",
      tool_input: { file_path: p },
      cwd: tmp,
    };
    const result = await hooks_cli.dispatch("pre-read", payload);

    _assert_continue(result);
    const hso = (result["hookSpecificOutput"] as Record<string, unknown> | undefined) ?? {};
    expect("updatedInput" in hso).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. Garbage payload → continue:true, no crash
// ---------------------------------------------------------------------------

describe("TestPreReadHookGarbage", () => {
  it("test_none_payload_does_not_crash", async () => {
    // Python calls hooks_cli.pre_read(None) — the fail_soft-WRAPPED CLI handler
    // (module __getattr__). The bare hooks_read.pre_read is unwrapped and would
    // throw on a null payload, so resolve the wrapped handler the same way the
    // other pre_read suites do (getLazyAttr returns the fail_soft wrapper).
    const wrapped = await hooks_cli.getLazyAttr("pre_read");
    expect(wrapped).not.toBeNull();
    const result = await wrapped!(null as unknown as HookPayload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_empty_dict_does_not_crash", async () => {
    const result = await hooks_cli.dispatch("pre-read", {} as HookPayload);
    _assert_continue(result);
  });

  it("test_missing_file_path_does_not_crash", async () => {
    const payload: HookPayload = {
      session_id: "img_s5",
      tool_name: "Read",
      tool_input: {},
    };
    const result = await hooks_cli.dispatch("pre-read", payload);
    _assert_continue(result);
  });

  it("test_nonexistent_image_path_does_not_crash", async () => {
    const tmp = tmpPath();
    const payload: HookPayload = {
      session_id: "img_s6",
      tool_name: "Read",
      tool_input: { file_path: path.join(tmp, "ghost.png") },
    };
    const result = await hooks_cli.dispatch("pre-read", payload);
    _assert_continue(result);
    // Non-existent image → should_shrink=False → falls through, no updatedInput
    const hso = (result["hookSpecificOutput"] as Record<string, unknown> | undefined) ?? {};
    expect("updatedInput" in hso).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item A21: shrink hint always shows before→after sizes with % savings
// ---------------------------------------------------------------------------

/** Mirror the _fmt_bytes helper in hooks_read._try_shrink_image. */
function _fmt_bytes(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)} MB`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)} KB`;
  }
  return `${n} B`;
}

describe("TestShrinkNoteRatioFormat", () => {
  // The shrink hint always shows 'X MB → Y KB (saving ~Z%)' regardless of ratio.
  /** Re-implement the note-building logic from _try_shrink_image for unit tests. */
  function buildNote(src_bytes: number, out_bytes: number, bytes_saved: number, file_path: string): string {
    const savings_pct = src_bytes > 0 ? (100.0 * bytes_saved) / src_bytes : 0.0;
    const size_str = `${_fmt_bytes(src_bytes)} → ${_fmt_bytes(out_bytes)} (saving ~${savings_pct.toFixed(0)}%)`;
    return `Note: image auto-shrunk by token-goat (${size_str}). Original: ${file_path}`;
  }

  it("test_high_ratio_shows_before_after_and_percent", () => {
    const note = buildNote(4_000_000, 180_000, 3_820_000, "/tmp/big.jpg");
    expect(note.includes("→")).toBe(true);
    // 4MB → 180KB, saving ~96%
    expect(note.includes("4.0 MB")).toBe(true);
    expect(note.includes("180 KB")).toBe(true);
    expect(note.includes("saving ~96%")).toBe(true);
  });

  it("test_low_ratio_also_shows_before_after_and_percent", () => {
    const note = buildNote(200_000, 100_000, 100_000, "/tmp/small.jpg");
    expect(note.includes("→")).toBe(true);
    expect(note.includes("200 KB")).toBe(true);
    expect(note.includes("100 KB")).toBe(true);
    expect(note.includes("saving ~50%")).toBe(true);
  });

  it("test_sub_kb_shown_as_bytes", () => {
    const note = buildNote(500, 200, 300, "/tmp/tiny.jpg");
    expect(note.includes("500 B")).toBe(true);
    expect(note.includes("200 B")).toBe(true);
  });

  it("test_percentage_included_for_any_ratio", () => {
    const note_small = buildNote(10_000, 4_000, 6_000, "/tmp/a.jpg");
    const note_large = buildNote(40_000, 9_000, 31_000, "/tmp/b.jpg");
    expect(note_small.includes("saving ~")).toBe(true);
    expect(note_large.includes("saving ~")).toBe(true);
  });

  it("test_zero_out_bytes_shows_100_percent", () => {
    const note = buildNote(10_000, 0, 10_000, "/tmp/zero.jpg");
    expect(note.includes("saving ~100%")).toBe(true);
  });

  it("test_original_path_included", () => {
    const note = buildNote(200_000, 80_000, 120_000, "/home/user/photo.png");
    expect(note.includes("Original: /home/user/photo.png")).toBe(true);
  });
});

describe("TestShrinkHintPercentOnRealImage", () => {
  // Integration: the live hook response for a large image includes the
  // before→after sizes and % savings in the additionalContext.
  it("test_large_jpeg_hint_contains_percent_and_arrow", async () => {
    const tmp = tmpPath();
    const src = await makeLargeJpeg(tmp);

    const payload: HookPayload = {
      session_id: "img_pct1",
      tool_name: "Read",
      tool_input: { file_path: src },
    };
    const result = await hooks_cli.dispatch("pre-read", payload);

    const hso = (result["hookSpecificOutput"] as Record<string, unknown> | undefined) ?? {};
    const ctx = (hso["additionalContext"] as string | undefined) ?? "";
    // Must contain arrow (before→after) and percent.
    expect(ctx.includes("→")).toBe(true);
    expect(ctx.includes("saving ~")).toBe(true);
    expect(ctx.includes("%")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bypass telemetry: sub-threshold images record image_shrink_skipped stat
// so the bypass rate is measurable from the stats DB.
// ---------------------------------------------------------------------------

describe("TestTryShrinkImageBypassTelemetry", () => {
  it("test_small_image_records_skipped_stat", async () => {
    const tmp = tmpPath();
    // Build a sub-threshold file ourselves so we don't depend on a real encoder:
    // a 1 KB .jpg is well under both the lossy and lossless thresholds.
    const src = path.join(tmp, "tiny.jpg");
    fs.writeFileSync(src, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024)]));

    const recorded: Array<{ kind: string; bytesSaved: number; tokensSaved: number; detail: string }> = [];
    const spy = vi
      .spyOn(db, "recordStat")
      .mockImplementation((_projectHash, kind, opts = {}) => {
        recorded.push({
          kind,
          bytesSaved: opts.bytesSaved ?? 0,
          tokensSaved: opts.tokensSaved ?? 0,
          detail: opts.detail ?? "",
        });
      });
    const result = await hooks_read._try_shrink_image(src, { file_path: src });
    spy.mockRestore();

    expect(result).toBeNull(); // Sub-threshold image must not produce a redirect
    // Exactly one stat row for the bypass should be recorded.
    const skipped = recorded.filter((r) => r.kind === "image_shrink_skipped");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]!.bytesSaved).toBe(0);
    expect(skipped[0]!.tokensSaved).toBe(0);
    // Detail string includes the actual size and threshold so the bypass
    // histogram is queryable from the DB.
    expect(skipped[0]!.detail.includes("size=")).toBe(true);
    expect(skipped[0]!.detail.includes("threshold=")).toBe(true);
  });

  it("test_missing_file_does_not_record_skipped", async () => {
    // OSError from stat() falls through; no bypass stat is recorded.
    const tmp = tmpPath();
    const ghost = path.join(tmp, "ghost.jpg");
    const recorded: Array<{ kind: string }> = [];
    const spy = vi.spyOn(db, "recordStat").mockImplementation((_projectHash, kind) => {
      recorded.push({ kind });
    });
    await hooks_read._try_shrink_image(ghost, { file_path: ghost });
    spy.mockRestore();

    const skipped = recorded.filter((r) => r.kind === "image_shrink_skipped");
    expect(skipped).toEqual([]); // Missing file must not record image_shrink_skipped
  });

  it("test_non_image_does_not_record_skipped", async () => {
    // Non-image paths short-circuit before any size or stat work.
    const tmp = tmpPath();
    const txt = path.join(tmp, "notes.txt");
    fs.writeFileSync(txt, "hello");
    const recorded: Array<{ kind: string }> = [];
    const spy = vi.spyOn(db, "recordStat").mockImplementation((_projectHash, kind) => {
      recorded.push({ kind });
    });
    await hooks_read._try_shrink_image(txt, { file_path: txt });
    spy.mockRestore();

    expect(recorded).toEqual([]); // Non-image path must not record any image stats
  });
});
