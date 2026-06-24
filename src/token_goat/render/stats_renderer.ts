/**
 * Rich terminal renderer for token-goat stats — port of
 * src/token_goat/render/stats_renderer.py.
 *
 * Produces a multi-section ANSI display from a `StatsData` payload:
 *
 * 1. KPI tiles — three side-by-side cards (data saved, tokens saved, events)
 *    with period-over-period deltas and optional mini sparklines.
 * 2. By event kind — colour-barred table showing savings per tool-call type
 *    (Read, image_shrink, Grep, etc.).
 * 3. By source — collapsed view of the four user-facing mechanisms (image /
 *    hint / read / compact) plus an `other` catch-all.
 * 4. By day — tabular daily breakdown (top N rows by bytes).
 * 5. By project — tabular per-project breakdown (top N rows by bytes).
 * 6. Insights — motivational copy loaded from `stats_messages.json`.
 *
 * Entry point: `render_stats` — returns a ready-to-print ANSI string.
 *
 * Layout uses `_CONTENT_W` (clamped 80–140 columns) and a shared set of
 * column-width constants so all tables are visually aligned. Colour values come
 * from `ansi.C` (GitHub dark palette).
 *
 * Parity notes:
 *  - Every template string, column width, glyph, and number/byte humanization
 *    is copied verbatim — the Python tests assert on the rendered (ANSI-
 *    stripped) text.
 *  - Number formatting reproduces Python's f-string mini-language:
 *      f"{x:,.1f}" -> en-US thousands separator, exactly 1 decimal.
 *      f"{n:,}"    -> en-US thousands separator, integer.
 *      f"{x:.1f}%" -> 1 decimal, no thousands separator.
 *    These use Intl number formatting (`toLocaleString("en-US", ...)`).
 *  - `_fmt_delta` uses Python `round` (round-half-to-even) on the delta integer;
 *    reproduced by `_pyRoundInt`.
 *  - `stats_messages.json` is co-located with this module (same directory) and
 *    located via `import.meta.url`, mirroring Python's
 *    `Path(__file__).with_name("stats_messages.json")`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getLogger } from "../util.js";
import { RESET, C, fg, lerpRgb, padL, padR, stripAnsi, vlen } from "./ansi.js";
import type { RGB } from "./ansi.js";
import type {
  CommandStat,
  DayStat,
  KindStat,
  ProjectStat,
  SourceStat,
  StatsData,
} from "./types.js";

const _LOG = getLogger("render.stats_renderer");

// ── Number-format helpers (Python f-string mini-language parity) ─────────────

/** en-US thousands-separated integer string: Python f"{n:,}". */
export function _fmtIntComma(n: number): string {
  return n.toLocaleString("en-US", { useGrouping: true, maximumFractionDigits: 0 });
}

