/**
 * Image shrinker: resize + recompress large images to save token budget.
 *
 * TypeScript port of src/token_goat/image_shrink.py. Claude charges vision
 * tokens proportional to pixel area, so a 3000x2000 screenshot can cost 1000+
 * tokens before the model reads a single word. This module intercepts image
 * paths on the pre-read hook, compresses them to fit within MAX_LONG_EDGE
 * pixels on the longest axis, and returns the cached output path so the model
 * receives the cheaper version transparently.
 *
 * The cache is content-addressed (SHA-256 of file bytes) so identical images
 * that live at different temp paths — a pattern Claude Code uses for
 * prompt-attached images — share one cache entry and are never re-compressed.
 *
 * Parity notes (Python Pillow -> TS sharp):
 *  - Pillow is sync; sharp (libvips) is async (Promise-returning). The Python
 *    public surface is sync. The TS port keeps the LOGIC identical (when to
 *    shrink, target dimensions, format selection, quality, thresholds, skip
 *    guards, metadata stripping) but the pixel-touching functions — shrink(),
 *    shrink_if_image(), stats_for(), avif_supported() — are async (return a
 *    Promise). Pure metadata/string functions — is_image_path, format_threshold,
 *    should_shrink, vision_tokens, extract_image_summary, ensure_cache_dir —
 *    stay sync, matching Python exactly. hooks_read._try_shrink_image is the
 *    only internal caller and reaches this module through the fail-soft
 *    _setImageShrinkModule seam; the Wire phase reconciles the sync/async
 *    boundary there.
 *  - sharp and Pillow do NOT produce byte-identical output, so the cache key
 *    version and the per-format logic are preserved but byte hashes are not
 *    expected to match Pillow's. Tests assert behaviour (dimensions, format,
 *    smaller-than-source, channel count) rather than exact bytes.
 *  - Pillow's exif_transpose -> sharp's .rotate() with no argument auto-orients
 *    from EXIF.
 *  - Pillow LANCZOS resample -> sharp's "lanczos3" kernel (libvips default for
 *    downscale; closest analogue to Pillow LANCZOS).
 *  - Pillow's _looks_like_screenshot_or_text inspects the decoded mode
 *    (P/L/LA/RGBA). sharp surfaces the equivalent through metadata: hasAlpha,
 *    channels, space ("b-w" grayscale), and a palette flag. We reconstruct the
 *    same predicate from those fields.
 *  - functools.lru_cache(avif_supported) -> a module-level cached Promise.
 *  - functools.lru_cache(vision_tokens) -> a Map memo, reset via reset.ts.
 *  - The animated-image check (is_animated / n_frames>1) maps to sharp
 *    metadata.pages > 1.
 *  - Image.MAX_IMAGE_PIXELS DecompressionBomb guard -> sharp's `limitInputPixels`
 *    option, set to _MAX_PIXELS (or false when the cap is disabled). sharp
 *    rejects the Promise when the input exceeds the limit; shrink() catches it
 *    and returns null, exactly like the Python broad-except path.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

import * as config from "./config.js";
import * as paths from "./paths.js";
import * as self from "./image_shrink.js";
import * as session from "./session.js";
import { registerReset } from "./reset.js";
import { getLogger } from "./util.js";

const _LOG = getLogger("image_shrink");

// One-shot orphan sweep flag: set to true after the sweep runs in this process.
// Module init fires the sweep once, idempotent across repeated imports.
let _sweep_done = false;

/**
 * Maximum pixel count on the long axis after resizing. 1024 px keeps the image
 * legible for Claude while roughly halving token cost versus the Claude API's
 * own 1568 px ceiling (see CLAUDE_MAX_VISION_EDGE_PX below).
 */
export const MAX_LONG_EDGE = 1024;

/**
 * Images smaller than this are already cheap enough to send unmodified.
 * 100 KB is a conservative threshold: most PNGs below this size are small icons
 * or diagrams whose pixel area is already within Claude's efficient range.
 */
export const SIZE_THRESHOLD_BYTES = 100 * 1024;

// Per-format lower bound below which a re-encode is unlikely to pay off.
// JPEG / WebP / AVIF are already lossy-compressed by their producer, so files
// in the 32-100 KB band are usually already efficient and the encode cost
// outweighs any token savings. PNG / BMP / TIFF / GIF are either lossless or
// weakly compressed: a 40 KB PNG screenshot typically drops to 12-20 KB as
// lossless WebP at zero quality loss, so we lower the threshold for those.
// Falls back to SIZE_THRESHOLD_BYTES for any unrecognized suffix.
const _LOSSY_FORMAT_THRESHOLD_BYTES = SIZE_THRESHOLD_BYTES; // JPEG/WebP/AVIF
export const _LOSSLESS_FORMAT_THRESHOLD_BYTES = 32 * 1024; // PNG/BMP/TIFF/GIF

const _LOSSY_INPUT_SUFFIXES: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
]);
const _LOSSLESS_INPUT_SUFFIXES: ReadonlySet<string> = new Set([
  ".png",
  ".bmp",
  ".tiff",
  ".tif",
  ".gif",
]);

/**
 * Return the per-format byte threshold below which shrink is a no-op.
 *
 * Recognises lossy producer formats (JPEG, WebP, AVIF) and gives them the
 * historical SIZE_THRESHOLD_BYTES (100 KB) — bytes in those formats are likely
 * already efficient, so a re-encode is pure CPU overhead until the file is
 * genuinely large. PNG / BMP / TIFF / GIF inputs get the smaller
 * _LOSSLESS_FORMAT_THRESHOLD_BYTES (32 KB) because lossless inputs at modest
 * size still compress meaningfully when re-emitted as lossless WebP or as the
 * configured lossy format.
 *
 * Unknown extensions fall back to SIZE_THRESHOLD_BYTES so any new image format
 * that arrives at the hook is treated conservatively (no over-eager shrink).
 *
 * `pathOrSuffix` is a string (a path or a bare ".png"-style suffix) — the
 * Python `str | Path` union collapses to `string` in the TS port.
 */
