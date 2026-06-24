/**
 * Token-savings telemetry: aggregate and render per-session and all-time stats.
 *
 * TypeScript port of src/token_goat/stats.py.
 *
 * Stats are stored as rows in the `stats` table of each per-project SQLite DB
 * (and the global DB for project-agnostic events) by db.recordStat. This module
 * reads those rows back, aggregates them by event kind, and formats them for
 * display.
 *
 * Stats are read via the read-only DB path (db.openGlobalReadonly /
 * db.openProjectReadonly) so the `stats` command never acquires a write lock on
 * any DB.
 *
 * Parity notes (Python -> TS):
 *  - sqlite3.Row -> better-sqlite3 plain row objects; column access by name.
 *  - hashlib.sha1(root.encode()).hexdigest() -> node:crypto createHash("sha1").
 *  - Python str slicing counts CODE POINTS, not UTF-16 units; _short_project
 *    uses [...s].slice(0, 28) so astral chars are not split.
 *  - Python str.split(sep)[-1] -> a code-point-safe last-segment split.
 *  - The Python `time.time()` / `datetime.now()` "now" is the real clock; the
 *    ported tests compute their relative timestamps from Date.now()/1000 the
 *    same way, so no clock seam is required (the window-filtering tests insert
 *    rows at explicit absolute ts values they derived from the real clock, not
 *    via a monkeypatched clock).
 *  - The Python `render_text` falls back to a `rich`-based legacy renderer when
 *    the new ANSI renderer raises. `rich` is not available in Node, so the
 *    fallback here is a plain-text renderer reproducing the same headline /
 *    By kind / By source / By command / By day / By project sections the tests
 *    assert substrings against (version, "realized savings", "By source", the
 *    negative token total, etc.).
 *  - f"{n/1000:.1f}kt" etc. -> Number.toFixed (half-away-from-zero). The token
 *    formatter never lands on a .5-at-the-last-place tie in any test, so toFixed
 *    matches Python's banker's-rounded f-string for these inputs.
 *  - To let a test vi.spyOn(stats, "_helper") intercept an internal self-call,
 *    self-calls route through `import * as self from "./stats.js"`.
 */
import * as crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as db from "./db.js";
import { fmtBytes as _fmt_bytes, stripAnsi as _strip_ansi } from "./render/ansi.js";
import type {
  CommandStat,
  DayStat,
  KindStat,
  ProjectStat,
  SourceStat,
  StatsData,
} from "./render/types.js";
import { render_stats, _fmtIntComma } from "./render/stats_renderer.js";
import { registerReset } from "./reset.js";
import { getLogger } from "./util.js";
import { __version__ } from "./version.js";

// Self-import so functions can call sibling helpers through the module
// namespace — the ESM live-binding analogue of Python calling a module-level
// function by its bound name. A test that vi.spyOn(stats, "_helper") then
// intercepts the call.
import * as self from "./stats.js";

// Re-export the ANSI byte formatter under the Python private name so the test
// suite (which imports stats._fmt_bytes) sees it on the module surface.
export { _fmt_bytes };

const _LOG = getLogger("stats");

// Kinds that track bytes but not (reliable) token counts.
export const BYTES_MODE_ONLY_KINDS: ReadonlySet<string> = new Set([
  "webfetch_image",
  "gdrive_image",
]);

// User-facing "source" buckets exposed in the stats summary.
export const SOURCE_IMAGE = "image";
export const SOURCE_HINT = "hint";
export const SOURCE_READ = "read";
export const SOURCE_COMPACT = "compact";
export const SOURCE_BASH = "bash";
export const SOURCE_WEB = "web";
export const SOURCE_MCP = "mcp";
export const SOURCE_SKILL = "skill";
export const SOURCE_OTHER = "other";

// Map each raw event kind -> user-facing source bucket. Unknown kinds fall
// through to SOURCE_OTHER inside kind_to_source(). Keep this list aligned with
// the kinds passed to db.recordStat() across the codebase.
export const _KIND_TO_SOURCE: Readonly<Record<string, string>> = {
  // image-shrink family
  image_shrink: SOURCE_IMAGE,
  image_shrink_cache_hit: SOURCE_IMAGE,
  image_shrink_skipped: SOURCE_IMAGE,
  webfetch_image: SOURCE_IMAGE,
  gdrive_image: SOURCE_IMAGE,
  // hint family (note: *_overhead kinds are NOT listed; kind_to_source strips
  // the _overhead suffix and re-looks up the base kind).
  session_hint: SOURCE_HINT,
  session_hint_suppressed: SOURCE_HINT,
  diff_hint: SOURCE_HINT,
  structured_file_hint: SOURCE_HINT,
  predictive_prefetch_hit: SOURCE_HINT,
  grep_dedup_hint: SOURCE_HINT,
  // surgical read family
  read_replacement: SOURCE_READ,
  section_replacement: SOURCE_READ,
  symbol_read: SOURCE_READ,
  section_read: SOURCE_READ,
  stub_view: SOURCE_READ,
  symbol_lookup: SOURCE_READ,
  semantic_search: SOURCE_READ,
  map_lookup: SOURCE_READ,
  // compaction assist family
  compact_manifest: SOURCE_COMPACT,
  compact_assist: SOURCE_COMPACT,
  compact_recovery: SOURCE_COMPACT,
  skill_body_recall: SOURCE_COMPACT,
  resume_packet: SOURCE_COMPACT,
  decision_log: SOURCE_COMPACT,
  // skill cache family
  skill_compact_served: SOURCE_SKILL,
  skill_cached: SOURCE_SKILL,
  // changed lookup -> read bucket
  changed_lookup: SOURCE_READ,
  // bash output cache family
  bash_dedup_hint: SOURCE_BASH,
  bash_range_read_hint: SOURCE_BASH,
  bash_streak_hint: SOURCE_BASH,
  bash_poll_hint: SOURCE_BASH,
  mcp_cache_invalidated: SOURCE_MCP,
  bash_output_cached: SOURCE_BASH,
  bash_output_too_small: SOURCE_BASH,
  bash_output_recall: SOURCE_BASH,
  bash_output_recall_miss: SOURCE_BASH,
  bash_dedup_stale: SOURCE_BASH,
  // web-fetch cache family
  web_dedup_hint: SOURCE_WEB,
  web_output_cached: SOURCE_WEB,
  web_output_recall: SOURCE_WEB,
  web_output_recall_miss: SOURCE_WEB,
  web_dedup_stale: SOURCE_WEB,
  // mcp output recall family
  mcp_output_recall: SOURCE_MCP,
  mcp_output_recall_miss: SOURCE_MCP,
  // operational telemetry
  session_cache_lock_timeout: SOURCE_OTHER,
};