/** en-US thousands-separated, exactly-one-decimal string: Python f"{x:,.1f}". */
function _fmtFloat1Comma(x: number): string {
  return x.toLocaleString("en-US", {
    useGrouping: true,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** Exactly-one-decimal string with NO grouping: Python f"{x:.1f}". */
function _fmtFloat1(x: number): string {
  return x.toLocaleString("en-US", {
    useGrouping: false,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * Reproduce Python's `round(value)` -> nearest integer with ties-to-even
 * (banker's rounding). JS `Math.round` rounds half away from zero, so it
 * disagrees with Python on exact halves; only used here for `_fmt_delta`.
 */
function _pyRoundInt(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const diff = value - floor;
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) return floor + 1;
  if (diff < 0.5 - EPS) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// ── Module-level key functions ──────────────────────────────────────────────
// Python uses operator.attrgetter to avoid allocating a lambda per call.
const _key_day_events = (d: DayStat): number => d.events;
const _key_kind_bytes = (k: KindStat): number => k.bytes;
const _key_kind_tokens = (k: KindStat): number => k.tokens;

interface _InsightsMessages {
  biggestSaver: string;
  mostActive: string;
  tokenLeader: string;
}

interface _StatsMessages {
  bytesModeOnlyNote: string;
  sessionHintSplitNote: string;
  insights: _InsightsMessages;
}

// ── Layout constants ────────────────────────────────────────────────────────

// shutil.get_terminal_size(fallback=(100, 24)).columns — Node exposes the
// stdout column count when attached to a TTY; fall back to 100 otherwise to
// mirror the Python fallback.
const _TERM_W: number = process.stdout.columns ?? 100;
const _CONTENT_W: number = Math.min(Math.max(_TERM_W, 80), 140);
const _M = "  "; // left margin

// Table column visible widths (chars).
// "data saved" = 10, "tokens saved" = 12 — column widths match their headers.
const _COL_NAME = 18;
const _COL_DATA = 10;
const _COL_TOKENS = 12;
const _COL_SHARE = 6;
const _COL_EVENTS = 6;
// Gaps: 1 (name->bar) + 2 (bar->data) + 2 (data->tokens) + 2 (tokens->share) + 2 (share->events)
const _COLS_FIXED =
  _COL_NAME + 1 + 2 + _COL_DATA + 2 + _COL_TOKENS + 2 + _COL_SHARE + 2 + _COL_EVENTS;
const _BAR_W: number = Math.max(16, _CONTENT_W - _M.length * 2 - _COLS_FIXED);
const _RULE: string =
  _M + fg(...C.TEXT_DIM) + "─".repeat(_CONTENT_W - _M.length * 2) + RESET;

const _STATS_MESSAGES_FALLBACK: _StatsMessages = {
  bytesModeOnlyNote: "tracks bytes, not vision tokens",
  sessionHintSplitNote:
    "session_hint shows realized savings; session_hint_overhead shows injected hint cost",
  insights: {
    biggestSaver: "Biggest saver  ",
    mostActive: "Most active    ",
    tokenLeader: "Token leader   ",
  },
};

/**
 * Load the localised stats copy from the bundled `stats_messages.json` file.
 *
 * The JSON is co-located with this module (same directory) and contains display
 * strings for the Insights section — taglines, motivational quotes, and
 * milestone messages keyed by usage tier.
 *
 * Falls back to `_STATS_MESSAGES_FALLBACK` if the file is missing or malformed
 * so a corrupted or absent bundle does not crash the entire module at import
 * time and silently fall through to the legacy Rich renderer.
 */
function _load_stats_messages(): _StatsMessages {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.join(here, "stats_messages.json");
    return JSON.parse(readFileSync(p, "utf-8")) as _StatsMessages;
  } catch (exc) {
    _LOG.warning(
      `stats_messages.json unavailable (${String(exc)}); using built-in fallback`,
    );
    return _STATS_MESSAGES_FALLBACK;
  }
}

const _STATS_MESSAGES: _StatsMessages = _load_stats_messages();

// ── Formatters ──────────────────────────────────────────────────────────────

// Each entry: [threshold, divisor, unit_label, positive_color].
// Tiers are checked from largest to smallest; the last entry has threshold=0
// and is the base (sub-1000) case.
type _Tier = readonly [number, number, string, RGB];

const _BYTE_TIERS: _Tier[] = [
  [1_000_000_000_000_000, 1_000_000_000_000_000, "PB", C.PURPLE],
  [1_000_000_000_000, 1_000_000_000_000, "TB", C.BLUE],
  [1_000_000_000, 1_000_000_000, "GB", C.TEAL],
  [1_000_000, 1_000_000, "MB", C.GREEN4],
  [1_000, 1_000, "KB", C.TEXT_MUTED],
  [0, 1, "B", C.TEXT_DIM],
];

const _TOKEN_TIERS: _Tier[] = [
  [1_000_000_000_000, 1_000_000_000_000, "Tt", C.GREEN5],
  [1_000_000_000, 1_000_000_000, "Gt", C.TEAL],
  [1_000_000, 1_000_000, "Mt", C.PURPLE],
  [1_000, 1_000, "kt", C.BLUE],
  [0, 1, "t", C.TEXT_DIM],
];

/**
 * Format an integer as a human-readable magnitude string with ANSI color.
 *
 * Both byte and token formatters share this structure: negative values are
 * rendered dim with a minus-sign prefix; positive values use escalating colors
 * per tier. The caller supplies the tier table so the thresholds, divisors,
 * unit labels, and positive colors can differ between bytes and tokens.
 */
function _fmt_magnitude(
  n: number,
  tiers: _Tier[],
  zero_label?: string,
): string {
  if (zero_label !== undefined && n === 0) {
    return `${fg(...C.TEXT_DIM)}${zero_label}${RESET}`;
  }
  if (n < 0) {
    const a = -n;
    const color = C.TEXT_DIM;
    for (const [threshold, divisor, unit] of tiers) {
      if (a >= threshold && threshold > 0) {
        return `${fg(...color)}-${_fmtFloat1Comma(a / divisor)} ${unit}${RESET}`;
      }
    }
    // base case (threshold == 0)
    const last = tiers[tiers.length - 1]!;
    const unit = last[2];
    return `${fg(...color)}-${a} ${unit}${RESET}`;
  }
  for (const [threshold, divisor, unit, pos_color] of tiers) {
    if (n >= threshold && threshold > 0) {
      return `${fg(...pos_color)}${_fmtFloat1Comma(n / divisor)} ${unit}${RESET}`;
    }
  }
  // base case
  const last = tiers[tiers.length - 1]!;
  const unit = last[2];
  const pos_color = last[3];
  return `${fg(...pos_color)}${n} ${unit}${RESET}`;
}

/**
 * Format a byte count as a human-readable ANSI string (B/KB/MB/GB/…).
 *
 * Colour escalates with magnitude: dim (B) -> muted (KB) -> green (MB) ->
 * teal (GB) -> blue (TB) -> purple (PB). Negative values are rendered dim with
 * a leading minus sign.
 */
function _fmt_bytes(n: number): string {
  return _fmt_magnitude(n, _BYTE_TIERS);
}

/**
 * Format a token count as a human-readable ANSI string (t/kt/Mt/Gt/Tt).
 *
 * Zero renders as "0 t" (dim). Colour escalates with magnitude:
 * dim (t) -> blue (kt) -> purple (Mt) -> teal (Gt) -> bright-green (Tt).
 */
function _fmt_tokens(n: number): string {
  return _fmt_magnitude(n, _TOKEN_TIERS, "0 t");
}

/** Format a 0–1 fraction as a percentage string, e.g. 0.372 -> "37.2%". */
function _fmt_pct(fraction: number): string {
  return `${_fmtFloat1(fraction * 100)}%`;
}

/**
 * Format a period-over-period delta as a coloured "↑ N%" / "↓ N%" string.
 *
 * Returns an empty string when *delta* is null/undefined (data unavailable).
 * Positive deltas are green with an up-arrow; negative are red with a
 * down-arrow.
 */
function _fmt_delta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) {
    return "";
  }
  const up = delta >= 0;
  const color = up ? C.GREEN5 : C.RED;
  const arrow = up ? "↑" : "↓";
  return ` ${fg(...color)}${arrow} ${Math.abs(_pyRoundInt(delta))}%${RESET}`;
}

/** Format a date string as ISO-8601 (YYYY-MM-DD). (Already a string in TS.) */
function _fmt_date(d: string): string {
  return d;
}

// ── Bar renderer ────────────────────────────────────────────────────────────

const _EIGHTHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const _BLOCK = "█";
const _TRACK = "░"; // light-shade for unfilled track — visually distinct from █ without relying on color
const _GRADIENT: RGB[] = [C.GREEN1, C.GREEN2, C.GREEN3, C.GREEN4, C.GREEN5];

/** Distribute `total` chars across `n` gradient stops, extras to later (brighter) stops. */
function _distribute(total: number, n: number): number[] {
  if (total <= 0 || n <= 0) {
    return new Array<number>(Math.max(0, n)).fill(0);
  }
  const base = Math.floor(total / n);
  const rem = total % n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(base + (i >= n - rem ? 1 : 0));
  }
  return out;
}

/**
 * Render a uniform-width progress bar with a 5-stop green gradient fill and a
 * dim track. Sub-block characters (▏▎▍▌▋▊▉) provide sub-character precision at
 * the boundary.
 *
 * @param fraction Fill level 0–1.
 * @param width    Total character width; all bars must share the same value for
 *                 alignment.
 */
function _render_bar(fraction: number, width: number = _BAR_W): string {
  const f = Math.max(0.0, Math.min(1.0, fraction));
  const raw = f * width;
  let n_full = Math.floor(raw);
  const eighths = Math.round((raw - n_full) * 8);

  // Normalize: round-up partial if it reached a full block
  if (eighths >= 8) {
    n_full += 1;
  }
  const has_partial = eighths > 0 && eighths < 8;
  const n_track = Math.max(0, width - n_full - (has_partial ? 1 : 0));

  const counts = _distribute(n_full, _GRADIENT.length);
  let bar = "";
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]!;
    if (count > 0) {
      bar += fg(..._GRADIENT[i]!) + _BLOCK.repeat(count);
    }
  }

  if (has_partial) {
    bar += fg(..._GRADIENT[_GRADIENT.length - 1]!) + _EIGHTHS[eighths - 1]!;
  }
  if (n_track > 0) {
    bar += fg(...C.TRACK) + _TRACK.repeat(n_track);
  }

  return bar + RESET;
}

// ── Sparkline renderer ──────────────────────────────────────────────────────

const _SPARK = "▁▂▃▄▅▆▇█";

/**
 * Linearly resample *vals* to exactly *length* points.
 *
 * Used to stretch or compress sparkline data to a fixed display width. Returns
 * [0.0] * length for an empty input. When len(vals) === length the input is
 * returned as-is (no interpolation needed).
 */
function _resample(vals: number[], length: number): number[] {
  if (vals.length === 0) {
    return new Array<number>(length).fill(0.0);
  }
  const n_vals = vals.length;
  if (n_vals === length) {
    return [...vals];
  }
  const result: number[] = [];
  for (let i = 0; i < length; i++) {
    const src = (i / (length - 1 || 1)) * (n_vals - 1);
    const lo = Math.floor(src);
    const hi = Math.min(n_vals - 1, lo + 1);
    const t = src - lo;
    result.push(vals[lo]! * (1 - t) + vals[hi]! * t);
  }
  return result;
}

/** Render an 8-char mini sparkline. Values are resampled and normalised to fill the range. */
function _render_sparkline(values: number[], width = 8): string {
  const pts = _resample(values, width);
  const hi = pts.length > 0 ? Math.max(...pts) : 1.0;
  const lo = pts.length > 0 ? Math.min(...pts) : 0.0;
  const span = hi - lo || 1.0;
  const chars: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i]!;
    const idx = Math.min(7, Math.floor(((v - lo) / span) * 8));
    const color = lerpRgb(C.GREEN1, C.GREEN5, i / (width - 1 || 1));
    chars.push(`${fg(...color)}${_SPARK[idx]}`);
  }
  return chars.join("") + RESET;
}