export function format_threshold(pathOrSuffix: string): number {
  let suffix = pathOrSuffix.toLowerCase();
  if (!suffix.startsWith(".")) {
    suffix = path.extname(pathOrSuffix).toLowerCase();
  }
  if (_LOSSLESS_INPUT_SUFFIXES.has(suffix)) {
    return _LOSSLESS_FORMAT_THRESHOLD_BYTES;
  }
  return _LOSSY_FORMAT_THRESHOLD_BYTES;
}

/**
 * JPEG quality for photographic output. 75 is the standard "high quality"
 * threshold: visually lossless for natural images, typically 5-20x smaller than
 * lossless PNG, and well within what Claude's vision model can read accurately.
 */
export const JPEG_QUALITY = 75;

/**
 * WebP quality for photographic output. WebP at q=80 typically produces files
 * 30-50% smaller than JPEG at q=75 on screenshot/UI/text content while
 * preserving more edge fidelity. Claude's vision API accepts image/webp
 * natively, so emitting WebP is a strict token-cost reduction with no
 * compatibility cost.
 */
export const WEBP_QUALITY = 80;
/**
 * WebP encoder method/effort: 0 (fast) - 6 (slow, best compression). Method 6
 * squeezes out an additional 5-10% versus the default 4. For 1024 px images
 * this is still well within the hook budget. (sharp calls this `effort`.)
 */
export const WEBP_METHOD = 6;

/**
 * AVIF quality for output when the runtime image library can encode AVIF.
 * Quality 60 is perceptually equivalent to JPEG quality 85 and typically
 * 30-50% smaller. Applied only to images > SIZE_THRESHOLD_BYTES and only when
 * avif_supported() resolves true.
 */
export const AVIF_QUALITY = 60;

// Output format for lossy compression. Defaults to WebP because it produces
// meaningfully smaller files than JPEG on the typical content the hook sees
// (screenshots, UI, diagrams with text). Set TOKEN_GOAT_IMAGE_FORMAT=jpeg to
// fall back to JPEG.
const _ENV_IMAGE_FORMAT = "TOKEN_GOAT_IMAGE_FORMAT";
const _DEFAULT_LOSSY_FORMAT = "webp";

/**
 * Cached AVIF-capability probe. Python uses functools.lru_cache(maxsize=1) over
 * a synchronous probe; sharp's capability is exposed synchronously via
 * sharp.format, but we keep a memoized Promise to mirror the async public
 * surface and so the cache can be cleared between tests.
 */
let _avifSupportedCache: Promise<boolean> | undefined = undefined;

/**
 * Return true if the runtime image library can encode AVIF images.
 *
 * In Python this requires Pillow built with libaom. In the TS port it requires
 * sharp/libvips built with an AVIF (heif) encoder — probed via
 * sharp.format.heif.output / sharp.format.avif.output. The result is cached
 * after the first call. Falls back gracefully to false on any error so callers
 * can treat this as a capability probe without try/except at every call site.
 */
export function avif_supported(): Promise<boolean> {
  if (_avifSupportedCache === undefined) {
    _avifSupportedCache = (async (): Promise<boolean> => {
      try {
        const fmt = sharp.format as unknown as Record<
          string,
          { output?: { buffer?: boolean; file?: boolean } } | undefined
        >;
        const avif = fmt["avif"];
        const heif = fmt["heif"];
        const avifOut = Boolean(avif?.output?.buffer ?? avif?.output?.file);
        const heifOut = Boolean(heif?.output?.buffer ?? heif?.output?.file);
        return avifOut || heifOut;
      } catch {
        return false;
      }
    })();
  }
  return _avifSupportedCache;
}

/** Drop the cached avif_supported() result (Python avif_supported.cache_clear()). */
export function _avifSupportedCacheClear(): void {
  _avifSupportedCache = undefined;
}

/**
 * Cache key version. Bumped whenever the compression pipeline changes in a way
 * that would produce different bytes for the same input — quality knobs, format
 * selection, downscale algorithm. Included in the content hash so old cache
 * entries are silently superseded rather than serving stale output.
 */
export const CACHE_KEY_VERSION = 3;

/**
 * Claude vision API parameters (source: Anthropic docs). Claude downscales
 * images to fit within this many pixels on the long edge before tokenizing; the
 * cost formula is (effective_width * effective_height) / pixels_per_token.
 */
export const CLAUDE_MAX_VISION_EDGE_PX = 1568;
export const CLAUDE_VISION_PIXELS_PER_TOKEN = 750;

/**
 * Heuristic max long-edge for images that look like screenshots or text
 * (palette/alpha modes at reasonable sizes). Set just below
 * CLAUDE_MAX_VISION_EDGE_PX (1568): an image this large and still in
 * palette/alpha mode is almost certainly a photograph mislabelled by its
 * encoder, not a UI screenshot.
 */
const _SCREENSHOT_MAX_EDGE_PX = 1500;

/**
 * Hard pixel-count cap applied at module load time. A 90 KB JPEG can decode to
 * a 200 MB+ bitmap; without a cap the hook process RSS spikes silently on
 * tight-memory machines. sharp rejects with `limitInputPixels` exceeded, which
 * shrink() catches and returns null (skip) rather than crashing the hook.
 * Override with TOKEN_GOAT_MAX_IMAGE_PIXELS=<n> (set to 0 to disable the cap).
 *
 * Exported as a mutable binding so tests can lower it (Python monkeypatches the
 * module global). ES `let` exports are read-only from outside, so the test
 * setter _setMaxPixels rebinds it.
 */