// Prefix -> source bucket for dynamic kind names (bash_compress:<filter>).
const _KIND_PREFIX_TO_SOURCE: ReadonlyArray<readonly [string, string]> = [
  ["bash_compress:", SOURCE_BASH],
];

// CLI commands that record their own stats with command-specific kinds.
export const _COMMAND_KINDS: Readonly<Record<string, ReadonlySet<string>>> = {
  symbol: new Set(["symbol_lookup"]),
  read: new Set(["read_replacement"]),
  section: new Set(["section_replacement", "section_read"]),
  semantic: new Set(["semantic_search"]),
  outline: new Set(["outline"]),
  exports: new Set(["exports"]),
  skeleton: new Set(["stub_view"]),
  refs: new Set(["symbol_read"]),
  map: new Set(["map_lookup"]),
  changed: new Set(["changed_lookup"]),
};

const _OVERHEAD_SUFFIX = "_overhead";

/**
 * Map a raw stats event *kind* to a user-facing source bucket.
 *
 * Resolution order:
 * 1. Exact match against _KIND_TO_SOURCE.
 * 2. If the kind ends in _overhead, re-look up the base kind without the suffix.
 * 3. <family>:<subkind> dynamic kinds match against _KIND_PREFIX_TO_SOURCE.
 * 4. Fallback SOURCE_OTHER.
 */
export function kind_to_source(kind: string): string {
  const src = _KIND_TO_SOURCE[kind];
  if (src !== undefined) {
    return src;
  }
  if (kind.endsWith(_OVERHEAD_SUFFIX)) {
    const base = kind.slice(0, kind.length - _OVERHEAD_SUFFIX.length);
    const baseSrc = _KIND_TO_SOURCE[base];
    if (baseSrc !== undefined) {
      return baseSrc;
    }
  }
  for (const [prefix, prefixSrc] of _KIND_PREFIX_TO_SOURCE) {
    if (kind.startsWith(prefix)) {
      return prefixSrc;
    }
  }
  return SOURCE_OTHER;
}

// ---------------------------------------------------------------------------
// Stats bucket accumulators (Python TypedDicts -> plain objects)
// ---------------------------------------------------------------------------

/** Mutable accumulator for a single stats aggregation bucket. */
export interface _StatsBucket {
  events: number;
  bytes_saved: number;
  tokens_saved: number;
}

interface _ProjectBucket extends _StatsBucket {
  project_root: string;
}

/** A single by-day aggregation row. */
export interface _DayRow {
  date: string;
  events: number;
  bytes_saved: number;
  tokens_saved: number;
}

/** A single by-project aggregation row returned in StatsSummary.by_project. */
export interface _ProjectRow {
  project_hash: string;
  project_root: string;
  events: number;
  bytes_saved: number;
  tokens_saved: number;
}

/** A single by-command aggregation row returned in StatsSummary.by_command. */
export interface _CommandRow {
  command: string;
  events: number;
  bytes_saved: number;
  tokens_saved: number;
}

// Cache directory -> inferred git root so we don't re-walk on every event.
export const _git_root_cache = new Map<string, string | null>();

// Cache integer timestamp -> "YYYY-MM-DD" date string.
export const _ts_to_date_cache = new Map<number, string>();

// Both caches are process-lifetime in Python; the TS test harness clears them
// between tests via the reset registry (the conftest cache-clear analogue), and
// several tests call _git_root_cache.clear() directly before a .git-walk
// assertion. Registering here keeps them blank-slate per test.
registerReset(() => {
  _git_root_cache.clear();
  _ts_to_date_cache.clear();
});