// ── Shared share-fraction helper ────────────────────────────────────────────

/**
 * Return the share fraction for one item relative to period totals.
 *
 * Prefers the token denominator when the period has any token savings, falling
 * back to bytes when all token counts are zero (e.g. an image-only session).
 * Returns 0.0 when both denominators are zero.
 */
function _token_or_byte_share(
  item_tokens: number,
  item_bytes: number,
  total_tokens: number,
  total_bytes: number,
): number {
  if (total_tokens > 0) {
    return item_tokens / total_tokens;
  }
  if (total_bytes > 0) {
    return item_bytes / total_bytes;
  }
  return 0.0;
}

/**
 * Savings-bar fill fraction. Positive-only: overhead rows render as empty bar.
 *
 * *gross_bytes* (sum of all positive bytes, clamped to >= 1) is the reference so
 * the dominant positive item fills to 100%.
 */
function _bar_fraction(item_bytes: number, gross_bytes: number): number {
  return item_bytes > 0 ? item_bytes / gross_bytes : 0.0;
}

/** Minimal structural shape for share-denominator aggregation. */
interface _BytesTokens {
  bytes: number;
  tokens: number;
}

/**
 * Single-pass aggregation -> [gross_bytes, share_bytes_denom, share_tokens_denom].
 *
 * Each *item* must expose `.bytes` and `.tokens` (KindStat, SourceStat, …):
 *
 *  - gross_bytes — sum of strictly positive `.bytes` (clamped >= 1) for
 *    bar-scaling so the dominant positive row fills 100%.
 *  - share_bytes_denom — sum of abs(.bytes) (clamped >= 1), share fallback.
 *  - share_tokens_denom — sum of abs(.tokens) (NOT clamped); callers test
 *    `=== 0` to fall back to byte-share.
 */