export let _MAX_PIXELS: number = Number.parseInt(
  process.env.TOKEN_GOAT_MAX_IMAGE_PIXELS ?? "16000000",
  10,
);
if (Number.isNaN(_MAX_PIXELS)) {
  _MAX_PIXELS = 16000000;
}

/** Test seam: override _MAX_PIXELS (Python monkeypatch.setattr(image_shrink, "_MAX_PIXELS", n)). */
export function _setMaxPixels(n: number): void {
  _MAX_PIXELS = n;
}

/**
 * Recognized image extensions — the pre-read hook uses this set to decide
 * whether to attempt shrinking before the image is read into context.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
  ".bmp",
  ".gif",
]);

/**
 * Return true if `p` has a recognised image extension (case-insensitive).
 * Only checks the extension string — does not open the file or verify content.
 * Used as a fast pre-filter before the more expensive stat/decode operations.
 */
export function is_image_path(p: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/**
 * sha256 of the image's content, prefixed with the cache key version.
 *
 * Content-addressing means identical images share one cache entry regardless of
 * where they live, and any real content change invalidates the entry while a
 * bare mtime touch does not. The CACHE_KEY_VERSION prefix means changing the
 * compression pipeline automatically supersedes old cache entries.
 *
 * Uses streaming 1 MB chunks to avoid memory spikes on large images. On read
 * error, falls back to a path-based hash (matching Python's OSError branch).
 */
function _cache_key(src_path: string): string {
  try {
    const h = crypto.createHash("sha256");
    h.update(Buffer.from(`v${CACHE_KEY_VERSION}\n`, "utf8"));
    const chunkSize = 1 << 20; // 1 MB
    const fd = fs.openSync(src_path, "r");
    try {
      const buf = Buffer.allocUnsafe(chunkSize);
      for (;;) {
        const bytesRead = fs.readSync(fd, buf, 0, chunkSize, null);
        if (bytesRead === 0) break;
        h.update(buf.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest("hex");
  } catch (exc) {
    _LOG.debug(
      "_cache_key: could not read %s for content hash, falling back to path hash: %s",
      path.basename(src_path),
      String(exc),
    );
    return crypto
      .createHash("sha256")
      .update(Buffer.from(`v${CACHE_KEY_VERSION}|${src_path}`, "utf8"))
      .digest("hex");
  }
}

/** Return the source file's mtime (seconds, float), or 0.0 if unreadable. */
function _get_source_mtime(src_path: string): number {
  try {
    return fs.statSync(src_path).mtimeMs / 1000;
  } catch {
    return 0.0;
  }
}

/**
 * Store the source file's mtime in a companion .mtime sidecar file. The sidecar
 * is a simple text file containing a single float timestamp. Fail-soft: any IO
 * error is logged but does not block the shrink.
 */
function _store_source_mtime(cache_path: string, src_mtime: number): void {
  const mtime_path = `${cache_path}.mtime`;
  try {
    fs.writeFileSync(mtime_path, src_mtime.toFixed(6));
  } catch (exc) {
    _LOG.debug(
      "_store_source_mtime: failed to write sidecar for %s: %s",
      path.basename(cache_path),
      String(exc),
    );
  }
}

/**
 * Load the stored source file's mtime from the companion .mtime sidecar file.
 *
 * Returns null if the sidecar does not exist or is unreadable; this signals
 * "cache hit but no mtime record" which is treated as a valid (unverified)
 * cache hit for backwards compatibility with existing cached entries.
 */
function _load_source_mtime(cache_path: string): number | null {
  const mtime_path = `${cache_path}.mtime`;
  try {
    if (!fs.existsSync(mtime_path)) {
      return null;
    }
    const text = fs.readFileSync(mtime_path, "utf8").trim();
    const val = Number.parseFloat(text);
    if (Number.isNaN(val)) {
      return null;
    }
    return val;
  } catch (exc) {
    _LOG.debug(
      "_load_source_mtime: failed to read sidecar for %s: %s",
      path.basename(cache_path),
      String(exc),
    );
    return null;
  }
}

/**
 * Return the base cache path (stem only) for `src_path`, e.g. `<dir>/<hash>.shrunk`.
 *
 * The actual output file is one of `<hash>.shrunk.avif` / `.webp` / `.jpg` /
 * `.png`. Callers probe all four suffixes when checking for a cache hit, so
 * switching the lossy format at runtime still correctly re-uses an existing
 * cached output if one is present in any format.
 */
export function _cache_path_for(src_path: string): string {
  const key = _cache_key(src_path);
  return path.join(paths.imageCacheDir(), `${key}.shrunk`);
}

/**
 * Return the lossy output format selected at runtime. Defaults to WebP; falls
 * back to JPEG when TOKEN_GOAT_IMAGE_FORMAT=jpeg (or jpg). Any other value logs
 * a warning and falls back to the default, so a typo in the env var can never
 * silently disable image shrinking.
 */
function _lossy_format(): "webp" | "jpeg" {
  const raw = (process.env[_ENV_IMAGE_FORMAT] ?? "").trim().toLowerCase();
  if (raw === "" || raw === _DEFAULT_LOSSY_FORMAT) {
    return _DEFAULT_LOSSY_FORMAT;
  }
  if (raw === "jpeg" || raw === "jpg") {
    return "jpeg";
  }
  if (raw === "webp") {
    return "webp";
  }
  _LOG.warning(
    "Unknown %s=%s; expected webp or jpeg, using default %s",
    _ENV_IMAGE_FORMAT,
    raw,
    _DEFAULT_LOSSY_FORMAT,
  );
  return _DEFAULT_LOSSY_FORMAT;
}

/**
 * Memo for vision_tokens (Python functools.lru_cache(maxsize=256)). Keyed by
 * "w,h". Cleared by reset.ts so per-test isolation holds.
 */
const _visionTokensMemo = new Map<string, number>();

/**
 * Approximate Claude vision token cost for an image of given dimensions.
 *
 * Claude resizes images to fit within CLAUDE_MAX_VISION_EDGE_PX on the long
 * edge before tokenizing. Token cost ~ (effective_width * effective_height) /
 * CLAUDE_VISION_PIXELS_PER_TOKEN.
 */
export function vision_tokens(width: number, height: number): number {
  const memoKey = `${width},${height}`;
  const cached = _visionTokensMemo.get(memoKey);
  if (cached !== undefined) {
    return cached;
  }
  let result: number;
  if (width <= 0 || height <= 0) {
    result = 0;
  } else {
    let w = width;
    let h = height;
    if (Math.max(w, h) > CLAUDE_MAX_VISION_EDGE_PX) {
      const scale = CLAUDE_MAX_VISION_EDGE_PX / Math.max(w, h);
      w = Math.trunc(w * scale);
      h = Math.trunc(h * scale);
    }
    result = Math.max(1, Math.trunc((w * h) / CLAUDE_VISION_PIXELS_PER_TOKEN));
  }
  _visionTokensMemo.set(memoKey, result);
  return result;
}

/** Return value of stats_for(): per-image compression telemetry. */
export interface ImageStats {
  src_bytes: number;
  out_bytes: number;
  bytes_saved: number;
  orig_width: number;
  orig_height: number;
  out_width: number;
  out_height: number;
}

/**
 * Minimal decoded-image view used by the screenshot/text heuristic. sharp
 * surfaces these via metadata(): channels, hasAlpha, the colour space (grayscale
 * is "b-w"), and a palette flag. Together they reconstruct Pillow's mode check
 * (P / L / LA / RGBA).
 */
interface ImageModeMeta {
  width: number;
  height: number;
  channels?: number;
  hasAlpha?: boolean;
  space?: string;
  isPalette?: boolean;
}

/**
 * Return true if the image is likely a screenshot, diagram, or UI capture.
 *
 * Palette (P), grayscale (L/LA), and RGBA modes with sharp edges compress
 * poorly under JPEG due to ringing artefacts near hard colour boundaries. PNG
 * is the correct format for these images because it is lossless. We only apply
 * this heuristic up to _SCREENSHOT_MAX_EDGE_PX: larger images are almost
 * certainly photographs regardless of their mode and are better served by JPEG.
 *
 * Python checks `img.mode in ("L", "LA", "P", "RGBA")`. The TS equivalent over
 * sharp metadata: palette, OR grayscale (space "b-w"), OR has an alpha channel.
 */
function _looks_like_screenshot_or_text(img: ImageModeMeta): boolean {
  const w = img.width;
  const h = img.height;
  const isGray = img.space === "b-w" || img.space === "grey16";
  const isPaletteOrAlphaOrGray = Boolean(
    img.isPalette || img.hasAlpha || isGray,
  );
  return isPaletteOrAlphaOrGray && Math.max(w, h) <= _SCREENSHOT_MAX_EDGE_PX;
}

/**
 * Return true if this image is large enough to be worth compressing.
 *
 * Uses a single stat() call to check size. Skips non-regular files. Returns
 * false on any OS error rather than raising so callers can treat the answer as
 * a conservative hint, not a guarantee.
 *
 * The per-format threshold from format_threshold lets PNG / BMP / TIFF / GIF
 * inputs cross the bar at 32 KB while JPEG / WebP / AVIF inputs still need 100
 * KB.
 */
export function should_shrink(src_path: string): boolean {
  try {
    if (!is_image_path(src_path)) {
      return false;
    }
    const st = fs.statSync(src_path); // single syscall; throws ENOENT if absent
    return st.isFile() && st.size > format_threshold(src_path);
  } catch (exc) {
    _LOG.debug("should_shrink: stat failed for %s: %s", src_path, String(exc));
    return false;
  }
}

/**
 * Validate path is absolute and exists (Python _is_safe_path). Resolve to catch
 * any .. or symlink tricks; the path must exist to be processable.
 */
function _is_safe_path(p: string): boolean {
  try {
    if (!path.isAbsolute(p)) {
      return false;
    }
    const resolved = fs.realpathSync(p);
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

/**
 * One-shot cleanup of orphan image-cache blobs (files older than
 * orphan_age_secs). An orphan is a `.shrunk.*` blob in the image cache that was
 * written but never looked up.
 *
 * Runs once per process (guarded by _sweep_done) at first shrink() so the LRU
 * eviction does not have to compete with dead bytes. Fail-soft: any IO error is
 * logged as a warning and the sweep skips to the next file without crashing.
 * Never raises.
 *
 * The age threshold is configurable via config [image_shrink] orphan_age_secs
 * (default 7 days) or disabled via orphan_sweep_enabled=false.
 */
export function _sweep_orphans(): void {
  if (_sweep_done) {
    return;
  }
  _sweep_done = true;

  let age_secs: number;
  try {
    const _cfg = config.load();
    if (!(_cfg.image_shrink?.orphan_sweep_enabled ?? true)) {
      _LOG.debug("_sweep_orphans: disabled by config");
      return;
    }
    age_secs = _cfg.image_shrink?.orphan_age_secs ?? 604800;
  } catch (exc) {
    _LOG.debug("_sweep_orphans: config load failed, skipping: %s", String(exc));
    return;
  }

  const cache_dir = paths.imageCacheDir();
  let isDir = false;
  try {
    isDir = fs.statSync(cache_dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return;
  }

  const now = Date.now() / 1000;
  let removed = 0;
  const _orphanSuffixes = [
    ".shrunk.avif",
    ".shrunk.webp",
    ".shrunk.jpg",
    ".shrunk.png",
  ];
  let entries: string[];
  try {
    entries = fs.readdirSync(cache_dir);
  } catch (exc) {
    _LOG.debug("_sweep_orphans: directory scan failed: %s", String(exc));
    return;
  }
  for (const name of entries) {
    if (!_orphanSuffixes.some((s) => name.endsWith(s))) {
      continue;
    }
    const fp = path.join(cache_dir, name);
    try {
      const st = fs.statSync(fp);
      const age = now - st.mtimeMs / 1000;
      if (age > age_secs) {
        fs.unlinkSync(fp);
        removed += 1;
        _LOG.debug(
          "_sweep_orphans: removed %s (age=%s days)",
          name,
          (age / 86400.0).toFixed(1),
        );
      }
    } catch (exc) {
      _LOG.debug("_sweep_orphans: failed to remove %s: %s", name, String(exc));
      continue;
    }
  }

  if (removed > 0) {
    _LOG.info("_sweep_orphans: removed %d orphan blob(s)", removed);
  }
}

// Minimum free-disk-space required before writing a shrunk image to the cache.
// Below this threshold the shrink is skipped and the original path is returned
// so a full disk doesn't stall the hook with a partial-write crash.
// Configurable via TOKEN_GOAT_MIN_FREE_MB (integer MiB).
let _MIN_FREE_MB = Number.parseInt(process.env.TOKEN_GOAT_MIN_FREE_MB ?? "50", 10);
if (Number.isNaN(_MIN_FREE_MB)) {
  _MIN_FREE_MB = 50;
}
const _MIN_FREE_BYTES = _MIN_FREE_MB * 1024 * 1024;

/**
 * Return true if there is at least _MIN_FREE_BYTES free on `p`'s filesystem.
 * Falls back to true (fail-open) on any error so a transient stat failure never
 * prevents a shrink that could succeed. Uses fs.statfsSync (the Node analogue of
 * shutil.disk_usage).
 */
function _check_disk_space(p: string): boolean {
  try {
    const st = fs.statfsSync(p);
    const free = st.bavail * st.bsize;
    return free >= _MIN_FREE_BYTES;
  } catch {
    return true; // fail-open
  }
}

/**
 * Per-session shrink tracking (Python's inline _session_id block). Best-effort:
 * any error is benign and logged. Mutates the session cache in memory; the
 * hook's post-read handler persists it.
 */
function _track_session_shrink(src_path: string, _session_id: string): void {
  try {
    const _sess = session.safe_load(_session_id);
    if (_sess && !_sess.unavailable) {
      // Use the resolved absolute path as the per-image key so the same physical
      // file is always tracked under one key even via different paths.
      let _img_key: string;
      try {
        _img_key = fs.realpathSync(src_path);
      } catch {
        _img_key = path.resolve(src_path);
      }
      const _shrink_count = (_sess.image_shrink_count[_img_key] ?? 0) + 1;
      _sess.image_shrink_count[_img_key] = _shrink_count;
      const _img_cap = session.IMAGE_SHRINK_COUNT_MAX;
      const _img_evict = session._IMAGE_SHRINK_COUNT_EVICT;
      if (Object.keys(_sess.image_shrink_count).length > _img_cap) {
        const _sorted_img = Object.entries(_sess.image_shrink_count).sort(
          (a, b) => a[1] - b[1],
        );
        _sess.image_shrink_count = Object.fromEntries(
          _sorted_img.slice(_img_evict),
        );
      }
      // Log once every 10 shrinks to avoid log spam when count > 3.
      if (_shrink_count > 3 && _shrink_count % 10 === 1) {
        _LOG.info(
          "image %s has been shrunk %d times in this session; consider using token-goat read/section for surgical access",
          path.basename(src_path),
          _shrink_count,
        );
      }
    }
  } catch (exc) {
    _LOG.debug("image_shrink: per-session tracking failed: %s", String(exc));
  }
}

/**
 * Compress and cache a large image; return the cached output path, or null on
 * failure.
 *
 * Processing pipeline:
 * 1. Safety and threshold checks (path traversal guard, extension, size).
 * 2. Content-addressed cache lookup.
 * 3. Open with sharp, applying EXIF orientation.
 * 4. Resize to fit within MAX_LONG_EDGE on the longest axis (lanczos3).
 * 5. Format selection (PNG for alpha screenshots, AVIF/WebP/JPEG otherwise).
 * 6. Log size reduction percentage for telemetry.
 *
 * `_session_id` (internal, optional): used to track per-session shrink budgets.
 * Callers should not set this directly; it is for use by hooks that have
 * session context.
 *
 * Returns null (never rejects) on any decode, OS, or memory error. Callers treat
 * null as "use original path". On success returns the cached output path.
 */
export async function shrink(
  src_path: string,
  opts: { _session_id?: string } = {},
): Promise<string | null> {
  const _session_id = opts._session_id;
  // Fire the one-shot orphan sweep on first shrink call in this process.
  self._sweep_orphans();

  // Track per-session shrink count to detect repeated shrinking of the same
  // image. Best-effort: skipped (fail-soft) if the session is unavailable.
  if (_session_id) {
    _track_session_shrink(src_path, _session_id);
  }

  const t0 = Date.now();
  // Validate input path for safety.
  if (!_is_safe_path(src_path)) {
    _LOG.warning("rejected unsafe path: %s", src_path);
    return null;
  }
  // Guard: extension check first (cheap string op) then size (one stat syscall).
  if (!is_image_path(src_path)) {
    return null;
  }
  let src_size: number;
  try {
    src_size = fs.statSync(src_path).size;
  } catch {
    return null;
  }
  if (src_size <= format_threshold(src_path)) {
    return null;
  }

  // Animated images (multi-frame GIF, animated WebP, APNG) cannot be
  // meaningfully compressed to a single-frame output without losing the
  // animation. Check before the cache lookup. Only open for formats that can
  // carry animation — avoids overhead on the common JPEG/PNG path.
  const _animated_suffixes: ReadonlySet<string> = new Set([
    ".gif",
    ".webp",
    ".png",
  ]);
  if (_animated_suffixes.has(path.extname(src_path).toLowerCase())) {
    try {
      // animated:true makes sharp count every frame/page (the Pillow
      // is_animated / n_frames analogue) for GIF / WebP / APNG alike.
      const meta = await sharp(src_path, {
        limitInputPixels: _MAX_PIXELS > 0 ? _MAX_PIXELS : false,
        animated: true,
      }).metadata();
      const pages = meta.pages ?? 1;
      if (pages > 1) {
        _LOG.debug(
          "shrink: skipping animated image %s (n_frames=%d)",
          path.basename(src_path),
          pages,
        );
        return null;
      }
    } catch {
      // Unreadable or exotic format; fall through to normal pipeline.
    }
  }

  // Disk-space guard: check free space on the cache volume before writing.
  const cache_vol = paths.imageCacheDir();
  paths.ensureDir(paths.imageCacheDir());
  if (!_check_disk_space(cache_vol)) {
    _LOG.warning(
      "shrink: skipping %s — less than %d MB free on cache volume",
      path.basename(src_path),
      _MIN_FREE_MB,
    );
    return null;
  }

  const stem = _cache_path_for(src_path); // e.g. .../abc123.shrunk
  // Check for already-cached variants in any supported output format.
  const lossy_fmt = _lossy_format();
  const lossy_suffix = lossy_fmt !== "jpeg" ? `.${lossy_fmt}` : ".jpg";
  const suffixes = [".avif", lossy_suffix].concat(
    [".webp", ".jpg", ".png"].filter(
      (s) => s !== ".avif" && s !== lossy_suffix,
    ),
  );

  // Get the current source file's mtime for validation on cache hit.
  const src_mtime = _get_source_mtime(src_path);

  for (const suffix of suffixes) {
    const candidate = `${stem}${suffix}`;
    if (fs.existsSync(candidate)) {
      // Staleness: if the source was updated after the cache was created, the
      // cached version is stale and needs re-shrinking.
      const stored_mtime = _load_source_mtime(candidate);
      if (
        stored_mtime !== null &&
        src_mtime !== 0.0 &&
        src_mtime > stored_mtime
      ) {
        _LOG.debug(
          "image cache staleness detected: %s mtime=%s > stored=%s, will re-shrink from %s",
          path.basename(candidate),
          src_mtime.toFixed(2),
          stored_mtime.toFixed(2),
          path.basename(src_path),
        );
        try {
          fs.unlinkSync(candidate);
        } catch (unlinkExc) {
          _LOG.debug(
            "failed to unlink stale cache file %s: %s",
            path.basename(candidate),
            String(unlinkExc),
          );
        }
        try {
          const mtime_sidecar = `${candidate}.mtime`;
          if (fs.existsSync(mtime_sidecar)) {
            fs.unlinkSync(mtime_sidecar);
          }
        } catch {
          // ignore
        }
        continue; // Try next suffix or fall through to re-shrink.
      }

      // Validate that the cached image is readable. A truncated cache file
      // (partial write from an interrupted shrink) makes sharp reject. If the
      // cached file is corrupt, delete it, log, and fall through to re-shrink.
      try {
        await sharp(candidate, {
          limitInputPixels: _MAX_PIXELS > 0 ? _MAX_PIXELS : false,
        }).metadata();
      } catch (exc) {
        _LOG.warning(
          "image cache validation failed: %s (%s), will re-shrink from %s",
          path.basename(candidate),
          excName(exc),
          path.basename(src_path),
        );
        try {
          fs.unlinkSync(candidate);
        } catch (unlinkExc) {
          _LOG.debug(
            "failed to unlink corrupt cache file %s: %s",
            path.basename(candidate),
            String(unlinkExc),
          );
        }
        continue; // Try next suffix or fall through to re-shrink.
      }

      const elapsed = (Date.now() - t0) / 1000;
      _LOG.debug(
        "image cache hit: %s -> %s (%ss)",
        path.basename(src_path),
        path.basename(candidate),
        elapsed.toFixed(3),
      );
      // Bump mtime so the LRU evictor treats a frequently-hit cache entry as
      // recently-used. Only bump if last touched >1 hour ago.
      try {
        const nowSec = Date.now() / 1000;
        const st = fs.statSync(candidate);
        if (nowSec - st.mtimeMs / 1000 > 3600) {
          const nowDate = new Date(nowSec * 1000);
          fs.utimesSync(candidate, nowDate, nowDate);
        }
      } catch {
        // Benign — cache still works, just loses a little LRU fidelity.
      }
      return candidate;
    }
  }

  try {
    // sharp pipeline. limitInputPixels enforces the DecompressionBomb cap.
    const pipeline = sharp(src_path, {
      limitInputPixels: _MAX_PIXELS > 0 ? _MAX_PIXELS : false,
    });
    const meta = await pipeline.metadata();

    const _w0 = meta.width ?? 0;
    const _h0 = meta.height ?? 0;
    const _pixel_count = _w0 * _h0;
    if (_MAX_PIXELS > 0 && _pixel_count > Math.trunc(_MAX_PIXELS / 2)) {
      _LOG.debug(
        "shrink: large bitmap %s (%dx%d = %d pixels, cap=%d)",
        path.basename(src_path),
        _w0,
        _h0,
        _pixel_count,
        _MAX_PIXELS,
      );
    }

    // Preserve EXIF orientation — sharp.rotate() with no argument auto-orients
    // from the EXIF Orientation tag (the analogue of ImageOps.exif_transpose).
    let work = pipeline.rotate();

    // After auto-rotate, the effective dimensions may swap. sharp applies the
    // rotation lazily; compute the post-orientation size for the resize math.
    let w = _w0;
    let h = _h0;
    const orientation = meta.orientation ?? 1;
    if (orientation >= 5 && orientation <= 8) {
      // 90/270-degree EXIF orientations swap width and height.
      [w, h] = [h, w];
    }

    // Resize if needed.
    const long_edge = Math.max(w, h);
    if (long_edge > MAX_LONG_EDGE) {
      const scale = MAX_LONG_EDGE / long_edge;
      const newW = Math.trunc(w * scale);
      const newH = Math.trunc(h * scale);
      work = work.resize(newW, newH, {
        kernel: "lanczos3",
        fit: "fill",
      });
      w = newW;
      h = newH;
    }

    // Reconstruct Pillow's mode predicate from sharp metadata.
    const modeMeta: ImageModeMeta = {
      width: w,
      height: h,
      ...(meta.channels !== undefined ? { channels: meta.channels } : {}),
      ...(meta.hasAlpha !== undefined ? { hasAlpha: meta.hasAlpha } : {}),
      ...(meta.space !== undefined ? { space: meta.space } : {}),
      // sharp reports a palette via paletteBitDepth on PNG, and GIF is always
      // palette-mode (Pillow "P"). Either signals a palette image.
      isPalette: Boolean(
        (meta as { paletteBitDepth?: number }).paletteBitDepth ??
          (meta.format === "gif" ? 1 : 0),
      ),
    };
    const is_screenshot = _looks_like_screenshot_or_text(modeMeta);

    let final_path: string;
    if (is_screenshot && Boolean(meta.hasAlpha)) {
      // Keep PNG with alpha for screenshots — lossless, alpha-safe. Strip
      // metadata to match Pillow's default (no EXIF carry-through).
      final_path = `${stem}.png`;
      await work
        .png({ compressionLevel: 9, palette: false })
        .toFile(final_path);
    } else {
      // Flatten to RGB (white background) and emit the best available lossy
      // format. sharp's flatten() composites alpha over the given background,
      // which avoids the black-fill artefact a bare alpha-drop produces.
      work = work.flatten({ background: { r: 255, g: 255, b: 255 } });

      const _cfg = config.load();
      const _is = _cfg.image_shrink ?? {};
      // TOKEN_GOAT_IMAGE_FORMAT=jpeg is an explicit override that forces JPEG
      // and disables AVIF — a downstream compatibility constraint that trumps
      // the prefer_avif preference.
      const _explicit_fmt = _lossy_format();
      const use_avif =
        _explicit_fmt !== "jpeg" &&
        Boolean(_is.prefer_avif ?? true) &&
        (await self.avif_supported());

      if (use_avif) {
        final_path = `${stem}.avif`;
        await work
          .avif({ quality: _is.avif_quality ?? AVIF_QUALITY })
          .toFile(final_path);
      } else {
        const fmt = _lossy_format();
        if (fmt === "webp") {
          final_path = `${stem}.webp`;
          // Diagrams (portrait-dominant) contain sharp lines, text labels, and
          // hard colour boundaries that degrade visibly under lossy WebP. Use
          // lossless for these so the model can read annotations accurately.
          const _is_diagram = h > 0 && w > 0 && h / w >= 1.4;
          if (_is_diagram) {
            await work
              .webp({ lossless: true, effort: WEBP_METHOD })
              .toFile(final_path);
          } else {
            await work
              .webp({ quality: WEBP_QUALITY, effort: WEBP_METHOD })
              .toFile(final_path);
          }
        } else {
          final_path = `${stem}.jpg`;
          await work
            .jpeg({
              quality: _is.jpeg_quality ?? JPEG_QUALITY,
              progressive: true,
              mozjpeg: false,
              optimiseScans: true,
              optimiseCoding: true,
            })
            .toFile(final_path);
        }
      }
    }

    const out_size = fs.statSync(final_path).size;
    const savings_pct = src_size > 0 ? 100.0 * (1.0 - out_size / src_size) : 0.0;
    const elapsed = (Date.now() - t0) / 1000;
    _LOG.info(
      "shrink: %s -> %s | %d -> %d bytes (%s%% reduction, %ss)",
      path.basename(src_path),
      path.extname(final_path),
      src_size,
      out_size,
      savings_pct.toFixed(1),
      elapsed.toFixed(3),
    );

    // Store the source file's mtime in a sidecar so cache staleness can be
    // detected on future lookups.
    _store_source_mtime(final_path, src_mtime);

    return final_path;
  } catch (e) {
    const elapsed = (Date.now() - t0) / 1000;
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOSPC") {
      _LOG.warning(
        "shrink: disk full writing cache for %s — returning original path (%ss)",
        path.basename(src_path),
        elapsed.toFixed(3),
      );
    } else {
      _LOG.warning(
        "shrink failed for %s (%s): %s (%ss)",
        src_path,
        excName(e),
        String(e),
        elapsed.toFixed(3),
      );
    }
    return null;
  }
}

/** Return the constructor/error name of a thrown value (Python type(e).__name__). */
function excName(e: unknown): string {
  if (e instanceof Error) {
    return e.name || e.constructor.name;
  }
  return typeof e;
}

/**
 * Minimal decoded-image view for extract_image_summary. Models the bits the
 * Python code reads off a PIL Image: `.size` (a [w, h] tuple) and an EXIF
 * accessor `._getexif()` returning a tag->value map (tag 270 = ImageDescription).
 */
export interface ImageSummaryInput {
  size: readonly [number, number];
  getExif?: () => Record<number, unknown> | null | undefined;
}

/**
 * Build a short textual summary of an image for use as alt-text context.
 *
 * Returns a non-empty string of the form
 *   "[Image: screenshot ~1280x720, filename: foo.png]"
 * or, when an EXIF ImageDescription is present,
 *   "Some description. [Image: screenshot ~1280x720, filename: foo.png]"
 *
 * Classification:
 *  - screenshot: width/height ratio >= 1.4 (landscape-dominant)
 *  - diagram:    height/width ratio >= 1.4 (portrait-dominant)
 *  - image:      everything else (roughly square)
 *
 * Never raises; EXIF errors are silently swallowed.
 */
export function extract_image_summary(
  src_path: string,
  img: ImageSummaryInput,
): string {
  const [w, h] = img.size;
  let kind: string;
  if (h > 0 && w / h >= 1.4) {
    kind = "screenshot";
  } else if (w > 0 && h / w >= 1.4) {
    kind = "diagram";
  } else {
    kind = "image";
  }

  let summary = `[Image: ${kind} ~${w}x${h}, filename: ${path.basename(src_path)}]`;

  try {
    const exif = img.getExif ? img.getExif() : undefined;
    if (exif) {
      // EXIF tag 270 = ImageDescription
      const description = exif[270];
      if (
        description &&
        typeof description === "string" &&
        description.trim()
      ) {
        summary = `${description.trim()}. ${summary}`;
      }
    }
  } catch {
    // swallow
  }

  return summary;
}

/**
 * Create `cache_dir` (and any missing parents) idempotently and return it.
 * Separated from shrink() so tests can pre-create the cache directory with
 * known contents without triggering a full shrink cycle. Throws with added
 * path context if the directory cannot be created.
 */
export function ensure_cache_dir(cache_dir: string): string {
  try {
    paths.ensureDir(cache_dir);
  } catch (exc) {
    throw new Error(
      `image_shrink: cannot create cache directory ${cache_dir}: ${String(exc)}`,
    );
  }
  return cache_dir;
}

/**
 * Shrink `p` if it is a large image; return the (possibly shrunken) path.
 *
 * Centralises the "maybe shrink" pattern. Uses should_shrink() for a fast
 * pre-check before calling shrink(), avoiding decode overhead on small images
 * or non-image files. Throws TypeError if `p` is null/undefined.
 */
export async function shrink_if_image(p: string | null | undefined): Promise<string> {
  if (p === null || p === undefined) {
    throw new TypeError("shrink_if_image: path must not be None");
  }
  if (should_shrink(p)) {
    const shrunken = await shrink(p);
    if (shrunken !== null) {
      return shrunken;
    }
    _LOG.debug(
      "shrink_if_image: shrink returned None for %s, using original path",
      path.basename(p),
    );
  }
  return p;
}

/**
 * Compute compression telemetry for a source/shrunken image pair.
 *
 * Reads file sizes via stat and image dimensions via sharp. Both dimension
 * reads are best-effort: if either file is unreadable, the width/height fields
 * are 0 and only byte savings are reported. Returns an all-zero ImageStats on
 * any OS error rather than rejecting.
 *
 * `src_size_bytes` (optional): pre-computed source file size; avoids a redundant
 * stat() on the source file.
 */
export async function stats_for(
  src_path: string,
  shrunken_path: string,
  src_size_bytes?: number,
): Promise<ImageStats> {
  const _empty: ImageStats = {
    src_bytes: 0,
    out_bytes: 0,
    bytes_saved: 0,
    orig_width: 0,
    orig_height: 0,
    out_width: 0,
    out_height: 0,
  };
  try {
    if (!_is_safe_path(src_path) || !_is_safe_path(shrunken_path)) {
      _LOG.warning("rejected unsafe path in stats_for");
      return _empty;
    }
    const src_size =
      src_size_bytes !== undefined
        ? src_size_bytes
        : fs.statSync(src_path).size;
    const out_size = fs.statSync(shrunken_path).size;

    let orig_w = 0;
    let orig_h = 0;
    let out_w = 0;
    let out_h = 0;
    try {
      const limit = _MAX_PIXELS > 0 ? _MAX_PIXELS : false;
      try {
        const m = await sharp(src_path, { limitInputPixels: limit }).metadata();
        orig_w = m.width ?? 0;
        orig_h = m.height ?? 0;
      } catch {
        // Best effort; dimension reads are optional.
      }
      try {
        const m = await sharp(shrunken_path, {
          limitInputPixels: limit,
        }).metadata();
        out_w = m.width ?? 0;
        out_h = m.height ?? 0;
      } catch {
        // Best effort; dimension reads are optional.
      }
    } catch (exc) {
      _LOG.debug(
        "gather_stats: unexpected error reading dimensions for %s (%s): %s",
        path.basename(src_path),
        excName(exc),
        String(exc),
      );
    }

    return {
      src_bytes: src_size,
      out_bytes: out_size,
      bytes_saved: Math.max(0, src_size - out_size),
      orig_width: orig_w,
      orig_height: orig_h,
      out_width: out_w,
      out_height: out_h,
    };
  } catch {
    return _empty;
  }
}

// ---------------------------------------------------------------------------
// Module-global cache reset registration.
// ---------------------------------------------------------------------------
// _sweep_done is a process-once flag in Python; in tests several cases reset it
// explicitly (image_shrink._sweep_done = False). Register it for reset so each
// test starts fresh, and expose a setter so tests can flip it mid-body. The
// avif_supported memo and vision_tokens memo are also cleared per-test.

/** Test seam: read the one-shot orphan-sweep flag (Python image_shrink._sweep_done). */
export function _getSweepDone(): boolean {
  return _sweep_done;
}

/** Test seam: set the one-shot orphan-sweep flag (Python image_shrink._sweep_done = ...). */
export function _setSweepDone(v: boolean): void {
  _sweep_done = v;
}

registerReset(() => {
  _sweep_done = false;
  _avifSupportedCache = undefined;
  _visionTokensMemo.clear();
});