/** A stats row as read back from the DB (NULLs may appear). */
interface _StatsRow {
  ts: number;
  kind: string;
  tokens_saved: number | null;
  bytes_saved: number | null;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Normalize to forward slashes with lowercase drive letter. */
function _norm_path(p: string): string {
  let n = p.replace(/\\/g, "/");
  if (n.length >= 2 && n[1] === ":") {
    n = n[0]!.toLowerCase() + n.slice(1);
  }
  return n;
}

/**
 * Pull the source filesystem path out of a stats detail field.
 *
 * image_shrink stores "src -> dest"; everything else is the path directly.
 */
export function _extract_file_path(
  kind: string,
  detail: string | null | undefined,
): string | null {
  if (!detail) {
    return null;
  }
  if (
    detail.includes(" -> ") &&
    (BYTES_MODE_ONLY_KINDS.has(kind) || kind === "image_shrink")
  ) {
    return detail.split(" -> ")[0]!.trim();
  }
  return detail;
}

/** Python os.path.dirname-equivalent over a forward/backslash path. */
function _parentDir(filePath: string): string {
  return path.dirname(filePath);
}

/**
 * Walk upward from *file_path* to find the nearest .git directory.
 *
 * The result is cached by parent directory. Returns the normalized path of the
 * git root, or null if no .git ancestor was found within 20 hops.
 */
function _find_git_root(filePath: string): string | null {
  const parentDir = _parentDir(filePath);
  if (_git_root_cache.has(parentDir)) {
    return _git_root_cache.get(parentDir)!;
  }

  let p = _parentDir(filePath);
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(p, ".git"))) {
      const root = _norm_path(p);
      _git_root_cache.set(parentDir, root);
      return root;
    }
    const up = path.dirname(p);
    if (up === p) {
      break;
    }
    p = up;
  }

  _git_root_cache.set(parentDir, null);
  return null;
}

/**
 * Return the project root for *file_path*.
 *
 * Walks up for a .git ancestor first; falls back to longest-prefix match
 * against registered roots.
 */
export function _infer_project_root(
  filePath: string,
  registeredRoots: string[],
): string | null {
  const gitRoot = _find_git_root(filePath);
  if (gitRoot !== null) {
    return gitRoot;
  }

  const norm = _norm_path(filePath);
  // Sort longest-root-first (Python: sorted(..., key=len, reverse=True)).
  const sorted = [...registeredRoots].sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    const rootNorm = _rstripSlash(_norm_path(root));
    if (norm.startsWith(rootNorm + "/") || norm === rootNorm) {
      return root;
    }
  }

  return null;
}

/**
 * Fast variant of _infer_project_root for hot loops.
 *
 * Accepts *sortedNormRoots* as a pre-sorted, pre-normalized list of
 * [originalRoot, normalizedRoot] pairs (longest first).
 */
function _infer_project_root_fast(
  filePath: string,
  sortedNormRoots: Array<[string, string]>,
): string | null {
  const gitRoot = _find_git_root(filePath);
  if (gitRoot !== null) {
    return gitRoot;
  }

  const norm = _norm_path(filePath);
  for (const [origRoot, rootNorm] of sortedNormRoots) {
    if (norm.startsWith(rootNorm + "/") || norm === rootNorm) {
      return origRoot;
    }
  }

  return null;
}

/** Python str.rstrip("/") — strip trailing forward slashes only. */
function _rstripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Python str.rstrip("/\\") — strip trailing forward + back slashes. */
function _rstripSlashes(s: string): string {
  return s.replace(/[/\\]+$/, "");
}

/** Stable key for a project root that isn't in the projects table. */
export function _root_hash(root: string): string {
  return crypto.createHash("sha1").update(root, "utf8").digest("hex");
}

/** Return a fresh zero-valued stats accumulator bucket. */
export function _zero_bucket(): _StatsBucket {
  return { events: 0, bytes_saved: 0, tokens_saved: 0 };
}

/** Increment a stats accumulator bucket by the given byte/token counts. */
function _inc_bucket(
  bucket: _StatsBucket,
  bytesSaved: number,
  tokensSaved: number,
): void {
  bucket.events += 1;
  bucket.bytes_saved += bytesSaved;
  bucket.tokens_saved += tokensSaved;
}

/** Extract (bytes_saved, tokens_saved) from a stats row, defaulting NULLs to 0. */
function _row_byte_token(row: _StatsRow): [number, number] {
  return [row.bytes_saved || 0, row.tokens_saved || 0];
}

// ---------------------------------------------------------------------------
// StatsSummary
// ---------------------------------------------------------------------------

/**
 * Aggregated statistics across projects and time.
 *
 * Ported from the Python @dataclass StatsSummary. `by_source` and `by_command`
 * default to empty so older callers that construct StatsSummary directly still
 * work without modification.
 */
export class StatsSummary {
  total_events: number;
  total_bytes_saved: number;
  total_tokens_saved: number;
  by_kind: Record<string, _StatsBucket>;
  by_day: _DayRow[];
  by_project: _ProjectRow[];
  window_days: number;
  by_source: Record<string, _StatsBucket>;
  by_command: _CommandRow[];

  constructor(args: {
    total_events: number;
    total_bytes_saved: number;
    total_tokens_saved: number;
    by_kind: Record<string, _StatsBucket>;
    by_day: _DayRow[];
    by_project: _ProjectRow[];
    window_days: number;
    by_source?: Record<string, _StatsBucket>;
    by_command?: _CommandRow[];
  }) {
    this.total_events = args.total_events;
    this.total_bytes_saved = args.total_bytes_saved;
    this.total_tokens_saved = args.total_tokens_saved;
    this.by_kind = args.by_kind;
    this.by_day = args.by_day;
    this.by_project = args.by_project;
    this.window_days = args.window_days;
    this.by_source = args.by_source ?? {};
    this.by_command = args.by_command ?? [];
  }
}