function _compute_share_denominators(
  items: Iterable<_BytesTokens>,
): [number, number, number] {
  let gross_bytes_sum = 0;
  let share_bytes_sum = 0;
  let share_tokens_sum = 0;
  for (const item of items) {
    const b = item.bytes;
    const t = item.tokens;
    if (b > 0) {
      gross_bytes_sum += b;
    }
    share_bytes_sum += Math.abs(b);
    share_tokens_sum += Math.abs(t);
  }
  return [Math.max(gross_bytes_sum, 1), Math.max(share_bytes_sum, 1), share_tokens_sum];
}

/**
 * Share fraction using absolute-value denominators (kind/source pattern).
 *
 * Prefers tokens when non-zero; otherwise falls back to bytes. Mirrors
 * `_token_or_byte_share` but reuses pre-computed *abs* denominators so the
 * kind/source sections do not re-aggregate inside the sort closure.
 */
function _abs_share(
  item_bytes: number,
  item_tokens: number,
  share_bytes_denom: number,
  share_tokens_denom: number,
): number {
  if (share_tokens_denom === 0) {
    return item_bytes / share_bytes_denom;
  }
  return item_tokens / share_tokens_denom;
}

// ── Section header helper ────────────────────────────────────────────────────

/**
 * Return a 3-line section header: blank line, title+subtitle, horizontal rule.
 *
 * *subtitle* is rendered in muted colour to the right of *title*. The rule spans
 * the full content width (`_CONTENT_W`).
 */
function _section_header(title: string, subtitle = ""): string[] {
  const sub = subtitle ? `  ${fg(...C.TEXT_MUTED)}${subtitle}${RESET}` : "";
  return ["", `${_M}${fg(...C.TEXT_BRIGHT)}${title}${RESET}${sub}`, _RULE];
}

// ── Table header / row helpers ───────────────────────────────────────────────

/**
 * Return a single-line table header string with dim ANSI-coded column labels.
 *
 * Columns are: *first_col_label* (name), savings bar, data saved, tokens saved,
 * share, events — in that order, padded to their respective column widths.
 */
export function _table_header(first_col_label: string): string {
  return [
    _M,
    padR(`${fg(...C.TEXT_DIM)}${first_col_label}${RESET}`, _COL_NAME),
    " ",
    padR(`${fg(...C.TEXT_DIM)}savings${RESET}`, _BAR_W),
    "  ",
    padL(`${fg(...C.TEXT_DIM)}data saved${RESET}`, _COL_DATA),
    "  ",
    padL(`${fg(...C.TEXT_DIM)}tokens saved${RESET}`, _COL_TOKENS),
    "  ",
    padL(`${fg(...C.TEXT_DIM)}share${RESET}`, _COL_SHARE),
    "  ",
    padL(`${fg(...C.TEXT_DIM)}events${RESET}`, _COL_EVENTS),
  ].join("");
}

/**
 * Render a single data row for the by-kind or by-project tables.
 */
function _table_row(
  name: string,
  fraction: number,
  bytes_val: number,
  tokens: number,
  events: number,
  share: number,
  bytes_mode_only = false,
  name_prefix = "",
  name_color: RGB = C.TEXT_PRIMARY,
): string {
  const prefix_w = vlen(name_prefix);
  const max_name = _COL_NAME - prefix_w;
  const truncated =
    name.length > max_name ? name.slice(0, max_name - 1) + "…" : name;
  const name_str = padR(
    `${name_prefix}${fg(...name_color)}${truncated}${RESET}`,
    _COL_NAME,
  );

  const data_str = padL(_fmt_bytes(bytes_val), _COL_DATA);

  let tok_str: string;
  if (bytes_mode_only) {
    tok_str = padL(`${fg(...C.TEXT_DIM)}—${RESET}`, _COL_TOKENS);
  } else {
    tok_str = padL(_fmt_tokens(tokens), _COL_TOKENS);
  }

  const share_pct = share * 100;
  let share_color: RGB;
  if (share_pct < 0) {
    share_color = C.RED;
  } else if (share_pct >= 50) {
    share_color = C.GREEN5;
  } else if (share_pct >= 10) {
    share_color = C.TEXT_PRIMARY;
  } else {
    share_color = C.TEXT_MUTED;
  }
  const share_str = padL(`${fg(...share_color)}${_fmt_pct(share)}${RESET}`, _COL_SHARE);

  const ev_str = padL(`${fg(...C.TEXT_PRIMARY)}${_fmtIntComma(events)}${RESET}`, _COL_EVENTS);

  const parts = [
    _M,
    name_str,
    " ",
    _render_bar(fraction),
    "  ",
    data_str,
    "  ",
    tok_str,
    "  ",
    share_str,
    "  ",
    ev_str,
  ];
  return parts.join("");
}