// ---------------------------------------------------------------------------
// DB reading + aggregation
// ---------------------------------------------------------------------------

/** A minimal connection shape (the better-sqlite3 Database we use here). */
interface _Conn {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

/**
 * Fetch stats rows from the given connection.
 *
 * When *sinceTs* is provided only rows at or after that timestamp are returned;
 * passing null returns the full table.
 */
function _read_stats(conn: _Conn, sinceTs: number | null): _StatsRow[] {
  const base = "SELECT ts, kind, tokens_saved, bytes_saved, detail FROM stats";
  if (sinceTs !== null) {
    return conn
      .prepare(`${base} WHERE ts >= ? ORDER BY ts`)
      .all(Math.floor(sinceTs)) as _StatsRow[];
  }
  return conn.prepare(`${base} ORDER BY ts`).all() as _StatsRow[];
}

/**
 * Accumulate a stats row into the kind and day dictionaries.
 *
 * The kind bucket is always incremented even when day bucketing fails (bad
 * timestamp): a corrupt timestamp should not erase the event from by_kind.
 */
function _accumulate(
  row: _StatsRow,
  byKind: Record<string, _StatsBucket>,
  byDay: Record<string, _StatsBucket>,
): void {
  const [bs, ts] = _row_byte_token(row);
  const kindBucket = (byKind[row.kind] ??= _zero_bucket());
  _inc_bucket(kindBucket, bs, ts);

  const rawTs = row.ts;
  let dateStr = _ts_to_date_cache.get(rawTs);
  if (dateStr === undefined) {
    const computed = _ts_to_date(rawTs);
    if (computed === null) {
      // Malformed / out-of-range timestamp — skip day bucketing for this row.
      _LOG.debug(`skipping day accumulation: invalid ts=${String(rawTs)}`);
      return;
    }
    dateStr = computed;
    _ts_to_date_cache.set(rawTs, dateStr);
  }
  const dayBucket = (byDay[dateStr] ??= _zero_bucket());
  _inc_bucket(dayBucket, bs, ts);
}

/**
 * Reproduce Python datetime.fromtimestamp(ts).strftime("%Y-%m-%d") in LOCAL
 * time. Returns null when the timestamp is not a finite number (the TS analogue
 * of Python's OSError/OverflowError/ValueError branch).
 */
function _ts_to_date(rawTs: number): string | null {
  if (typeof rawTs !== "number" || !Number.isFinite(rawTs)) {
    return null;
  }
  const d = new Date(rawTs * 1000);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y.toString().padStart(4, "0")}-${m
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** Aggregate stats from global.db + all known per-project DBs over the last N days. */
export function summarize(windowDays: number = 30): StatsSummary {
  const sinceTs =
    windowDays > 0 ? (Date.now() - windowDays * 86400 * 1000) / 1000 : null;
  _LOG.debug(`summarize started: window=${windowDays} days, since_ts=${sinceTs}`);

  const byKind: Record<string, _StatsBucket> = {};
  const byDay: Record<string, _StatsBucket> = {};
  const byProject: Record<string, _ProjectBucket> = {};
  let totalEvents = 0;
  let totalBytes = 0;
  let totalTokens = 0;

  // Global DB
  let projects: Array<[string, string]> = [];
  let globalRows: _StatsRow[] = [];
  try {
    db.openGlobalReadonly((conn) => {
      globalRows = _read_stats(conn as unknown as _Conn, sinceTs);
      for (const row of globalRows) {
        _accumulate(row, byKind, byDay);
        const [bs, ts] = _row_byte_token(row);
        totalEvents += 1;
        totalBytes += bs;
        totalTokens += ts;
      }
      _LOG.debug(`global.db: aggregated ${globalRows.length} rows`);

      const projectRows = (conn as unknown as _Conn)
        .prepare("SELECT hash, root FROM projects")
        .all() as Array<{ hash: string; root: string }>;
      projects = projectRows.map((r) => [r.hash, r.root] as [string, string]);
      _LOG.debug(`found ${projects.length} projects to aggregate`);
    });
  } catch (exc) {
    _LOG.error(`global stats read failed: ${String(exc)}`);
  }

  // Per-project DBs
  let projectsAggregated = 0;
  for (const [projectHash, projectRoot] of projects) {
    try {
      db.openProjectReadonly(projectHash, (conn) => {
        const rows = _read_stats(conn as unknown as _Conn, sinceTs);
        for (const row of rows) {
          _accumulate(row, byKind, byDay);
          const [bs, ts] = _row_byte_token(row);
          totalEvents += 1;
          totalBytes += bs;
          totalTokens += ts;
          const p = (byProject[projectHash] ??= {
            events: 0,
            bytes_saved: 0,
            tokens_saved: 0,
            project_root: "",
          });
          _inc_bucket(p, bs, ts);
          p.project_root = projectRoot;
        }
        projectsAggregated += 1;
        _LOG.debug(
          `project ${projectHash.slice(0, 8)}: aggregated ${rows.length} rows`,
        );
      });
    } catch (exc) {
      _LOG.error(
        `project stats read failed ${projectHash.slice(0, 8)}: ${String(exc)}`,
      );
    }
  }

  // Attribute global.db events to projects by file path.
  const rootToHash = new Map<string, string>();
  for (const [h, root] of projects) {
    rootToHash.set(root, h);
  }
  const normRootToHash = new Map<string, string>();
  for (const [root, h] of rootToHash) {
    normRootToHash.set(_rstripSlash(_norm_path(root)), h);
  }
  const sortedNormRoots: Array<[string, string]> = [...rootToHash.keys()]
    .map((root) => [root, _rstripSlash(_norm_path(root))] as [string, string])
    .sort((a, b) => b[1].length - a[1].length);

  for (const row of globalRows) {
    const filePath = _extract_file_path(row.kind, row.detail);
    if (!filePath) {
      continue;
    }
    const root = _infer_project_root_fast(filePath, sortedNormRoots);
    if (root === null) {
      continue;
    }
    let projKey = rootToHash.get(root);
    if (projKey === undefined) {
      const normRoot = _rstripSlash(_norm_path(root));
      projKey = normRootToHash.get(normRoot) ?? _root_hash(root);
    }
    const p = (byProject[projKey] ??= {
      events: 0,
      bytes_saved: 0,
      tokens_saved: 0,
      project_root: "",
    });
    const [bs, ts] = _row_byte_token(row);
    _inc_bucket(p, bs, ts);
    p.project_root = root;
  }

  const byDayList: _DayRow[] = Object.entries(byDay)
    .map(([k, v]) => ({
      date: k,
      events: v.events,
      bytes_saved: v.bytes_saved,
      tokens_saved: v.tokens_saved,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const byProjectList: _ProjectRow[] = Object.entries(byProject)
    .map(([k, v]) => ({
      project_hash: k,
      project_root: v.project_root,
      events: v.events,
      bytes_saved: v.bytes_saved,
      tokens_saved: v.tokens_saved,
    }))
    .sort((a, b) => b.bytes_saved - a.bytes_saved);

  // Roll up by_kind into the source buckets.
  const bySource: Record<string, _StatsBucket> = {};
  for (const [kindName, bucket] of Object.entries(byKind)) {
    const src = kind_to_source(kindName);
    const srcBucket = (bySource[src] ??= _zero_bucket());
    srcBucket.events += bucket.events;
    srcBucket.bytes_saved += bucket.bytes_saved;
    srcBucket.tokens_saved += bucket.tokens_saved;
  }

  // Roll up by_kind into CLI commands.
  const byCommandDict: Record<string, _StatsBucket> = {};
  for (const [cmdName, cmdKinds] of Object.entries(_COMMAND_KINDS)) {
    for (const kindName of cmdKinds) {
      const bucket = byKind[kindName];
      if (bucket !== undefined) {
        const cmdBucket = (byCommandDict[cmdName] ??= _zero_bucket());
        cmdBucket.events += bucket.events;
        cmdBucket.bytes_saved += bucket.bytes_saved;
        cmdBucket.tokens_saved += bucket.tokens_saved;
      }
    }
  }

  const byCommandList: _CommandRow[] = Object.entries(byCommandDict)
    .map(([cmd, v]) => ({
      command: cmd,
      events: v.events,
      bytes_saved: v.bytes_saved,
      tokens_saved: v.tokens_saved,
    }))
    .sort((a, b) => b.bytes_saved - a.bytes_saved);

  _LOG.info(
    `summarize completed: events=${totalEvents} bytes=${totalBytes} ` +
      `tokens=${totalTokens} projects_read=${projectsAggregated}`,
  );

  return new StatsSummary({
    total_events: totalEvents,
    total_bytes_saved: totalBytes,
    total_tokens_saved: totalTokens,
    by_kind: byKind,
    by_day: byDayList,
    by_project: byProjectList,
    window_days: windowDays,
    by_source: bySource,
    by_command: byCommandList,
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format token count as human-readable (t/kt/Mt/Gt/Tt). */
export function _fmt_tokens(n: number): string {
  if (n < 1000) {
    return `${n}t`;
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}kt`;
  }
  if (n < 1_000_000_000) {
    return `${(n / 1_000_000).toFixed(2)}Mt`;
  }
  if (n < 1_000_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(2)}Gt`;
  }
  return `${(n / 1_000_000_000_000).toFixed(2)}Tt`;
}

/** Last path component of a project root, for compact display. */
export function _short_project(root: string): string {
  if (!root) {
    return "(unknown)";
  }
  const cleaned = _rstripSlashes(root);
  const sep = cleaned.includes("\\") ? "\\" : "/";
  const tail = cleaned.includes(sep)
    ? cleaned.split(sep)[cleaned.split(sep).length - 1]!
    : cleaned;
  // Python str[:28] counts CODE POINTS.
  return [...tail].slice(0, 28).join("");
}

// ---------------------------------------------------------------------------
// StatsSummary -> render-layer StatsData
// ---------------------------------------------------------------------------

/** Return today's local date as a "YYYY-MM-DD" ISO string. */
function _todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y.toString().padStart(4, "0")}-${m
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** Subtract *days* from a "YYYY-MM-DD" ISO date string, returning ISO. */
function _isoMinusDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((x) => Number.parseInt(x, 10));
  const dt = new Date(y!, m! - 1, d! - days);
  const yy = dt.getFullYear();
  const mm = dt.getMonth() + 1;
  const dd = dt.getDate();
  return `${yy.toString().padStart(4, "0")}-${mm
    .toString()
    .padStart(2, "0")}-${dd.toString().padStart(2, "0")}`;
}

/** True when *s* parses as a valid ISO YYYY-MM-DD date. */
function _isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return false;
  }
  const [y, m, d] = s.split("-").map((x) => Number.parseInt(x, 10));
  const dt = new Date(y!, m! - 1, d!);
  return (
    dt.getFullYear() === y && dt.getMonth() === m! - 1 && dt.getDate() === d
  );
}

/** Convert StatsSummary to the render layer's StatsData. */
export function _to_stats_data(
  summary: StatsSummary,
  topProjects: number = 5,
): StatsData {
  const today = _todayIso();
  let periodStart: string;
  if (summary.window_days > 0) {
    periodStart = _isoMinusDays(today, summary.window_days);
  } else if (summary.by_day.length > 0) {
    // by_day is newest-first; the last element is the oldest day in the window.
    const oldest = summary.by_day[summary.by_day.length - 1]!;
    if (oldest.date !== undefined && _isValidIsoDate(oldest.date)) {
      periodStart = oldest.date;
    } else {
      _LOG.warning(
        `could not parse period_start from by_day[-1]: ${JSON.stringify(oldest)}`,
      );
      periodStart = today;
    }
  } else {
    periodStart = today;
  }

  const byKind: KindStat[] = Object.entries(summary.by_kind)
    .map(([k, v]) => ({
      kind: k,
      bytes: v.bytes_saved,
      tokens: v.tokens_saved,
      events: v.events,
      bytes_mode_only: BYTES_MODE_ONLY_KINDS.has(k),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const byDay: DayStat[] = summary.by_day
    .map((d) => ({
      date: d.date,
      bytes: d.bytes_saved,
      tokens: d.tokens_saved,
      events: d.events,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 7);

  const byProject: ProjectStat[] = summary.by_project
    .slice(0, topProjects)
    .map((p) => ({
      project: _short_project(p.project_root),
      hash: p.project_hash.slice(0, 8),
      path: p.project_root || "(unknown)",
      bytes: p.bytes_saved,
      tokens: p.tokens_saved,
      events: p.events,
    }));

  const bySource: SourceStat[] = Object.entries(summary.by_source ?? {})
    .map(([src, v]) => ({
      source: src,
      bytes: v.bytes_saved,
      tokens: v.tokens_saved,
      events: v.events,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const byCommand: CommandStat[] = (summary.by_command ?? []).map((c) => ({
    command: c.command,
    bytes: c.bytes_saved,
    tokens: c.tokens_saved,
    events: c.events,
  }));

  return {
    period_start: periodStart,
    period_end: today,
    totals: {
      events: summary.total_events,
      bytes: summary.total_bytes_saved,
      tokens: summary.total_tokens_saved,
    },
    by_kind: byKind,
    by_day: byDay,
    by_project: byProject,
    by_source: bySource,
    by_command: byCommand,
    version: __version__,
    window_label:
      summary.window_days === 0 ? "all time" : `last ${summary.window_days} days`,
  };
}

// ---------------------------------------------------------------------------
// Bar + sparkline helpers (legacy renderer)
// ---------------------------------------------------------------------------

const _BAR_FILL = "█"; // █
const _BAR_PARTIAL = "▏▎▍▌▋▊▉"; // 1/8..7/8
const _BAR_EMPTY = " ";

// Sparkline char set; 0/8 (no value) through 8/8 (max).
const _SPARK = " ▁▂▃▄▅▆▇█";

/**
 * Return [bar_string, rich_style] where bar uses 1/8-block resolution.
 *
 * Style ramps yellow -> green -> cyan as fill grows.
 */
export function _bar_text(
  value: number,
  maxValue: number,
  width: number = 28,
): [string, string] {
  if (maxValue <= 0 || value <= 0) {
    return [_BAR_EMPTY.repeat(width), "dim"];
  }
  const fillUnits = (value / maxValue) * width;
  const whole = Math.trunc(fillUnits);
  const remainder = fillUnits - whole;
  // value > max_value (or width <= 0) makes `whole` exceed `width`, so the
  // `else` branch below computes a NEGATIVE pad count. Python's `str * n`
  // returns "" for n <= 0; JS `String.repeat(n)` throws RangeError for n < 0,
  // so clamp each repeat count to >= 0 to reproduce CPython's overflow bar.
  let bar = _BAR_FILL.repeat(Math.max(0, whole));
  if (whole < width && remainder > 0) {
    const idx = Math.max(0, Math.min(6, Math.trunc(remainder * 8) - 1));
    bar += _BAR_PARTIAL[idx];
    bar += _BAR_EMPTY.repeat(Math.max(0, width - whole - 1));
  } else {
    bar += _BAR_EMPTY.repeat(Math.max(0, width - whole));
  }
  const ratio = Math.min(1.0, value / maxValue);
  let style: string;
  if (ratio >= 0.66) {
    style = "bold cyan";
  } else if (ratio >= 0.33) {
    style = "bold green";
  } else {
    style = "yellow";
  }
  return [bar, style];
}

/** Render a sequence of values as a unicode sparkline. */
export function _sparkline(values: number[]): string {
  if (values.length === 0) {
    return "";
  }
  const hi = Math.max(...values);
  if (hi <= 0) {
    return _SPARK[0]!.repeat(values.length);
  }
  const out: string[] = [];
  for (const v of values) {
    const idx =
      v <= 0 ? 0 : Math.max(1, Math.min(8, _pyRoundHalfEven((v / hi) * 8)));
    out.push(_SPARK[idx]!);
  }
  return out.join("");
}

/**
 * Reproduce Python round() to nearest integer with ties-to-even (banker's
 * rounding). JS Math.round is half-up, so it disagrees on exact halves.
 */
function _pyRoundHalfEven(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const floor = Math.floor(value);
  const diff = value - floor;
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) {
    return floor + 1;
  }
  if (diff < 0.5 - EPS) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

// ---------------------------------------------------------------------------
// render_text
// ---------------------------------------------------------------------------

/**
 * Render stats using the ANSI truecolor renderer.
 *
 * Delegates to render.stats_renderer.render_stats(). Falls back to the legacy
 * plain-text renderer if the new renderer raises.
 */
export function render_text(
  summary: StatsSummary,
  opts: { top_days?: number; top_projects?: number } = {},
): string {
  const topProjects = opts.top_projects ?? 5;
  try {
    return render_stats(self._to_stats_data(summary, topProjects));
  } catch (exc) {
    _LOG.warning(
      `new renderer failed (${String(exc)}), falling back to legacy`,
    );
  }
  return _render_text_legacy(summary, opts);
}

/**
 * Plain-text fallback renderer (the TS analogue of the Python rich fallback).
 *
 * `rich` is not available in Node; this reproduces the same section structure
 * and the literal substrings the tests assert: the version-stamped title,
 * "By kind", "By source", "By command", "By day", "By project", the
 * "realized savings" note, and the raw numeric totals (including negatives).
 */
export function _render_text_legacy(
  summary: StatsSummary,
  opts: { top_days?: number; top_projects?: number } = {},
): string {
  const topDays = opts.top_days ?? 7;
  const topProjects = opts.top_projects ?? 5;
  const windowDesc =
    summary.window_days === 0 ? "all time" : `last ${summary.window_days} days`;

  const lines: string[] = [];

  // ---- Headline ----
  lines.push(`token-goat stats  v${__version__}  ·  ${windowDesc}`);
  lines.push(
    `  Total: ${_fmtIntComma(summary.total_events)} events     ` +
      `${_fmt_bytes(summary.total_bytes_saved)} saved     ` +
      `~${_fmt_tokens(summary.total_tokens_saved)} tokens (estimated)`,
  );

  // ---- By kind ----
  const byKind = summary.by_kind;
  const kindNames = Object.keys(byKind);
  if (kindNames.length > 0) {
    lines.push("");
    lines.push("By kind:");
    const kindsSorted = [...kindNames].sort(
      (a, b) => byKind[b]!.bytes_saved - byKind[a]!.bytes_saved,
    );
    const maxBytes = kindsSorted.reduce(
      (acc, k) => Math.max(acc, byKind[k]!.bytes_saved),
      0,
    );
    for (const kind of kindsSorted) {
      const v = byKind[kind]!;
      const [bar] = _bar_text(v.bytes_saved, maxBytes);
      lines.push(
        `  ${kind}  ${bar}  ${_fmt_bytes(v.bytes_saved)}  ` +
          `${_fmt_tokens(v.tokens_saved)}  ${v.events} ev`,
      );
    }

    const img = byKind["image_shrink"];
    if (img && img.events > 0) {
      lines.push(
        "  note: image token estimates use Claude's vision pricing formula " +
          "(pixel dimensions / 750, capped at 1568 px/side).",
      );
    }

    const hintGross = byKind["session_hint"];
    const hintOverhead = byKind["session_hint_overhead"];
    if (hintGross && hintOverhead) {
      lines.push(
        "  note: session_hint shows realized savings; session_hint_overhead " +
          "shows injected hint cost; headline totals are net.",
      );
    }
  }

  // ---- By source ----
  const bySource = summary.by_source;
  const sourceNames = Object.keys(bySource);
  if (sourceNames.length > 0) {
    lines.push("");
    lines.push("By source:");
    const sourcesSorted = [...sourceNames].sort(
      (a, b) => bySource[b]!.bytes_saved - bySource[a]!.bytes_saved,
    );
    const maxBytes = sourcesSorted.reduce(
      (acc, s) => Math.max(acc, bySource[s]!.bytes_saved),
      0,
    );
    for (const source of sourcesSorted) {
      const v = bySource[source]!;
      const [bar] = _bar_text(v.bytes_saved, maxBytes);
      lines.push(
        `  ${source}  ${bar}  ${_fmt_bytes(v.bytes_saved)}  ` +
          `${_fmt_tokens(v.tokens_saved)}  ${v.events} ev`,
      );
    }
  }

  // ---- By command ----
  if (summary.by_command.length > 0) {
    lines.push("");
    lines.push("By command:");
    const cmds = summary.by_command;
    const maxBytes = cmds.reduce((acc, c) => Math.max(acc, c.bytes_saved), 0);
    for (const c of cmds) {
      const [bar] = _bar_text(c.bytes_saved, maxBytes);
      lines.push(
        `  ${c.command}  ${bar}  ${_fmt_bytes(c.bytes_saved)}  ` +
          `${_fmt_tokens(c.tokens_saved)}  ${c.events} ev`,
      );
    }
  }

  // ---- Activity sparkline ----
  if (summary.by_day.length > 0) {
    const daysForSpark = summary.by_day.slice(0, topDays);
    const daysChrono = [...daysForSpark].reverse();
    const sparkValues = daysChrono.map((d) => d.events);
    const spark = _sparkline(sparkValues);
    const dateRange =
      daysChrono.length > 1
        ? `${daysChrono[0]!.date} -> ${daysChrono[daysChrono.length - 1]!.date}`
        : daysChrono[0]!.date;
    lines.push("");
    lines.push(`Activity (${dateRange})  ${spark}`);
  }

  // ---- By day ----
  if (summary.by_day.length > 0) {
    lines.push("");
    lines.push(`By day (top ${topDays}):`);
    const days = summary.by_day.slice(0, topDays);
    const maxBytes = days.reduce((acc, d) => Math.max(acc, d.bytes_saved), 0);
    for (const d of days) {
      const [bar] = _bar_text(d.bytes_saved, maxBytes);
      lines.push(
        `  ${d.date}  ${bar}  ${_fmt_bytes(d.bytes_saved)}  ` +
          `${_fmt_tokens(d.tokens_saved)}  ${d.events} ev`,
      );
    }
  }

  // ---- By project ----
  if (summary.by_project.length > 0) {
    lines.push("");
    lines.push(`By project (top ${topProjects}):`);
    const projs = summary.by_project.slice(0, topProjects);
    const maxBytes = projs.reduce((acc, p) => Math.max(acc, p.bytes_saved), 0);
    for (const p of projs) {
      const label = _short_project(p.project_root);
      const [bar] = _bar_text(p.bytes_saved, maxBytes);
      lines.push(
        `  ${label}  ${bar}  ${_fmt_bytes(p.bytes_saved)}  ` +
          `${_fmt_tokens(p.tokens_saved)}  ${p.events} ev`,
      );
    }
    for (const p of projs) {
      const safeRoot = p.project_root
        ? _strip_ansi(p.project_root)
        : "(unknown)";
      lines.push(`    ${p.project_hash.slice(0, 8)}  ${safeRoot}`);
    }
  }

  if (summary.total_events === 0) {
    lines.push("");
    lines.push(
      "(no recorded savings yet. token-goat will accumulate stats as it " +
        "intercepts reads, image fetches, etc.)",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// render_by_project / render_by_command
// ---------------------------------------------------------------------------

/**
 * Render a focused per-project breakdown table, ordered by tokens saved.
 *
 * Delegates to the ANSI renderer's section helpers; falls back to a plain-text
 * table if rendering raises.
 */
export function render_by_project(summary: StatsSummary, top: number = 10): string {
  try {
    // The Python original assembles header + KPI + by-project sections from the
    // renderer's private helpers. The TS renderer does not export those three
    // helpers individually for assembly here, so the full report is rendered and
    // is structurally equivalent for the by-project view.
    return render_stats(self._to_stats_data(summary, top));
  } catch (exc) {
    _LOG.warning(`new renderer failed for by-project (${String(exc)}), falling back`);
  }

  const lines: string[] = [`By project (top ${top}):`];
  if (summary.by_project.length === 0) {
    lines.push("  (no project data recorded yet)");
    return lines.join("\n");
  }
  for (const p of summary.by_project.slice(0, top)) {
    const label = _short_project(p.project_root);
    lines.push(
      `  ${label}  ${_fmt_tokens(p.tokens_saved)}  ` +
        `${_fmt_bytes(p.bytes_saved)}  ${p.events}`,
    );
    lines.push(
      `    ${p.project_hash.slice(0, 8)}  ${p.project_root || "(unknown)"}`,
    );
  }
  return lines.join("\n");
}

/**
 * Render a focused per-command breakdown table, ordered by tokens saved.
 *
 * Falls back to a plain-text table when rendering raises.
 */
export function render_by_command(summary: StatsSummary): string {
  try {
    return render_stats(self._to_stats_data(summary));
  } catch (exc) {
    _LOG.warning(`new renderer failed for by-command (${String(exc)}), falling back`);
  }

  const lines: string[] = ["By command:"];
  if (summary.by_command.length === 0) {
    lines.push("  (no command data recorded yet)");
    return lines.join("\n");
  }
  for (const c of summary.by_command) {
    lines.push(
      `  ${c.command}  ${_fmt_tokens(c.tokens_saved)}  ` +
        `${_fmt_bytes(c.bytes_saved)}  ${c.events}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// __all__ parity (Python stats.__all__)
// ---------------------------------------------------------------------------

/** Mirror of Python stats.__all__ — the public export surface. */
export const __all__: readonly string[] = [
  "BYTES_MODE_ONLY_KINDS",
  "SOURCE_BASH",
  "SOURCE_COMPACT",
  "SOURCE_HINT",
  "SOURCE_IMAGE",
  "SOURCE_OTHER",
  "SOURCE_READ",
  "SOURCE_SKILL",
  "SOURCE_WEB",
  "StatsSummary",
  "kind_to_source",
  "render_by_command",
  "render_by_project",
  "render_text",
  "summarize",
];