// ── Section: KPI tiles ───────────────────────────────────────────────────────

/**
 * Render the three-column KPI tile box (events / data saved / tokens saved).
 *
 * Each tile shows the metric value, an optional period-over-period delta
 * (↑/↓ N%), and an optional 8-char sparkline when `totals.sparklines` is
 * populated. The tile frame uses box-drawing characters so it prints cleanly on
 * any modern terminal.
 */
function _render_kpi_section(stats: StatsData): string[] {
  const totals = stats.totals;
  const col_w = Math.floor((_CONTENT_W - _M.length * 2) / 3);
  const inner_w = col_w * 3; // visible width of the three cards combined

  function card(
    label: string,
    value: string,
    delta: string,
    spark: string | null,
  ): [string, string, string] {
    return [
      padR(`${fg(...C.TEXT_MUTED)}${label}${RESET}`, col_w),
      padR(`${fg(...C.TEXT_BRIGHT)}${value}${RESET}${delta}`, col_w),
      spark !== null ? padR(spark, col_w) : padR("", col_w),
    ];
  }

  const spark = totals.sparklines ?? null;
  const c1 = card(
    "events",
    `${_fmtIntComma(totals.events)}`,
    _fmt_delta(totals.events_delta),
    spark ? _render_sparkline(spark.events) : null,
  );
  const c2 = card(
    "data saved",
    _fmt_bytes(totals.bytes),
    _fmt_delta(totals.bytes_delta),
    spark ? _render_sparkline(spark.bytes) : null,
  );
  const c3 = card(
    "tokens saved",
    _fmt_tokens(totals.tokens),
    _fmt_delta(totals.tokens_delta),
    spark ? _render_sparkline(spark.tokens) : null,
  );

  const border = fg(...C.TEXT_DIM);
  const frame_bar = "─".repeat(inner_w + 2); // +2 for single-space padding on each side

  function framed(content: string): string {
    return `${_M}${border}│${RESET} ${content} ${border}│${RESET}`;
  }

  const lines = [
    "",
    `${_M}${border}╭${frame_bar}╮${RESET}`,
    framed(c1[0] + c2[0] + c3[0]), // labels
    framed(c1[1] + c2[1] + c3[1]), // values + deltas
  ];
  if (spark) {
    lines.push(framed(c1[2] + c2[2] + c3[2]));
  }
  lines.push(`${_M}${border}╰${frame_bar}╯${RESET}`);
  return lines;
}

// ── Section: by kind ─────────────────────────────────────────────────────────

// Category groups for the "By kind" table. Each entry is [label, set-of-kinds].
// Kinds not matched by any group fall into the last catch-all group.
// The order controls the visual order of group headers in the table.
const _KIND_GROUPS: [string, ReadonlySet<string>][] = [
  [
    "Read savings",
    new Set([
      "read_replacement",
      "section_replacement",
      "symbol_read",
      "section_read",
      "stub_view",
      "outline",
      "exports",
    ]),
  ],
  ["Lookups", new Set(["symbol_lookup", "semantic_search", "map_lookup"])],
  [
    "Images",
    new Set([
      "image_shrink",
      "gdrive_image",
      "webfetch_image",
      "image_shrink_skipped",
    ]),
  ],
  [
    "Hints",
    new Set([
      "session_hint",
      "session_hint_overhead",
      "read_dedup_hint",
      "grep_dedup_hint",
      "diff_hint",
      "predictive_prefetch_hit",
      "read_partial_overlap_hint",
    ]),
  ],
  [
    "Bash",
    new Set([
      "bash_dedup_hint",
      "bash_output_cached",
      "bash_output_recall",
      "bash_output_recall_miss",
      "bash_dedup_stale",
      "bash_range_read_hint",
      "bash_streak_hint",
      "bash_poll_hint",
      "env_probe_cache_hit",
      "git_diff_scope_hint",
      "dep_list_cache_hit",
      "bash_read_equiv_already_read",
      "bash_grep_result_cache_hit",
      "git_diff_context_trimmed",
    ]),
  ],
  [
    "Web",
    new Set([
      "web_dedup_hint",
      "web_output_cached",
      "web_output_recall",
      "web_output_recall_miss",
      "web_dedup_stale",
    ]),
  ],
  [
    "Compact / Skills",
    new Set([
      "compact_manifest",
      "compact_assist",
      "compact_recovery",
      "skill_body_recall",
      "skill_compact_served",
      "skill_cached",
      "resume_packet",
      "decision_log",
    ]),
  ],
  ["Other", new Set<string>()], // catch-all: kinds not in any group above
];

/**
 * Return the group label for *kind*, falling back to "Other" for dynamic kinds
 * such as `bash_compress:pytest` that don't appear in the static set.
 *
 * Dynamic `bash_compress:*` kinds are routed to the Bash group by prefix.
 */
export function _kind_group_label(kind: string): string {
  if (kind.startsWith("bash_compress:")) {
    return "Bash";
  }
  for (const [label, members] of _KIND_GROUPS) {
    if (label === "Other") {
      continue;
    }
    if (members.has(kind)) {
      return label;
    }
  }
  return "Other";
}

/** Return a dim group-label separator line for the by-kind table. */
function _group_separator(label: string): string {
  return `${_M}  ${fg(...C.TEXT_DIM)}${label}${RESET}`;
}

/**
 * Render the "By kind" table with category grouping.
 *
 * Kinds are grouped into named categories (Read savings, Lookups, Images,
 * Hints, Bash, Web, Compact/Skills, Other). Within each category rows are
 * ordered by share, largest first. Groups with no data are omitted entirely.
 *
 * Bar fill is scaled to the largest positive-bytes kind. Share percentage uses
 * absolute-value totals so overhead kinds (negative bytes/tokens) reduce the
 * denominator without inflating the dominant kind's share to >100%. Appends a
 * footnote for `bytes_mode_only` kinds (e.g. image_shrink) and a second
 * footnote when both `session_hint` and `session_hint_overhead` appear in the
 * same period (explaining the split). Returns [] when `stats.by_kind` is empty.
 */
export function _render_by_kind_section(stats: StatsData): string[] {
  if (stats.by_kind.length === 0) {
    return [];
  }

  const lines: string[] = [..._section_header("By kind"), _table_header("name")];

  // Bar scaling uses positive-only gross so the widest positive bar fills to 100%.
  // Share % uses absolute-value totals so overhead kinds (negative bytes/tokens)
  // reduce the denominator and prevent the dominant positive kind from hitting 100%.
  const [gross_bytes, share_bytes_denom, share_tokens_denom] =
    _compute_share_denominators(stats.by_kind);
  const _kind_names = new Set(stats.by_kind.map((k) => k.kind));
  const bytes_mode_kinds = stats.by_kind
    .filter((k) => k.bytes_mode_only)
    .map((k) => k.kind);

  function _share(k: KindStat): number {
    if (k.bytes_mode_only) {
      return k.bytes / share_bytes_denom;
    }
    return _abs_share(k.bytes, k.tokens, share_bytes_denom, share_tokens_denom);
  }

  // Build a lookup: group_label -> [KindStat], sorted by share desc within each group.
  const by_group = new Map<string, KindStat[]>();
  for (const k of stats.by_kind) {
    const grp = _kind_group_label(k.kind);
    let arr = by_group.get(grp);
    if (arr === undefined) {
      arr = [];
      by_group.set(grp, arr);
    }
    arr.push(k);
  }
  for (const grp_kinds of by_group.values()) {
    grp_kinds.sort((a, b) => _share(b) - _share(a));
  }

  // Emit groups in the canonical order defined by _KIND_GROUPS.
  let first_group = true;
  for (const [group_label] of _KIND_GROUPS) {
    const group_kinds = by_group.get(group_label);
    if (!group_kinds || group_kinds.length === 0) {
      continue;
    }
    if (!first_group) {
      lines.push(""); // blank line between groups
    }
    first_group = false;
    lines.push(_group_separator(group_label));
    for (const k of group_kinds) {
      const share = _share(k);
      lines.push(
        _table_row(
          k.kind,
          _bar_fraction(k.bytes, gross_bytes),
          k.bytes,
          k.tokens,
          k.events,
          share,
          k.bytes_mode_only ?? false,
        ),
      );
    }
  }

  if (bytes_mode_kinds.length > 0) {
    const names = bytes_mode_kinds.join(", ");
    const msg =
      `${_M}${fg(...C.TEXT_DIM)}i  ${names} ` +
      `${_STATS_MESSAGES.bytesModeOnlyNote}${RESET}`;
    lines.push(msg);
  }

  if (_kind_names.has("session_hint") && _kind_names.has("session_hint_overhead")) {
    lines.push(
      `${_M}${fg(...C.TEXT_DIM)}i  ${_STATS_MESSAGES.sessionHintSplitNote}${RESET}`,
    );
  }

  return lines;
}

// ── Section: by source ───────────────────────────────────────────────────────

// Distinct palette for the four user-facing source buckets. Falls back to the
// muted-text colour for unknown / future sources so they still render rather
// than going silently grey-on-grey or crashing.
const _SOURCE_COLORS: Record<string, RGB> = {
  image: C.PURPLE,
  hint: C.BLUE,
  read: C.GREEN4,
  compact: C.TEAL,
  bash: C.ORANGE,
  web: C.YELLOW,
  other: C.TEXT_MUTED,
};

/** Return the palette colour for a source name, falling back to muted. */
export function _source_color(source: string): RGB {
  return _SOURCE_COLORS[source] ?? C.TEXT_MUTED;
}

/**
 * Render the "By source" table: one row per source bucket.
 *
 * Sources are the four user-facing mechanisms (image / hint / read / compact)
 * plus an `other` catch-all. Rows render bytes saved, tokens saved, share of
 * the period total, and an event count using the same column layout as the
 * by-kind / by-day / by-project sections.
 *
 * Each source name is prefixed with a coloured bullet (●) drawn from the
 * distinct `_SOURCE_COLORS` palette so the four mechanisms are visually
 * separable at a glance, mirroring the by-project bullet treatment.
 *
 * Returns [] when `stats.by_source` is empty so older callers that construct
 * `StatsData` without a by_source rollup still render cleanly.
 */
export function _render_by_source_section(stats: StatsData): string[] {
  const by_source = stats.by_source ?? [];
  if (by_source.length === 0) {
    return [];
  }

  const lines: string[] = [
    ..._section_header("By source"),
    _table_header("source"),
  ];

  // Bar scaling: positive-only gross so the widest positive bar reaches 100%.
  // Share %: absolute-value totals so any overhead rows (negative bytes) shrink
  // the denominator instead of pushing the dominant positive row past 100%.
  const [gross_bytes, share_bytes_denom, share_tokens_denom] =
    _compute_share_denominators(by_source);

  function _share(s: SourceStat): number {
    return _abs_share(s.bytes, s.tokens, share_bytes_denom, share_tokens_denom);
  }

  // Rows are ordered by share of the period total, largest first.
  const sorted = [...by_source].sort((a, b) => _share(b) - _share(a));
  for (const s of sorted) {
    const share = _share(s);
    const color = _source_color(s.source);
    lines.push(
      _table_row(
        s.source,
        _bar_fraction(s.bytes, gross_bytes),
        s.bytes,
        s.tokens,
        s.events,
        share,
        false,
        `${fg(...color)}●${RESET} `,
        C.TEXT_PRIMARY,
      ),
    );
  }

  return lines;
}

/**
 * Render the "By command" table: one row per CLI command.
 *
 * CLI commands (symbol, read, section, semantic, outline, refs, exports,
 * skeleton, map) are aggregated by the commands that save the most tokens. Rows
 * render bytes saved, tokens saved, share of the period total, and an event
 * count using the same column layout as the by-kind / by-day / by-project
 * sections.
 *
 * Returns [] when `stats.by_command` is empty so older callers that construct
 * `StatsData` without a by_command rollup still render cleanly.
 */
function _render_by_command_section(stats: StatsData): string[] {
  const by_command = stats.by_command ?? [];
  if (by_command.length === 0) {
    return [];
  }

  const lines: string[] = [
    ..._section_header("By command"),
    _table_header("command"),
  ];

  // Bar scaling: positive-only gross so the widest positive bar reaches 100%.
  const [gross_bytes, share_bytes_denom, share_tokens_denom] =
    _compute_share_denominators(by_command);

  function _share(c: CommandStat): number {
    return _abs_share(c.bytes, c.tokens, share_bytes_denom, share_tokens_denom);
  }

  // Rows are ordered by share of the period total, largest first.
  const sorted = [...by_command].sort((a, b) => _share(b) - _share(a));
  for (const c of sorted) {
    const share = _share(c);
    lines.push(
      _table_row(
        c.command,
        _bar_fraction(c.bytes, gross_bytes),
        c.bytes,
        c.tokens,
        c.events,
        share,
        false,
        "",
        C.TEXT_PRIMARY,
      ),
    );
  }

  return lines;
}

// ── Shared: project bullet colours ───────────────────────────────────────────

const _PROJECT_COLORS: RGB[] = [
  C.PURPLE,
  C.TEAL,
  C.BLUE,
  C.GREEN4,
  C.TEXT_MUTED,
];

/** Stable colour assignment based on hash string. */
function _hash_color(hash_str: string): RGB {
  let n = 0;
  for (const c of hash_str) {
    n += c.codePointAt(0)!;
  }
  return _PROJECT_COLORS[n % _PROJECT_COLORS.length]!;
}

// ── Section: by day ──────────────────────────────────────────────────────────

/**
 * Render the "By day" table: one row per day, ordered latest-first by date.
 *
 * Share fraction uses tokens when the period total is non-zero, falling back to
 * bytes when all token counts are zero (e.g. an image-only session). Returns []
 * when `stats.by_day` is empty.
 */
export function _render_by_day_section(stats: StatsData): string[] {
  if (stats.by_day.length === 0) {
    return [];
  }

  const lines: string[] = [..._section_header("By day"), _table_header("date")];

  function _share(d: DayStat): number {
    return _token_or_byte_share(
      d.tokens,
      d.bytes,
      stats.totals.tokens,
      stats.totals.bytes,
    );
  }

  // Rows are ordered newest-first so the most recent activity is at the top.
  const sorted = [...stats.by_day].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
  for (const d of sorted) {
    const share = _share(d);
    lines.push(_table_row(d.date, share, d.bytes, d.tokens, d.events, share));
  }

  return lines;
}

// ── Section: by project ──────────────────────────────────────────────────────

/**
 * Render the "By project (top 5)" table: one row per project (ordered by share)
 * plus a path sub-row.
 *
 * Each project bullet is coloured via `_hash_color` for visual distinction. The
 * sub-row shows the short project hash and absolute path in dim colour. Share
 * fraction uses tokens when the cross-project total is non-zero, falling back to
 * bytes otherwise. Returns [] when `stats.by_project` is empty.
 */
export function _render_by_project_section(stats: StatsData): string[] {
  if (stats.by_project.length === 0) {
    return [];
  }

  const project_total_bytes = stats.by_project.reduce((acc, p) => acc + p.bytes, 0);
  const project_total_tokens = stats.by_project.reduce((acc, p) => acc + p.tokens, 0);
  const lines: string[] = [
    ..._section_header(`By project (top ${stats.by_project.length})`),
    _table_header("project"),
  ];

  function _share(p: ProjectStat): number {
    return _token_or_byte_share(
      p.tokens,
      p.bytes,
      project_total_tokens,
      project_total_bytes,
    );
  }

  // Rows are ordered by share of the cross-project total, largest first.
  const sorted = [...stats.by_project].sort((a, b) => _share(b) - _share(a));
  for (const p of sorted) {
    const share = _share(p);
    const color = _hash_color(p.hash);
    lines.push(
      _table_row(
        p.project,
        share,
        p.bytes,
        p.tokens,
        p.events,
        share,
        false,
        `${fg(...color)}●${RESET} `,
        C.TEXT_PRIMARY,
      ),
    );
    lines.push(
      `${_M}  ${fg(...C.TEXT_DIM)}└─ ${p.hash}  ${stripAnsi(p.path)}${RESET}`,
    );
  }

  return lines;
}

// ── Section: insights ────────────────────────────────────────────────────────

/**
 * Render the "Insights" section: three copy-driven observation bullets.
 *
 * Bullets cover: (1) biggest saver by bytes with its share percentage, (2) most
 * active day by events, and (3) token leader excluding `bytes_mode_only` kinds.
 * Copy strings come from `_STATS_MESSAGES` (loaded from `stats_messages.json`).
 */
function _render_insights_section(stats: StatsData): string[] {
  const lines: string[] = [..._section_header("Insights")];
  const bullet = `${fg(...C.GREEN3)}▸${RESET}`;

  function dim(s: string): string {
    return `${fg(...C.TEXT_MUTED)}${s}${RESET}`;
  }

  // Biggest saver by bytes
  const top_kind: KindStat | null = _maxBy(stats.by_kind, _key_kind_bytes);
  if (top_kind) {
    const share =
      stats.totals.bytes > 0 ? top_kind.bytes / stats.totals.bytes : 0.0;
    lines.push(
      `${_M}${bullet} ${dim(_STATS_MESSAGES.insights.biggestSaver)}${fg(...C.TEXT_PRIMARY)}${top_kind.kind}${RESET}` +
        `${dim(" — ")}${fg(...C.GREEN5)}${_fmt_pct(share)}${RESET}` +
        `${dim(` of saved data across ${_fmtIntComma(top_kind.events)} events`)}`,
    );
  }

  // Most active day
  const top_day: DayStat | null = _maxBy(stats.by_day, _key_day_events);
  if (top_day) {
    lines.push(
      `${_M}${bullet} ${dim(_STATS_MESSAGES.insights.mostActive)}${fg(...C.TEXT_PRIMARY)}${top_day.date}${RESET}` +
        `${dim(" — ")}${_fmtIntComma(top_day.events)} events, ${_fmt_bytes(top_day.bytes)}${dim(" saved")}`,
    );
  }

  // Token leader (excluding bytes_mode_only kinds)
  const token_kinds = stats.by_kind.filter((k) => !k.bytes_mode_only);
  const top_token: KindStat | null = _maxBy(token_kinds, _key_kind_tokens);
  if (top_token) {
    lines.push(
      `${_M}${bullet} ${dim(_STATS_MESSAGES.insights.tokenLeader)}${fg(...C.TEXT_PRIMARY)}${top_token.kind}${RESET}` +
        `${dim(" — ")}${_fmt_tokens(top_token.tokens)}` +
        `${dim(` saved in ${_fmtIntComma(top_token.events)} events`)}`,
    );
  }

  return lines;
}

/**
 * Return the element of *items* with the maximum key, or null when empty.
 *
 * Mirrors Python `max(items, key=..., default=None)`: on ties the FIRST
 * maximal element is returned (Python's max keeps the first seen), so the
 * comparison uses strict `>` to avoid replacing on equal keys.
 */
function _maxBy<T>(items: T[], key: (item: T) => number): T | null {
  if (items.length === 0) {
    return null;
  }
  let best = items[0]!;
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    const k = key(item);
    if (k > bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

// ── Report header ────────────────────────────────────────────────────────────

/**
 * Return the report header line: name, version, and window label.
 *
 * `stats.version` is the installed package version; omitted when empty.
 * `stats.window_label` is "last N days" or "all time"; omitted when empty.
 */
export function _render_header(stats: StatsData): string[] {
  let line = `${_M}${fg(...C.TEXT_BRIGHT)}token-goat${RESET}`;
  if (stats.version) {
    line += `  ${fg(...C.TEXT_MUTED)}v${stats.version}${RESET}`;
  }
  if (stats.window_label) {
    line += `  ${fg(...C.TEXT_DIM)}·  ${stats.window_label}${RESET}`;
  }
  return [line];
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Render a complete token-goat stats report to a string ready for print().
 */
export function render_stats(stats: StatsData): string {
  const sections = [
    _render_header(stats),
    _render_kpi_section(stats),
    _render_by_kind_section(stats),
    _render_by_source_section(stats),
    _render_by_command_section(stats),
    _render_by_day_section(stats),
    _render_by_project_section(stats),
    _render_insights_section(stats),
    [""],
  ];
  const out: string[] = [];
  for (const section of sections) {
    for (const line of section) {
      out.push(line);
    }
  }
  return out.join("\n");
}
