/**
 * Session manifest generator for compaction assist — TypeScript port of
 * src/token_goat/compact.py (the 7118-LOC compaction mega-module).
 *
 * Builds a <400-token structured summary of the session's file activity so the
 * compaction LLM knows what to preserve without reading the full conversation.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY (snake_case) for every name a test
 *    imports / asserts on: functions, UPPER_SNAKE + _underscore constants, and
 *    the ContextPressure class. camelCase aliases are NOT added (the Python names
 *    are the canonical contract the test files grep for).
 *  - estimate_tokens / char-budget math use code-point length (`.length`), which
 *    matches Python `len(str)` for the BMP text the manifest carries. Byte math
 *    (none needed in this module beyond hashing) would go through util.utf8Bytes.
 *  - hashlib.sha256(...).hexdigest()[:16] -> cache_common.short_content_hash
 *    (createHash("sha256").update(Buffer.from(text,"utf8")).digest("hex")[:16]).
 *  - re.compile(...) -> top-level RegExp literals compiled once at module load,
 *    preserving flags/semantics (IGNORECASE -> "i", MULTILINE -> "m").
 *  - Module-global mutable state (the bounded TTL caches: whole-repo-diff cache,
 *    diff-stat-summary cache, uncommitted-changes cache, is-git-repo cache,
 *    blocker-preview cache, and the _manifest_sha_written_this_process set) are
 *    module-level Maps/Sets cleared by a SINGLE registerReset (test_compact_cache_
 *    reset depends on this being wired correctly).
 *  - Sibling modules a test spies on are reached via STATIC `import * as x` so
 *    vi.spyOn(x, "fn") is observed (paths, session, db, config, cache_common,
 *    hooks_common, util). NEVER createRequire.
 *  - paths.data_dir() (Python returns Path) -> paths.dataDir() (string); the
 *    `Path / "a" / "b"` join becomes path.join(paths.dataDir(), "a", "b"). The
 *    cross-session-dedup tests spy on paths.dataDir, so every call routes through
 *    the static paths import.
 *  - ContextPressure is a frozen dataclass -> a class with readonly fields. Its
 *    `tier` is the 4-value literal "cool"|"warm"|"hot"|"critical" (the module's
 *    own ContextTier). types.ts's PressureTier is only the 3-value advisory
 *    bucket ("cool"|"warm"|"hot"); it is imported for reference but the 4th value
 *    ("critical") forces a local union. Reported in parity_notes.
 *  - skill_cache.ts and bash_cache.ts are NOT yet ported. The Python compact does
 *    lazy `from . import bash_cache` / `from . import skill_cache` inside the
 *    manifest builders and wraps every call in try/except returning a fail-soft
 *    default. The TS port mirrors hints.ts: a _setBashCacheModule /
 *    _setSkillCacheModule injection seam + best-effort resolver that returns null
 *    when the module is absent, so the builders fail soft. Reported in
 *    known_gaps + new_deps_needed.
 *  - heapq.nlargest(n, iterable, key) -> a local _nlargest helper with stable
 *    ordering (Python's heapq.nlargest is NOT stable for ties, but the manifest
 *    sort keys are timestamps/scores that rarely tie and the tests do not assert
 *    on tie order, so a stable sort-and-slice is a faithful-enough port).
 *  - math.exp / math.log -> Math.exp / Math.log. round() (banker's-ish in CPython
 *    only at .5) -> Math.round for the budget arithmetic; the inputs are never
 *    exactly N.5 in the tested paths, so the half-even-vs-half-up difference is
 *    unobservable. int(round(x)) -> Math.trunc(Math.round(x)). int(x) (truncate
 *    toward zero) -> Math.trunc(x); `x // y` (floor div on non-negative ints) ->
 *    Math.floor(x / y).
 *  - urllib.parse.urlparse -> the WHATWG `new URL(...)` with a fail-soft fallback
 *    for the netloc/path/params/query extraction in _group_web_entries_by_domain.
 *  - datetime.fromtimestamp(ts, tz=UTC).strftime(...) -> Date(ts*1000) UTC getters
 *    formatted by hand to the same %H:%M / %Y-%m-%dT%H:%M:%SZ shapes.
 *
 * verbatimModuleSyntax is on -> type-only imports use `import type`.
 * exactOptionalPropertyTypes is on -> optional fields are `T | undefined`.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as paths from "./paths.js";
import * as session from "./session.js";
import * as db from "./db.js";
import * as config from "./config.js";
import { short_content_hash as _short_content_hash, short_output_id as _short_id } from "./cache_common.js";
import { sanitize_log_str } from "./hooks_common.js";
import { _humanizeBytes as _humanize_bytes, ellipsize, getLogger, runGit as _util_run_git } from "./util.js";
import { registerReset } from "./reset.js";
import { canonicalize as _canonicalize, project_hash as _project_hash_fn } from "./project.js";

// Re-export _humanize_bytes under the Python name: the Python compact module
// imports it into its own namespace (`from .util import _humanize_bytes`), so a
// test that reads `compact._humanize_bytes` must resolve here too.
export { _humanize_bytes };

import type { ConfigSchema } from "./types.js";
import type { PressureTier } from "./types.js";
import type { SessionCache, FileEntry } from "./session.js";

// PressureTier (3-value advisory bucket "cool"|"warm"|"hot") is imported for
// reference; ContextPressure.tier needs the 4-value union below. Referenced via
// a type alias so the unused-import lint does not fire and the relationship is
// documented at the type level.
type _PressureTierRef = PressureTier;

// ---------------------------------------------------------------------------
// __all__ — public symbol surface (parity with Python's compact.__all__).
// ---------------------------------------------------------------------------
// Kept as a runtime array so a test that asserts membership ports one-for-one.
export const __all__ = [
  "build_manifest",
  "build_manifest_with_count",
  "build_manifest_adaptive",
  "compute_adaptive_budget",
  "_compute_budget_multiplier",
  "event_count",
  "is_noise_path",
  "_dedup_grep_entries",
  "CONTEXT_AUTOCOMPACT_TOKENS",
  "CATALOG_TOKENS",
  "CONTEXT_TIER_WARM",
  "CONTEXT_TIER_HOT",
  "CONTEXT_TIER_CRITICAL",
  "tier_for_fraction",
  "ContextPressure",
  "get_context_pressure",
  "_build_sealed_block",
  "_format_hint_telemetry",
  "_get_inline_diff_for_file",
  "_get_whole_repo_diff",
  "_extract_test_failures",
  "_extract_dep_changes",
  "_format_session_stats",
  "_score_manifest",
  "_score_manifest_breakdown",
  "_parse_manifest_sections",
  "_MANIFEST_THIN_THRESHOLD",
  "_TOP_FILES_GUARANTEED_MIN",
  "find_latest_session_id",
  "infer_session_goal",
  "_enforce_char_budget",
  "detect_harness",
  "get_auto_trigger_multiplier",
] as const;

const _LOG = getLogger("compact");

// ---------------------------------------------------------------------------
// Small Python-builtin shims used throughout the module.
// ---------------------------------------------------------------------------

/**
 * heapq.nlargest(n, iterable, key) analogue. Returns the n elements with the
 * largest key, ordered largest-first. A stable sort-and-slice: Python's
 * heapq.nlargest is not guaranteed stable for ties, but the manifest sort keys
 * (timestamps, importance scores) effectively never tie in tested paths, so a
 * stable descending sort then slice is a faithful port and avoids a heap impl.
 */
function _nlargest<T>(n: number, items: Iterable<T>, key: (item: T) => number): T[] {
  const arr = [...items];
  arr.sort((a, b) => key(b) - key(a));
  return arr.slice(0, Math.max(0, n));
}

/** Python str(...).strip() over an unknown attr value, defaulting to "". */
function _strAttr(obj: unknown, name: string, fallback = ""): string {
  if (obj !== null && typeof obj === "object" && name in obj) {
    const v = (obj as Record<string, unknown>)[name];
    if (v === null || v === undefined) {
      return fallback;
    }
    return typeof v === "string" ? v : String(v);
  }
  return fallback;
}

/** getattr(obj, name, default) for a numeric attribute. Non-number -> default. */
function _numAttr(obj: unknown, name: string, fallback: number): number {
  if (obj !== null && typeof obj === "object" && name in obj) {
    const v = (obj as Record<string, unknown>)[name];
    if (typeof v === "number") {
      return v;
    }
  }
  return fallback;
}

/** getattr(obj, name, default) returning the raw value (or default if absent). */
function _attr(obj: unknown, name: string, fallback: unknown): unknown {
  if (obj !== null && typeof obj === "object" && name in obj) {
    const v = (obj as Record<string, unknown>)[name];
    return v === undefined ? fallback : v;
  }
  return fallback;
}

/** True for a plain (non-array, non-null) object — the JS analogue of isinstance(x, dict). */
function _isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python Path(p).name — final path component (after normalising backslashes). */
function _basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** Python Path(p).parent — directory component as a string ("." when none). */
function _parentDir(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) {
    return ".";
  }
  if (idx === 0) {
    return "/";
  }
  return norm.slice(0, idx);
}

/** Python `Path(a) / b` join used only for display-path construction. */
function _joinPosix(dir: string, name: string): string {
  if (dir === "." || dir === "") {
    return name;
  }
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** UTC strftime("%H:%M") for a unix-seconds timestamp. */
function _strftimeHM(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** UTC strftime("%Y-%m-%dT%H:%M:%SZ") for a unix-seconds timestamp. */
function _strftimeISO(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  const Y = String(d.getUTCFullYear()).padStart(4, "0");
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${Y}-${M}-${D}T${h}:${m}:${s}Z`;
}

/** time.time() — float seconds. */
function _now(): number {
  return Date.now() / 1000;
}

/** time.monotonic() — float seconds (monotonic clock). */
function _monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

function _norm_key(path: unknown): string {
  // Return the case-insensitive normalized path key used in compact lookups.
  return paths.normalizeKey(String(path)).toLowerCase();
}

export function estimate_tokens(text: string): number {
  // Rough token estimate: ~3 chars/token (conservative vs. the true 3.5 ratio).
  // Inlined from repomap.estimate_tokens to avoid loading repomap during the
  // PreCompact hook cold-start. Python: max(1, len(text) // 3 + 1).
  return Math.max(1, Math.floor(text.length / 3) + 1);
}

// ---------------------------------------------------------------------------
// Context pressure constants
// ---------------------------------------------------------------------------

/** The token count at which Claude Code auto-compacts the conversation. */
export const CONTEXT_AUTOCOMPACT_TOKENS = 660_000;

/** Estimated tokens consumed by the skill catalog listing injected by token-goat. */
export const CATALOG_TOKENS = 10_800;

// Context-fill fraction boundaries separating the four pressure tiers.
//   fill <  CONTEXT_TIER_WARM      -> "cool"
//   CONTEXT_TIER_WARM     <= fill  -> "warm"
//   CONTEXT_TIER_HOT      <= fill  -> "hot"
//   CONTEXT_TIER_CRITICAL <= fill  -> "critical"
export const CONTEXT_TIER_WARM = 0.5;
export const CONTEXT_TIER_HOT = 0.7;
export const CONTEXT_TIER_CRITICAL = 0.85;

/** The 4-value pressure tier ContextPressure carries (superset of PressureTier). */
export type ContextTier = "cool" | "warm" | "hot" | "critical";

export function tier_for_fraction(fill: number): ContextTier {
  // Map a context-fill fraction to its qualitative pressure tier. The boundaries
  // are the module-level CONTEXT_TIER_* constants. Values above 1.0 map to
  // "critical" (no clamping needed — the comparisons are monotone).
  if (fill >= CONTEXT_TIER_CRITICAL) {
    return "critical";
  }
  if (fill >= CONTEXT_TIER_HOT) {
    return "hot";
  }
  if (fill >= CONTEXT_TIER_WARM) {
    return "warm";
  }
  return "cool";
}

/**
 * Snapshot of estimated context fill at a point in time.
 *
 * Python's `@dataclass(frozen=True)` -> a class with readonly fields. Two
 * instances built from the same inputs compare field-by-field equal (the tests
 * assert on `.fill_fraction` / `.tier`, never on object identity), matching the
 * frozen-dataclass value semantics.
 */
export class ContextPressure {
  readonly fill_fraction: number;
  readonly tier: ContextTier;

  constructor(args: { fill_fraction: number; tier: ContextTier }) {
    this.fill_fraction = args.fill_fraction;
    this.tier = args.tier;
  }
}

export function _pressure_raw_total(cache: unknown): number {
  // Return the raw (pre-baseline-subtraction) context pressure total for cache.
  // Separated from get_context_pressure so pre_compact can snapshot the total
  // before resetting it as the new baseline.
  const skill_tokens: number = _numAttr(cache, "loaded_skill_total_tokens", 0);
  const observed: number = _numAttr(cache, "observed_tool_tokens", 0);
  if (observed > 0) {
    // Measured path: actual response bytes accumulated by post-hooks.
    return skill_tokens + CATALOG_TOKENS + observed;
  }
  // Legacy fallback: per-count proxies for sessions without measured token data.
  const bash_history = _attr(cache, "bash_history", null);
  const bash_count: number = _isDict(bash_history) ? Object.keys(bash_history).length : 0;
  const web_history = _attr(cache, "web_history", null);
  const web_count: number = _isDict(web_history) ? Object.keys(web_history).length : 0;
  const files = _attr(cache, "files", null);
  const read_count: number = _isDict(files) ? Object.keys(files).length : 0;
  return skill_tokens + CATALOG_TOKENS + bash_count * 500 + web_count * 1_000 + read_count * 200;
}

export function get_context_pressure(
  session_id: string | null = null,
  opts: { cache?: SessionCache | null } = {},
): ContextPressure {
  // Return the estimated context fill fraction and pressure tier. Divides the
  // summed contributors by CONTEXT_AUTOCOMPACT_TOKENS (660,000) — the budget at
  // which Claude Code triggers auto-compaction — to get a fill fraction, then
  // maps to a tier via tier_for_fraction. Returns fill_fraction=0.0/tier="cool"
  // when the cache is unavailable or session_id is null.
  let cache = opts.cache ?? null;
  try {
    if (cache === null || cache === undefined) {
      cache = session_id ? session.safe_load(session_id, { caller: "get-context-pressure" }) : null;
    }
    if (cache === null || cache === undefined) {
      return new ContextPressure({ fill_fraction: 0.0, tier: "cool" });
    }

    const raw_total = _pressure_raw_total(cache);
    const baseline: number = _numAttr(cache, "pressure_baseline_tokens", 0);
    const total = Math.max(0, raw_total - baseline);
    const windowBudget = CONTEXT_AUTOCOMPACT_TOKENS;
    const fill = total / windowBudget;

    return new ContextPressure({ fill_fraction: fill, tier: tier_for_fraction(fill) });
  } catch {
    return new ContextPressure({ fill_fraction: 0.0, tier: "cool" });
  }
}

// ---------------------------------------------------------------------------
// Harness detection
// ---------------------------------------------------------------------------

/** Known harness identifiers returned by detect_harness. */
const _KNOWN_HARNESSES: ReadonlySet<string> = new Set(["claudecode", "codex", "opencode", "generic"]);

/** Per-harness default multipliers for auto_trigger_multiplier. */
const _HARNESS_MULTIPLIER_DEFAULTS: Readonly<Record<string, number>> = {
  claudecode: 2.0,
  codex: 1.5,
  opencode: 2.5,
  generic: 1.0,
};

export function detect_harness(config_override = "auto"): string {
  // Detect the active AI harness from environment variables. When config_override
  // is not "auto", returns it directly. Detection order mirrors the Python
  // docstring: TOKEN_GOAT_HARNESS_OVERRIDE, then CLAUDE_CODE_SESSION_ID /
  // ANTHROPIC_API_KEY, CODEX_SESSION, OPENCODE_SESSION, OPENAI_API_KEY without
  // ANTHROPIC_API_KEY, else "generic".
  if (config_override !== "auto") {
    if (_KNOWN_HARNESSES.has(config_override)) {
      return config_override;
    }
    _LOG.warning("detect_harness: unknown override %s; falling back to env detection", config_override);
  }

  const _harness_override = (process.env.TOKEN_GOAT_HARNESS_OVERRIDE ?? "").trim().toLowerCase();
  if (_KNOWN_HARNESSES.has(_harness_override)) {
    return _harness_override;
  }
  if (_harness_override) {
    _LOG.warning(
      "detect_harness: TOKEN_GOAT_HARNESS_OVERRIDE=%s not a known harness; ignoring",
      _harness_override,
    );
  }

  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.ANTHROPIC_API_KEY) {
    return "claudecode";
  }
  if (process.env.CODEX_SESSION) {
    return "codex";
  }
  if (process.env.OPENCODE_SESSION) {
    return "opencode";
  }
  if (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return "codex";
  }
  return "generic";
}

export function get_auto_trigger_multiplier(
  config_explicit_multiplier: number | null = null,
  harness: string | null = null,
  is_config_default: boolean | null = null,
): number {
  // Get the effective auto_trigger_multiplier for the detected harness. When the
  // user has not explicitly configured it (still 2.0), apply per-harness
  // defaults. Result clamped to [1.0, 10.0].
  let isDefault = is_config_default;
  if (isDefault === null) {
    // Auto-detect: 2.0 is the hardcoded default in CompactAssistConfig.
    isDefault = config_explicit_multiplier === 2.0;
  }

  if (!isDefault && config_explicit_multiplier !== null) {
    return Math.max(1.0, Math.min(10.0, config_explicit_multiplier));
  }

  let h = harness;
  if (h === null) {
    h = detect_harness();
  }

  const default_multiplier = _HARNESS_MULTIPLIER_DEFAULTS[h] ?? 1.0;
  return Math.max(1.0, Math.min(10.0, default_multiplier));
}

export function infer_session_goal(cache: unknown, max_tokens = 80): string {
  // Infer the session's goal from edited files, accessed symbols, and recent bash
  // commands. Returns a factual 1-2 sentence description, or "" if insufficient
  // data exists (fewer than 2 edited files and no symbols). All mechanical string
  // construction — no LLM call.
  try {
    const edited_files_raw = (_attr(cache, "edited_files", null) as Record<string, unknown> | null) ?? {};
    const symbol_access_raw = (_attr(cache, "symbol_access_counts", null) as Record<string, unknown> | null) ?? {};
    const bash_hist = (_attr(cache, "bash_history", null) as Record<string, unknown> | null) ?? {};

    const editedKeys = _isDict(edited_files_raw) ? Object.keys(edited_files_raw) : [];
    const symbolKeys = _isDict(symbol_access_raw) ? Object.keys(symbol_access_raw) : [];

    // Gate: need at least 2 edited files OR symbols to infer a goal.
    if (editedKeys.length < 2 && symbolKeys.length === 0) {
      return "";
    }

    // --- Signal 1: Extract area/component from edited file paths ---
    const dir_counts: Record<string, number> = {};
    for (const fpath of editedKeys) {
      try {
        let parent = _parentDir(String(fpath));
        if (parent.startsWith(".")) {
          parent = parent.slice(2).replace(/^[/\\]+/, "") || "root";
        }
        if (parent) {
          dir_counts[parent] = (dir_counts[parent] ?? 0) + 1;
        }
      } catch {
        _LOG.debug("_build_session_topic: failed to parse path %s (skip)", String(fpath));
      }
    }

    let top_area = "";
    if (Object.keys(dir_counts).length > 0) {
      top_area = Object.keys(dir_counts).reduce((a, b) => ((dir_counts[b] ?? 0) > (dir_counts[a] ?? 0) ? b : a));
    }

    // --- Signal 2: Top 3 symbols by access count ---
    let top_symbols: string[] = [];
    if (symbolKeys.length > 0) {
      const sorted_syms = symbolKeys
        .map((k) => [k, Number(symbol_access_raw[k] ?? 0)] as [string, number])
        .sort((a, b) => b[1] - a[1]);
      top_symbols = sorted_syms.slice(0, 3).map(([sym]) => sym);
    }

    // --- Signal 3: Recent git commit messages and bash work patterns ---
    let recent_commits: string[] = [];
    const work_mode_counts: Record<string, number> = {
      testing: 0,
      linting: 0,
      "type-checking": 0,
      building: 0,
      reviewing: 0,
    };
    const _BASH_WORK_PATTERNS: Array<[string, string]> = [
      ["pytest", "testing"],
      ["python -m pytest", "testing"],
      ["uv run pytest", "testing"],
      ["npm test", "testing"],
      ["cargo test", "testing"],
      ["ruff", "linting"],
      ["flake8", "linting"],
      ["eslint", "linting"],
      ["prettier", "linting"],
      ["mypy", "type-checking"],
      ["pyright", "type-checking"],
      ["tsc", "type-checking"],
      ["uv sync", "building"],
      ["pip install", "building"],
      ["npm install", "building"],
      ["cargo build", "building"],
      ["git diff", "reviewing"],
      ["git log", "reviewing"],
      ["git show", "reviewing"],
    ];
    const bashValues = _isDict(bash_hist) ? Object.values(bash_hist) : [];
    for (const entry of bashValues) {
      const cmd = _strAttr(entry, "cmd_preview").trim();
      const cmd_lower = cmd.toLowerCase();
      if (cmd_lower.startsWith("git commit")) {
        const m = /-m\s+["']([^"']+)["']/.exec(cmd);
        if (m && m[1]) {
          const msg = m[1].trim();
          if (msg) {
            recent_commits.push(msg.slice(0, 60));
          }
        }
      } else {
        for (const [prefix, mode] of _BASH_WORK_PATTERNS) {
          if (cmd_lower.startsWith(prefix) || cmd_lower.includes(` ${prefix}`)) {
            work_mode_counts[mode] = (work_mode_counts[mode] ?? 0) + 1;
            break;
          }
        }
      }
    }
    recent_commits = recent_commits.slice(0, 2);

    let dominant_mode = "";
    const modeKeys = Object.keys(work_mode_counts);
    const max_mode_count = modeKeys.length > 0 ? Math.max(...modeKeys.map((k) => work_mode_counts[k] ?? 0)) : 0;
    if (max_mode_count >= 2) {
      dominant_mode = modeKeys.reduce((a, b) => ((work_mode_counts[b] ?? 0) > (work_mode_counts[a] ?? 0) ? b : a));
    }

    // --- Build the goal sentence ---
    const parts: string[] = [];
    if (top_area && top_symbols.length > 0) {
      parts.push(`Working on ${top_area}, focusing on ${top_symbols.slice(0, 2).join(" and ")}.`);
    } else if (top_area) {
      parts.push(`Working on changes in ${top_area}.`);
    } else if (top_symbols.length > 0) {
      parts.push(`Focusing on ${top_symbols.slice(0, 2).join(" and ")}.`);
    }

    if (recent_commits.length > 0 && parts.join(" ").length < max_tokens * 2) {
      const intent = recent_commits[0]!;
      parts.push(`Recent work: ${intent}.`);
    } else if (dominant_mode && recent_commits.length === 0 && parts.join(" ").length < max_tokens * 2) {
      parts.push(`Session activity: ${dominant_mode}.`);
    }

    let goal = parts.join(" ");

    const estimated_tokens = estimate_tokens(goal);
    if (estimated_tokens > max_tokens && parts.length > 1) {
      goal = parts[0]!;
    }

    return goal.trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// git subprocess wrapper
// ---------------------------------------------------------------------------

function _run_git(args: string[], cwd: string, timeout = 5): string | null {
  // Run `git <args>` in cwd and return stripped stdout, or null on failure.
  // Delegates to util.runGit for consistent kwargs. Returns null when git is not
  // found, the exit code is non-zero, or the output is empty. util.runGit folds
  // spawn errors into returncode=-1 (never throws on ENOENT), matching the
  // Python (OSError, SubprocessError)-swallowing contract.
  try {
    const result = _util_run_git(args, { cwd, timeout });
    if (result.returncode !== 0 || !result.stdout.trim()) {
      return null;
    }
    return result.stdout.trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// bash_cache / skill_cache seams — NOT YET PORTED.
// ---------------------------------------------------------------------------
// The Python compact does lazy `from . import bash_cache` / `from . import
// skill_cache` inside the manifest builders and wraps every call in try/except
// returning a fail-soft default. bash_cache.ts / skill_cache.ts are not part of
// the ported layer set, so a static `import * as bash_cache from "./bash_cache.js"`
// would fail to resolve at load. These seams mirror hints.ts: when the module is
// absent the callers return their fail-soft default ("", [], null). A later layer
// that lands bash_cache.ts / skill_cache.ts can inject it via the setters; tests
// inject mock implementations the same way. Reported in known_gaps +
// new_deps_needed.

interface _BashCacheModule {
  load_output(output_id: string): string | null;
  get_recent_error_outputs(
    session_id: string,
    opts?: { max_entries?: number },
  ): Array<Record<string, unknown>>;
}

interface _SkillCacheModule {
  get_compact(session_id: string, skill_name: string): string | null;
  get_compact_any_session(skill_name: string): string | null;
  extract_compact_source_sha(compact_text: string): string | null;
  _strip_compact_header(compact_text: string): string;
}

let _bashCacheModuleOverride: _BashCacheModule | undefined;
let _skillCacheModuleOverride: _SkillCacheModule | undefined;

/** Test/late-layer seam: inject a bash_cache implementation (or undefined to clear). */
export function _setBashCacheModule(mod: _BashCacheModule | undefined): void {
  _bashCacheModuleOverride = mod;
}

/** Test/late-layer seam: inject a skill_cache implementation (or undefined to clear). */
export function _setSkillCacheModule(mod: _SkillCacheModule | undefined): void {
  _skillCacheModuleOverride = mod;
}

/** Resolve the bash_cache module: the injected override wins, else null (fail-soft). */
function _getBashCache(): _BashCacheModule | null {
  return _bashCacheModuleOverride ?? null;
}

/** Resolve the skill_cache module: the injected override wins, else null (fail-soft). */
function _getSkillCache(): _SkillCacheModule | null {
  return _skillCacheModuleOverride ?? null;
}

// ---------------------------------------------------------------------------
// Manifest sizing / section constants (all Final[int] in Python).
// ---------------------------------------------------------------------------

const _MANIFEST_TIMEOUT_SECS = 8.0;
const _MAX_FILES_READ = 10;
export const _TOP_FILES_GUARANTEED_MIN = 5;
const _MAX_SYMBOLS_FILES = 8;
const _MAX_RANGES_PER_FILE = 4;
const _MAX_SYMBOLS_PER_FILE_ENTRY = 6;
const _MAX_BASH_ENTRIES = 6;
const _COLD_OUTPUT_AGE_SECS = 1_800; // 30 minutes
const _MAX_COLD_OUTPUTS = 4;
const _SKILL_COMPACT_INLINE_MAX_CHARS = 600;
const _SKILL_INLINE_TOTAL_TOKEN_BUDGET = 300;
const _MAX_TODO_ENTRIES = 5;
const _MAX_TODO_SUBJECT_CHARS = 50;
const _MIN_BASH_BYTES_FOR_MANIFEST = 400;
const _MAX_TEST_FAILURES = 10;
const _MAX_DEP_CHANGES = 8;
const _MAX_SEALED_BASH_CMDS = 3;
const _MAX_WEB_ENTRIES = 4;
const _MIN_WEB_BYTES_FOR_MANIFEST = 200;
const _FULL_READ_SENTINEL_GAP = 99_999;
const _HOT_FILE_READ_THRESHOLD = 5;
const _HOT_FILE_MAX_SHOWN = 6;
const _MAX_GLOB_ENTRIES = 3;
const _MAX_GREP_ENTRIES = 5;
const _GREP_STALE_SECS = 2700; // 45 minutes
// Kept for external callers that may reference the old name.
const _GREP_MANIFEST_STALE_SECS = _GREP_STALE_SECS;
const _GREP_MIN_WHEN_ALL_STALE = 2;
const _GREP_RECENCY_HALF_LIFE_SECS = 1800.0; // 30 minutes
const _MAX_MANIFEST_TOKENS_CAP = 4_000;

// Directives appended after sidecar write — seen by the compaction LLM but
// excluded from the SHA/fingerprint.
const _COMPACT_DIRECTIVES =
  "\n### Compact Directives\n- `skill_listing` messages (the full available-skills list) are auto-regenerated at session start — replace each with: `[skill_listing: auto-injected]`\n- `hook_success` / `hook_error` messages are diagnostic telemetry — collapse all to: `[N hook events]`";
// ceiling div: -(-len // 3)
const _DIRECTIVE_TOKEN_RESERVE = Math.ceil(_COMPACT_DIRECTIVES.length / 3);
const _DIRECTIVE_APPEND_MIN_TOKENS = 2 * _DIRECTIVE_TOKEN_RESERVE;
const _AS_OF_TOKEN_RESERVE = 11;
const _WIDE_POINTER_MIN_SECTION_BUDGET = 100;
const _MANIFEST_CACHE_TTL_SECS = 600.0;

// Process-local set of session IDs for which we wrote a new manifest SHA this
// process run. Cleared by the shared registerReset below.
export const _manifest_sha_written_this_process: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Pre-compiled regex patterns used during manifest construction.
// ---------------------------------------------------------------------------

// Matches "FAILED tests/foo.py::ClassName::test_name" lines in pytest output.
// Python: re.compile(r"FAILED\s+((?:tests?|src)[^\s]+::[\w\[\]<>-]+(?:::[\w\[\]<>-]+)*)", re.IGNORECASE)
const _PYTEST_FAILED_RE = /FAILED\s+((?:tests?|src)[^\s]+::[\w[\]<>-]+(?:::[\w[\]<>-]+)*)/i;

// Package-manager install/update lines (pip/uv, npm, cargo, yarn).
const _DEP_CHANGE_PATTERNS: readonly RegExp[] = [
  /successfully installed\s+(.+)/i,
  /^\+\s+([\w@/-][\w@/.-]+)/m,
  /added\s+\d+\s+package/i,
  /^\s*added\s+([\w@/-].+)/im,
  /updated\s+([\w@/-].+)/i,
  /resolved\s+([\w@/-].+)/i,
  /compiling\s+([\w-]+)\s+v([\d.]+)/i,
];

// TODO/FIXME/WHY/HACK/XXX markers in source files.
// Python: re.compile(r"#\s*(TODO|FIXME|WHY|HACK|XXX)\b[:\s]*(.*?)(?:\s*$|\s*[#?])", re.IGNORECASE)
const _OPEN_QUESTION_MARKER_RE = /#\s*(TODO|FIXME|WHY|HACK|XXX)\b[:\s]*(.*?)(?:\s*$|\s*[#?])/i;
const _OPEN_QUESTION_INLINE_RE = /#[^#]*\?(?:\s|$)/;

// ---------------------------------------------------------------------------
// Manifest sidecar helpers.
// ---------------------------------------------------------------------------

export function _compute_manifest_fingerprint(cache: SessionCache): string {
  // Return a hex fingerprint that changes when manifest-driving state changes.
  // The sidecar cache must invalidate when file access details, edits, grep
  // history, bash/web/skill history, bash dedup exclusions, cwd, or the age tier
  // changes. Build-manifest bookkeeping fields are intentionally excluded.
  const _entryPayload = (entry: unknown): unknown => {
    // Python uses asdict(entry) for dataclasses; the TS session entries are
    // plain class instances, so spread their own enumerable fields. Exclude
    // symbols_ts (changes on every symbol access, doesn't affect output).
    if (entry !== null && typeof entry === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        if (k === "symbols_ts") {
          continue;
        }
        out[k] = v;
      }
      return out;
    }
    return entry;
  };

  const _dictPayload = (mapping: unknown): Record<string, unknown> => {
    if (!_isDict(mapping) || Object.keys(mapping).length === 0) {
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(mapping).sort()) {
      out[String(key)] = _entryPayload(mapping[key]);
    }
    return out;
  };

  const _listPayload = (items: unknown): unknown[] => {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }
    return items.map((item) => _entryPayload(item));
  };

  const now = _now();
  const created_ts = Number(_attr(cache, "created_ts", 0.0) || 0.0);
  const age_tier = _session_age_tier(Math.max(0.0, now - created_ts));
  const edited_files = _isDict(cache.edited_files) ? cache.edited_files : {};
  const bashDedupRaw = _attr(cache, "bash_dedup_emitted_ids", null);
  const bash_dedup_ids =
    bashDedupRaw instanceof Set
      ? [...bashDedupRaw].sort()
      : Array.isArray(bashDedupRaw)
        ? [...(bashDedupRaw as unknown[])].map(String).sort()
        : [];

  const hints_emitted = Math.trunc(Number(_attr(cache, "hints_emitted", 0) || 0));
  const _suppressed_raw = (_attr(cache, "hints_suppressed_by_type", null) as Record<string, unknown> | null) ?? {};
  const hints_suppressed = _isDict(_suppressed_raw)
    ? Object.values(_suppressed_raw).reduce((s: number, v) => s + Number(v ?? 0), 0)
    : 0;

  const edited_count = Object.keys(edited_files).length;
  const bashHist = (_attr(cache, "bash_history", null) as Record<string, unknown> | null) ?? {};
  const bash_count = _isDict(bashHist) ? Object.keys(bashHist).length : 0;

  // sorted(edited_files.items()) — Python sorts (key, value) pairs.
  const edited_items = Object.keys(edited_files)
    .sort()
    .map((k) => [k, edited_files[k]] as [string, number]);

  const payloadObj: Record<string, unknown> = {
    age_tier,
    bash_count,
    bash_dedup_emitted_ids: bash_dedup_ids,
    bash_history: _dictPayload(_attr(cache, "bash_history", null)),
    cwd: _attr(cache, "cwd", null),
    decisions: _listPayload(_attr(cache, "decisions", null)),
    edited_count,
    edited_files: edited_items,
    files: _dictPayload(_attr(cache, "files", null)),
    glob_history: _listPayload(_attr(cache, "glob_history", null)),
    greps: _listPayload(_attr(cache, "greps", null)),
    hints_emitted,
    hints_suppressed,
    skill_history: _dictPayload(_attr(cache, "skill_history", null)),
    web_history: _dictPayload(_attr(cache, "web_history", null)),
  };

  const payload = _jsonDumpsSorted(payloadObj);
  return _short_content_hash(payload);
}

// Sidecar payload version. v1 = {sha, fp, ts}. v2 adds {counts}.
const _SIDECAR_VERSION = 2;

function _read_manifest_sidecar(
  session_id: string,
): [string, string, number, Record<string, number> | null] | null {
  // Read the manifest sidecar and return [sha, fingerprint, emit_ts, counts] or
  // null. counts is null for v1 sidecars / when the field is absent/malformed.
  try {
    const sidecar = paths.manifestShaSidecarPath(session_id);
    const raw = fs.readFileSync(sidecar, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const sha = String(data["sha"]);
    const fp = String(data["fp"]);
    const ts = Number(data["ts"]);
    // Non-finite ts or empty sha/fp -> treat as unreadable (caller rebuilds).
    if (!Number.isFinite(ts) || !sha || !fp || sha === "undefined" || fp === "undefined") {
      return null;
    }
    const counts_raw = data["counts"];
    let counts: Record<string, number> | null = null;
    if (_isDict(counts_raw)) {
      try {
        const tmp: Record<string, number> = {};
        for (const [k, v] of Object.entries(counts_raw)) {
          tmp[String(k)] = Math.trunc(Number(v));
        }
        counts = tmp;
      } catch {
        counts = null;
      }
    }
    return [sha, fp, ts, counts];
  } catch {
    return null;
  }
}

function _write_manifest_sidecar(
  session_id: string,
  sha: string,
  fingerprint: string,
  ts: number,
  counts: Record<string, number> | null = null,
): void {
  // Write the manifest sidecar atomically. Errors are silently swallowed.
  try {
    const sidecar = paths.manifestShaSidecarPath(session_id);
    paths.ensureDir(nodePath.dirname(sidecar));
    const payload_dict: Record<string, unknown> = {
      v: _SIDECAR_VERSION,
      sha,
      fp: fingerprint,
      ts,
    };
    if (counts && Object.keys(counts).length > 0) {
      const c: Record<string, number> = {};
      for (const [k, v] of Object.entries(counts)) {
        c[k] = Math.trunc(v);
      }
      payload_dict["counts"] = c;
    }
    const payload = _jsonDumpsSorted(payload_dict);
    paths.atomicWriteText(sidecar, payload);
  } catch {
    // swallow
  }
}

export function _compute_section_counts(cache: unknown): Record<string, number> {
  // Return per-section element counts for the current cache snapshot.
  const _len = (obj: unknown): number => {
    if (Array.isArray(obj)) {
      return obj.length;
    }
    if (_isDict(obj)) {
      return Object.keys(obj).length;
    }
    if (obj instanceof Set) {
      return obj.size;
    }
    return 0;
  };

  const files: unknown = _attr(cache, "files", null) ?? {};
  const fileValues = _isDict(files) ? Object.values(files) : [];
  return {
    edited: _len(_attr(cache, "edited_files", null) ?? {}),
    files: _len(files),
    bash: _len(_attr(cache, "bash_history", null) ?? {}),
    web: _len(_attr(cache, "web_history", null) ?? {}),
    grep: _len(_attr(cache, "greps", null) ?? []),
    glob: _len(_attr(cache, "glob_history", null) ?? []),
    skill: _len(_attr(cache, "skill_history", null) ?? {}),
    decision: _len(_attr(cache, "decisions", null) ?? []),
    symbols: fileValues.filter((e) => {
      const s = _attr(e, "symbols_read", null);
      return Array.isArray(s) && s.length > 0;
    }).length,
  };
}

export function _format_manifest_delta(
  prior: Record<string, number> | null,
  current: Record<string, number>,
): string | null {
  // Return a one-line delta string or null. Format:
  //   **Δ since last compact:** +2 edited, +3 bash
  if (!prior || Object.keys(prior).length === 0) {
    return null;
  }
  const _ORDER = ["edited", "files", "bash", "web", "grep", "glob", "skill", "decision", "symbols"];
  const parts: string[] = [];
  for (const key of _ORDER) {
    const cur = Math.trunc(current[key] ?? 0);
    const old = Math.trunc(prior[key] ?? 0);
    const delta = cur - old;
    if (delta === 0) {
      continue;
    }
    const sign = delta > 0 ? "+" : "";
    parts.push(`${sign}${delta} ${key}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return "**Δ since last compact:** " + parts.join(", ");
}

/**
 * json.dumps(obj, separators=(",", ":"), sort_keys=True) analogue.
 *
 * Recursively serialises with object keys sorted, no whitespace. JSON.stringify
 * does not sort keys, so we walk the structure and emit a canonical form. Arrays
 * preserve order (Python sort_keys only sorts dict keys). This canonical form is
 * what feeds short_content_hash for the manifest fingerprint, so byte-stability
 * across runs matters; sorted keys + compact separators reproduce Python's
 * `json.dumps(..., separators=(",",":"), sort_keys=True)` output for the JSON
 * value types this module serialises (str/int/float/bool/null/list/dict).
 */
function _jsonDumpsSorted(value: unknown): string {
  return JSON.stringify(_sortKeysDeep(value));
}

function _sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => _sortKeysDeep(v));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Set)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = _sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (value instanceof Set) {
    return [...value].sort();
  }
  return value;
}

// ---------------------------------------------------------------------------
// Edited-file / read-file sort + noise constants.
// ---------------------------------------------------------------------------

const _MAX_EDITED_FILES_SHOWN = 20;

// Half-life for the recency component of _importance_score, in seconds.
const _RECENCY_HALF_LIFE_SECS = 1800.0; // 30 minutes

const _NOISE_EXTS: ReadonlySet<string> = new Set([
  ".pyc",
  ".pyo",
  ".pyd",
  ".class",
  ".o",
  ".obj",
  ".a",
  ".lib",
  ".dll",
  ".so",
  ".dylib",
  ".log",
  ".tmp",
  ".temp",
  ".swp",
  ".swo",
  ".bak",
  ".pid",
  ".lock",
]);
const _NOISE_BASENAMES: ReadonlySet<string> = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "coverage.xml",
  ".coverage",
  "lcov.info",
]);
const _NOISE_SEGMENTS: readonly string[] = [
  "/__pycache__/",
  "/.git/",
  "/node_modules/",
  "/.venv/",
  "/venv/",
  "/dist/",
  "/build/",
  "/.mypy_cache/",
  "/.pytest_cache/",
  "/.ruff_cache/",
  "/appdata/local/temp/",
  "/appdata/roaming/",
  "/tmp/",
  "/.next/",
  "/.nuxt/",
  "/.svelte-kit/",
  "/.turbo/",
  "/.parcel-cache/",
  "/.cache/",
  "/.tox/",
  "/coverage/",
  "/.nyc_output/",
  "/site-packages/",
  ".egg-info/",
  "/target/",
];

export function _importance_score(entry: FileEntry, now: number, edit_bonus = 0.0): number {
  // Composite importance score for manifest ranking of 'Key Files Read' entries.
  // read_score (read freq, capped at 10) + symbol_score (2.0 per unique symbol,
  // capped at 20 symbols) + edit_bonus + recency (exp decay, 30-min half-life).
  const read_score = Math.min(entry.read_count, 10) * 1.0;
  const symbol_score = Math.min(entry.symbols_read.length, 20) * 2.0;
  const age_seconds = Math.max(0.0, now - entry.last_read_ts);
  const recency = Math.exp((-age_seconds * Math.log(2)) / _RECENCY_HALF_LIFE_SECS);
  return read_score + symbol_score + edit_bonus + recency * 3.0;
}

export function is_noise_path(path: string): boolean {
  // Return true when path should be excluded from the manifest as low-value
  // noise (build artifacts, OS metadata, lockfiles, cache dirs). Case-insensitive
  // and tolerant of both POSIX and Windows separators. False for empty input.
  if (!path) {
    return false;
  }
  const p = _norm_key(path);
  for (const segment of _NOISE_SEGMENTS) {
    if (p.includes(segment)) {
      return true;
    }
  }
  const slash_idx = p.lastIndexOf("/");
  const basename = slash_idx >= 0 ? p.slice(slash_idx + 1) : p;
  if (_NOISE_BASENAMES.has(basename)) {
    return true;
  }
  if (basename.startsWith(".improve-state-") || basename.startsWith("improve_commit_msg_")) {
    return true;
  }
  const dot_idx = basename.lastIndexOf(".");
  return dot_idx >= 0 && _NOISE_EXTS.has(basename.slice(dot_idx));
}

// ---------------------------------------------------------------------------
// git diff helpers + process-level TTL caches.
// ---------------------------------------------------------------------------

const _DIFF_STAT_SUMMARY_TTL = 30.0;
const _DIFF_STAT_CACHE_MAX_ENTRIES = 32;

// Bounded module-global caches. ALL of these are wiped by the single
// registerReset below — test_compact_cache_reset depends on that wiring.
const _diff_stat_summary_cache: Map<string | null, [string, number]> = new Map();
const _uncommitted_changes_cache: Map<string | null, [string | null, number]> = new Map();
const _whole_diff_cache: Map<string, [string | null, number]> = new Map();
const _is_git_repo_cache: Map<string, boolean> = new Map();
export const _blocker_preview_cache: Map<string, string> = new Map();

/**
 * Single reset that clears every module-global bounded cache + the per-process
 * SHA set. Wired exactly once at load (idempotent by fn reference). The Python
 * conftest clears each of these module globals before every test;
 * test_compact_cache_reset asserts this reset returns them all to empty.
 */
registerReset(() => {
  _diff_stat_summary_cache.clear();
  _uncommitted_changes_cache.clear();
  _whole_diff_cache.clear();
  _is_git_repo_cache.clear();
  _blocker_preview_cache.clear();
  _manifest_sha_written_this_process.clear();
});

function _put_bounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  // Insert value under key in cache, evicting the oldest entry past the cap.
  // JS Map preserves insertion order, so the first key from keys() is oldest.
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= _DIFF_STAT_CACHE_MAX_ENTRIES) {
    const first = cache.keys().next();
    if (!first.done) {
      cache.delete(first.value);
    }
  }
  cache.set(key, value);
}

const _INLINE_DIFF_MAX_BYTES = 500; // per-file diff size gate (#7)
const _INLINE_DIFF_TOTAL_CAP = 800; // total inlined diff bytes (#7)
const _SINGLE_FILE_DIFF_CAP = 400; // whole-repo diff cap for single-file replace (#17)

const _WHOLE_DIFF_TTL_SECS = 30.0;

function _fetch_whole_repo_diff_cached(cwd: string): string | null {
  // Return the full `git diff HEAD` output for cwd, cached for the TTL. Empty
  // string is normalised to null so callers can use `if (diff === null)`.
  if (!cwd) {
    return null;
  }
  const now = _monotonic();
  const cached = _whole_diff_cache.get(cwd);
  if (cached !== undefined && now - cached[1] < _WHOLE_DIFF_TTL_SECS) {
    return cached[0];
  }
  const diff = _run_git(["diff", "--no-color", "HEAD"], cwd, 1.5);
  _put_bounded(_whole_diff_cache, cwd, [diff, now]);
  return diff;
}

export function _slice_diff_for_file(whole_diff: string, path: string): string | null {
  // Extract the per-file segment for path from a full `git diff HEAD` output.
  if (!whole_diff || !path) {
    return null;
  }
  const norm_path = paths.normalizeKey(path);
  const chunks = whole_diff.split("\ndiff --git ").filter((c) => c.trim());
  const needle_a = `a/${norm_path}`;
  const needle_b = `b/${norm_path}`;
  for (let chunk of chunks) {
    const header = chunk.split("\n", 1)[0] ?? "";
    if (header.includes(needle_a) || header.includes(needle_b) || header.includes(norm_path)) {
      if (!chunk.startsWith("diff --git ")) {
        chunk = "diff --git " + chunk;
      }
      return chunk;
    }
  }
  return null;
}

export function _get_inline_diff_for_file(path: string, cwd: string): string | null {
  // Return per-file `git diff HEAD` when the diff is small enough to inline.
  if (!cwd || !path) {
    return null;
  }
  const whole = _fetch_whole_repo_diff_cached(cwd);
  if (!whole) {
    return null;
  }
  const segment = _slice_diff_for_file(whole, path);
  if (segment === null || segment.length > _INLINE_DIFF_MAX_BYTES) {
    return null;
  }
  return segment;
}

export function _get_whole_repo_diff(cwd: string): string | null {
  // Return `git diff HEAD` for the whole repo if under _SINGLE_FILE_DIFF_CAP bytes.
  if (!cwd) {
    return null;
  }
  const diff = _fetch_whole_repo_diff_cached(cwd);
  if (diff === null || diff.length > _SINGLE_FILE_DIFF_CAP) {
    return null;
  }
  return diff;
}

function _is_git_repo(cwd: string): boolean {
  // Return true when cwd is inside a git repository. Cached per cwd.
  const cached = _is_git_repo_cache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  let result: boolean;
  try {
    result = fs.existsSync(nodePath.join(cwd, ".git"));
  } catch {
    result = false;
  }
  _is_git_repo_cache.set(cwd, result);
  return result;
}

function _get_git_diff_stat(edited_paths: string[], cwd: string | null): string | null {
  // git diff --stat output for edited files, truncated to 8 lines and 200 chars.
  if (!cwd || edited_paths.length === 0) {
    return null;
  }
  const raw = _run_git(["diff", "--stat", "HEAD", "--", ...edited_paths], cwd, 2);
  if (!raw) {
    return null;
  }
  const diff_lines = raw
    .split("\n")
    .filter((line) => !line.toLowerCase().includes("file changed") && !line.toLowerCase().includes("insertion"));
  if (diff_lines.length === 0) {
    _LOG.debug("_get_git_diff_stat: no diff lines after filtering summary");
    return null;
  }
  let output = diff_lines.slice(0, 8).join("\n");
  if (output.length > 200) {
    output = _rsplitOnce(output.slice(0, 200), "\n")[0];
  }
  return output;
}

function _get_uncommitted_changes(project_root: string | null): string | null {
  // Return a compact summary of all uncommitted changes in project_root.
  // Combines `git diff --stat HEAD` with `git status --short`. Caps: 8 lines,
  // 200 chars. Never raises. Process-level cache keyed by project_root.
  if (project_root === null) {
    return null;
  }
  if (!_is_git_repo(project_root)) {
    return null;
  }
  try {
    const now = _monotonic();
    const cached = _uncommitted_changes_cache.get(project_root);
    if (cached !== undefined && now - cached[1] < _DIFF_STAT_SUMMARY_TTL) {
      return cached[0];
    }

    const _diff_out = _run_git(["diff", "--no-color", "--stat", "HEAD"], project_root, 5);
    const diff_lines: string[] = _diff_out
      ? _diff_out.split("\n").filter((line) => line.trim()).map((line) => _rstrip(line))
      : [];

    const _status_out = _run_git(["status", "--short"], project_root, 5);
    const status_lines: string[] = _status_out
      ? _status_out.split("\n").filter((line) => line.trim()).map((line) => _rstrip(line))
      : [];

    if (diff_lines.length === 0 && status_lines.length === 0) {
      _put_bounded(_uncommitted_changes_cache, project_root, [null, now]);
      return null;
    }

    const diff_filenames = new Set<string>();
    for (const dl of diff_lines) {
      const parts = dl.split("|");
      if (parts.length > 0) {
        diff_filenames.add((parts[0] ?? "").trim());
      }
    }

    const combined: string[] = [...diff_lines];
    for (const sl of status_lines) {
      const tokens = _splitN(sl, 1);
      const filename = tokens.length > 1 ? (tokens[1] ?? "").trim() : sl.trim();
      if (!diff_filenames.has(filename)) {
        combined.push(sl);
      }
    }

    if (combined.length === 0) {
      _put_bounded(_uncommitted_changes_cache, project_root, [null, now]);
      return null;
    }

    const lines = combined.slice(0, 8);
    let output = lines.join("\n");
    if (output.length > 200) {
      output = _rsplitOnce(output.slice(0, 200), "\n")[0];
    }
    const result = output.trim() ? output : null;
    _put_bounded(_uncommitted_changes_cache, project_root, [result, now]);
    return result;
  } catch {
    return null;
  }
}

export function _get_git_diff_stat_summary(root: unknown): string {
  // Run `git diff --stat HEAD` in root and return a compact summary string (keeps
  // the "N files changed" summary line). Caps: 6 lines, 300 chars. Never raises.
  if (root === null || root === undefined) {
    return "";
  }
  try {
    const root_str = typeof root === "string" ? root : String(root);
    if (!_is_git_repo(root_str)) {
      return "";
    }

    const now = _monotonic();
    const cached = _diff_stat_summary_cache.get(root_str);
    if (cached !== undefined && now - cached[1] < _DIFF_STAT_SUMMARY_TTL) {
      return cached[0];
    }

    const _stat_out = _run_git(["diff", "--no-color", "--stat", "HEAD"], root_str, 5);
    if (!_stat_out) {
      _put_bounded(_diff_stat_summary_cache, root_str, ["", now]);
      return "";
    }
    const lines = _stat_out.split("\n");
    const last6 = lines.slice(Math.max(0, lines.length - 6));
    const compressed: string[] = [];
    for (let ln of last6) {
      ln = ln.replace(/\s{2,}\|/g, " |");
      ln = ln.replace(/\|\s{2,}(\d)/g, "| $1");
      compressed.push(ln);
    }
    const output = compressed.join("\n");
    if (output.length > 300) {
      _put_bounded(_diff_stat_summary_cache, root_str, ["", now]);
      return "";
    }
    _put_bounded(_diff_stat_summary_cache, root_str, [output, now]);
    return output;
  } catch {
    return "";
  }
}

function _get_stash_count(cwd: string | null): number {
  // Return the number of entries in `git stash list`, or 0 on any failure.
  if (!cwd) {
    return 0;
  }
  const out = _run_git(["stash", "list"], cwd, 2);
  if (!out) {
    return 0;
  }
  return out.split("\n").filter((line) => line.trim()).length;
}

export function _get_session_commits(cwd: string | null, session_start_ts: number): string[] {
  // Return git log lines for commits made after session_start_ts (at most 5),
  // formatted as `{short_hash} {subject}`. Empty when git is unavailable.
  if (!cwd || session_start_ts <= 0) {
    return [];
  }
  const out = _run_git(["log", "--oneline", `--since=${Math.trunc(session_start_ts)}`, "--max-count=5"], cwd, 2);
  if (!out) {
    return [];
  }
  return out
    .split("\n")
    .slice(0, 5)
    .map((line) => sanitize_log_str(line, 100));
}

function _get_committed_files(session_cache: unknown, cwd: string | null): Set<string> {
  // Return normalized file paths committed since session start (git log
  // --name-only). Empty set on any error. Never blocks the manifest.
  try {
    if (!cwd) {
      return new Set();
    }
    const created_ts = Number(_attr(session_cache, "created_ts", 0.0) || 0.0);
    if (created_ts <= 0) {
      return new Set();
    }
    const out = _run_git(["log", "--name-only", "--format=", `--since=${Math.trunc(created_ts)}`], cwd, 2);
    if (!out) {
      return new Set();
    }
    const committed = new Set<string>();
    for (const rawLine of out.split("\n")) {
      const line = rawLine.trim();
      if (line) {
        committed.add(_norm_key(line));
      }
    }
    return committed;
  } catch {
    return new Set();
  }
}

export function _detect_orchestrator_mode(
  session_cache: unknown,
  repo_root: string | null,
  threshold = 5,
): boolean {
  // Return true when the session looks like a /improve orchestrator loop: >=
  // threshold commits since session start AND fewer than 10 edited files.
  try {
    if (!repo_root) {
      return false;
    }
    const editedAttr = _attr(session_cache, "edited_files", null);
    const edited_count = _isDict(editedAttr) ? Object.keys(editedAttr).length : 0;
    if (edited_count >= 10) {
      return false;
    }
    const created_ts = Number(_attr(session_cache, "created_ts", 0.0) || 0.0);
    if (created_ts <= 0) {
      return false;
    }
    const out = _run_git(["log", "--oneline", `--since=${Math.trunc(created_ts)}`], repo_root, 3);
    if (!out) {
      return false;
    }
    const commit_count = out.split("\n").filter((line) => line.trim()).length;
    return commit_count >= threshold;
  } catch {
    return false;
  }
}

function _get_current_branch(repo_root: string | null): string | null {
  // Return the current git branch name, or null on detached HEAD / non-repo.
  if (!repo_root) {
    return null;
  }
  const out = _run_git(["symbolic-ref", "--short", "HEAD"], repo_root, 3);
  if (!out) {
    return null;
  }
  const branch = out.trim();
  return branch ? branch : null;
}

function _get_recent_commits_for_orchestrator(repo_root: string | null, n = 10): string[] {
  // Return the last n git commits as oneline strings. Empty on any failure.
  if (!repo_root) {
    return [];
  }
  const out = _run_git(["log", "--oneline", `-${n}`], repo_root, 3);
  if (!out) {
    return [];
  }
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => sanitize_log_str(line, 100));
}

// ---------------------------------------------------------------------------
// Small string helpers mirroring Python str methods used above.
// ---------------------------------------------------------------------------

/** Python str.rstrip() (whitespace). */
function _rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/** Python s.rsplit(sep, 1) -> [head, tail]; when sep absent returns [s]. Here we
 *  only need the head element for the diff-truncation idiom `x.rsplit("\n",1)[0]`. */
function _rsplitOnce(s: string, sep: string): [string, string] {
  const idx = s.lastIndexOf(sep);
  if (idx < 0) {
    return [s, ""];
  }
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

/** Python s.split(None, n) for n=1 — split on first run of whitespace. */
function _splitN(s: string, n: number): string[] {
  if (n !== 1) {
    return s.split(/\s+/);
  }
  const trimmed = s.replace(/^\s+/, "");
  const m = /\s/.exec(trimmed);
  if (m === null) {
    return trimmed === "" ? [] : [trimmed];
  }
  const idx = m.index;
  return [trimmed.slice(0, idx), trimmed.slice(idx).replace(/^\s+/, "")];
}

// ---------------------------------------------------------------------------
// Path/line formatting helpers.
// ---------------------------------------------------------------------------

function _count_suffix(n: number): string {
  // Return '  ×N' when n > 1, or '' otherwise.
  return n > 1 ? `  ×${n}` : "";
}

export function _group_edited_by_dir(
  entries: Array<[string, number]>,
  project_root: string | null = null,
  threshold = 3,
): string[] {
  // Group edited files by directory when >= threshold files share the same
  // parent. threshold=0 disables grouping.
  if (entries.length === 0 || threshold < 0) {
    return [];
  }

  if (threshold === 0) {
    const ungrouped_result: string[] = [];
    for (const [path, count] of entries) {
      ungrouped_result.push(`- ✎ ${_short_path(path, 70, project_root)}${_count_suffix(count)}`);
    }
    return ungrouped_result;
  }

  const dir_groups = new Map<string, Array<[string, number]>>();
  // Preserve first-seen insertion order of directories (Python defaultdict does).
  for (const [path, count] of entries) {
    const dirname = _parentDir(path);
    const basename = _basename(path);
    const arr = dir_groups.get(dirname);
    if (arr === undefined) {
      dir_groups.set(dirname, [[basename, count]]);
    } else {
      arr.push([basename, count]);
    }
  }

  // sorted(dir_groups.keys(), key=lambda d: -max(count in group)).
  const dirnames = [...dir_groups.keys()].sort((a, b) => {
    const ma = Math.max(...(dir_groups.get(a) ?? []).map(([, c]) => c));
    const mb = Math.max(...(dir_groups.get(b) ?? []).map(([, c]) => c));
    return -ma - -mb;
  });

  const result: string[] = [];
  for (const dirname of dirnames) {
    const group = dir_groups.get(dirname) ?? [];

    if (group.length < threshold) {
      for (const [basename, count] of group) {
        const full_path = dirname !== "." ? _joinPosix(dirname, basename) : basename;
        result.push(`- ✎ ${_short_path(full_path, 70, project_root)}${_count_suffix(count)}`);
      }
    } else {
      const group_sorted = [...group].sort((a, b) => b[1] - a[1]);
      const file_parts = group_sorted.map(([basename, count]) => `${basename}${_count_suffix(count)}`);
      let files_str = file_parts.join(", ");

      const display_dir = dirname !== "." ? _short_path(dirname + "/", 70, project_root) : "";
      let line = `  ${display_dir} (${group.length} files):  ${files_str}`;

      if (line.length > 120) {
        files_str = file_parts.slice(0, 2).join(", ");
        const overflow = group_sorted.length - 2;
        if (overflow > 0) {
          files_str += `, +${overflow} more`;
        }
        line = `  ${display_dir} (${group.length} files):  ${files_str}`;
      }
      result.push(line);
    }
  }

  return result;
}

export function _format_duration(seconds: number): string {
  // Format a duration in seconds as a compact human-readable string.
  const secs = Math.trunc(seconds);
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m`;
  }
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function _short_path(p: string, max_len = 70, project_root: string | null = null): string {
  // Return a compact display representation of a file path. Strips leading
  // absolute-path component up to /src//tests//docs/, strips the project
  // basename when it's the first component, sanitizes embedded newlines, and
  // tail-truncates with an ellipsis when still over max_len.
  let s = sanitize_log_str(p, max_len * 2);
  s = s.replace(/\\/g, "/");
  for (const prefix of ["/src/", "/tests/", "/docs/"]) {
    const idx = s.indexOf(prefix);
    if (idx >= 0) {
      return s.slice(idx + 1);
    }
  }
  if (project_root) {
    const proj_name = _basename(project_root.replace(/[/\\]+$/, ""));
    if (proj_name) {
      const prefix_check = proj_name + "/";
      if (s.startsWith(prefix_check)) {
        s = s.slice(prefix_check.length);
      }
    }
  }
  if (s.length > max_len) {
    return "…" + s.slice(-(max_len - 1));
  }
  return s;
}

export function _extract_path_from_line(line: string): string | null {
  // Extract the path string from a manifest line if it contains one. Recognizes
  // '- ✎ ', '- → ', '- ⚠ ', '- ❄ ' markers and plain '- ' symbol lines.
  line = _rstrip(line);
  if (!line.startsWith("- ")) {
    return null;
  }
  let rest = line.slice(2);
  if (rest && "✎→⚠❄".includes(rest[0]!)) {
    rest = rest.slice(1).replace(/^\s+/, "");
  }
  if (!rest) {
    return null;
  }
  const parts = rest.split(/\s+/).filter((x) => x !== "");
  if (parts.length === 0) {
    return null;
  }
  const path = parts[0]!;
  if (path.startsWith("`")) {
    return null;
  }
  return path;
}

export function _find_common_prefix(pathList: string[]): string | null {
  // Find the longest common directory prefix (ending at a '/' boundary) shared
  // by all paths. Returns null when no common directory prefix exists.
  if (pathList.length === 0) {
    return null;
  }
  if (pathList.length === 1) {
    const p = pathList[0]!;
    if (p.includes("/")) {
      const idx = p.lastIndexOf("/");
      return p.slice(0, idx + 1);
    }
    return null;
  }

  let common = pathList[0]!;
  for (const p of pathList.slice(1)) {
    while (common && !p.startsWith(common)) {
      common = common.slice(0, -1);
    }
  }

  if (!common) {
    return null;
  }
  if (!common.includes("/")) {
    return null;
  }
  const slash_idx = common.lastIndexOf("/");
  return common.slice(0, slash_idx + 1);
}

function _strip_common_prefix_lines(lines: string[], common_prefix: string): string[] {
  // Strip common_prefix from path-bearing lines, leaving non-path lines intact.
  if (!common_prefix) {
    return [...lines];
  }
  const out: string[] = [];
  for (const line of lines) {
    const path = _extract_path_from_line(line);
    if (path && path.startsWith(common_prefix) && line.startsWith("- ")) {
      let rest = line.slice(2);
      let marker = "";
      if (rest && "✎→⚠❄".includes(rest[0]!)) {
        marker = rest[0]!;
        rest = rest.slice(1).replace(/^\s+/, "");
      } else {
        rest = rest.replace(/^\s+/, "");
      }
      const parts = _splitN(rest, 1);
      const new_path = path.slice(common_prefix.length);
      const tail = parts.length > 1 ? ` ${parts[1]}` : "";
      if (marker) {
        out.push(`- ${marker} ${new_path}${tail}`);
      } else {
        out.push(`- ${new_path}${tail}`);
      }
    } else {
      out.push(line);
    }
  }
  return out;
}

export function _strip_common_prefix_from_sections(sections: string[], common_prefix: string): string[] {
  // Rewrite sections list to strip common_prefix from all path-bearing lines,
  // inserting a "(paths relative to ...)" header after the Session line.
  if (!common_prefix) {
    return sections;
  }

  let result: string[] = [];
  let session_line_idx = -1;

  for (let i = 0; i < sections.length; i++) {
    const line = sections[i]!;
    result.push(line);
    if (line.startsWith("Session: ")) {
      session_line_idx = i;
      break;
    }
  }

  if (session_line_idx >= 0) {
    result.splice(session_line_idx + 1, 0, `(paths relative to ${common_prefix})`);
    result = result.concat(_strip_common_prefix_lines(sections.slice(session_line_idx + 1), common_prefix));
  } else {
    result = _strip_common_prefix_lines(sections, common_prefix);
  }

  return result;
}

export function _format_ranges(ranges: Array<[number, number]>): string {
  // Render merged line ranges compactly. Single-line ranges (start == end) are
  // formatted without a dash. Whole-file sentinel -> "  (full)". Ranges beyond
  // _MAX_RANGES_PER_FILE are summarised as "+N more". Skips malformed entries.
  if (!ranges || ranges.length === 0) {
    return "";
  }
  const valid: Array<[number, number]> = [];
  let had_sentinel = false;
  for (const entry of ranges) {
    try {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw new TypeError("bad range");
      }
      const start = Math.trunc(Number(entry[0]));
      const end = Math.trunc(Number(entry[1]));
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new TypeError("bad range");
      }
      if (end - start >= _FULL_READ_SENTINEL_GAP) {
        had_sentinel = true;
      } else {
        valid.push([start, end]);
      }
    } catch {
      _LOG.debug("_format_ranges: skipping malformed range entry");
    }
  }
  if (had_sentinel) {
    return "  (full)";
  }
  if (valid.length === 0) {
    return "";
  }
  const total_ranges = valid.length;
  const shown = valid.slice(0, _MAX_RANGES_PER_FILE);
  const parts = shown.map(([start, end]) => (start === end ? String(start) : `${start}-${end}`)).join(", ");
  const hidden_count = total_ranges - _MAX_RANGES_PER_FILE;
  const overflow_suffix = hidden_count > 0 ? ` +${hidden_count} more` : "";
  return `  L:${parts}${overflow_suffix}`;
}

// ---------------------------------------------------------------------------
// Bash classification + recency-ranked selectors.
// ---------------------------------------------------------------------------

const _MAX_BLOCKER_ENTRIES = 3;
const _BLOCKER_STALE_SECS = 3600; // 60 minutes

function _is_noop_bash_command(entry: unknown): boolean {
  // Check if a bash entry is a no-op command (status check, pwd, cd, etc).
  const cmd_preview = _strAttr(entry, "cmd_preview").trim();
  if (!cmd_preview) {
    return false;
  }
  if (cmd_preview.length < 5) {
    return true;
  }
  const words = cmd_preview.split(/\s+/).filter((x) => x !== "");
  const first_word = words.length > 0 ? words[0]! : "";
  const first_word_lower = first_word.toLowerCase();

  const noop_patterns = new Set([
    "git status",
    "git diff --stat",
    "git log --oneline",
    "ls",
    "pwd",
    "cd",
    "echo",
    "cat",
    "head",
    "tail",
  ]);

  if (noop_patterns.has(cmd_preview.toLowerCase())) {
    return true;
  }

  const cmd_lower = cmd_preview.toLowerCase();
  for (const pattern of ["git status", "git diff --stat", "git log"]) {
    if (cmd_lower.startsWith(pattern)) {
      return true;
    }
  }

  if (first_word_lower === "cd" || first_word_lower === "echo") {
    return true;
  }

  if (first_word_lower === "cat" || first_word_lower === "head" || first_word_lower === "tail") {
    const total_bytes = _numAttr(entry, "stdout_bytes", 0) + _numAttr(entry, "stderr_bytes", 0);
    if (total_bytes < 200) {
      return true;
    }
  }

  return false;
}

function _select_failed_bash_entries(bash_history: unknown, now_ts: number): unknown[] {
  // Return up to _MAX_BLOCKER_ENTRIES recently-failed bash commands (exit_code a
  // real int != 0, within the last _BLOCKER_STALE_SECS), most-recent-first.
  if (!_isDict(bash_history) || Object.keys(bash_history).length === 0) {
    return [];
  }
  const cutoff = now_ts - _BLOCKER_STALE_SECS;
  const candidates = Object.values(bash_history).filter((e) => {
    const ec = _attr(e, "exit_code", null);
    return typeof ec === "number" && Number.isInteger(ec) && ec !== 0 && _numAttr(e, "ts", 0.0) >= cutoff;
  });
  if (candidates.length === 0) {
    return [];
  }
  return _nlargest(_MAX_BLOCKER_ENTRIES, candidates, (e) => _numAttr(e, "ts", 0.0));
}

export function _session_activity_score(cache: SessionCache): number {
  // Weighted activity score: edited*2 + bash + web + skill + blockers*5.
  const edited_count = _isDict(cache.edited_files) ? Object.keys(cache.edited_files).length : 0;
  const bashHist = _attr(cache, "bash_history", null);
  const bash_count = _isDict(bashHist) ? Object.keys(bashHist).length : 0;
  const webHist = _attr(cache, "web_history", null);
  const web_count = _isDict(webHist) ? Object.keys(webHist).length : 0;
  const skillHist = _attr(cache, "skill_history", null);
  const skill_count = _isDict(skillHist) ? Object.keys(skillHist).length : 0;

  const now_ts = _now();
  const blocker_count = _select_failed_bash_entries(_isDict(bashHist) ? bashHist : {}, now_ts).length;

  return edited_count * 2 + bash_count * 1 + web_count * 1 + skill_count * 1 + blocker_count * 5;
}

// ---------------------------------------------------------------------------
// Manifest quality score.
// ---------------------------------------------------------------------------

export const _MANIFEST_THIN_THRESHOLD = 5;

export function _score_manifest(sections: string[]): number {
  // Assign a quality score: +10 per edited-file line, +5 per test-failure line
  // (✗), +3 per bash line, +2 per symbol line. Operates on rendered sections.
  let score = 0;
  for (const section of sections) {
    let in_edited = false;
    let in_bash = false;
    let in_symbols = false;
    for (const line of section.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("**Edited**")) {
        in_edited = true;
        in_bash = false;
        in_symbols = false;
        continue;
      }
      if (stripped.startsWith("**Bash**")) {
        in_edited = false;
        in_bash = true;
        in_symbols = false;
        continue;
      }
      if (stripped.startsWith("**Symbols**")) {
        in_edited = false;
        in_bash = false;
        in_symbols = true;
        continue;
      }
      if (stripped.startsWith("**") && stripped.endsWith("**:")) {
        in_edited = false;
        in_bash = false;
        in_symbols = false;
        continue;
      }
      if (!stripped.startsWith("- ")) {
        continue;
      }
      if (in_edited) {
        score += 10;
      } else if (in_bash) {
        score += 3;
      } else if (in_symbols) {
        score += 2;
      }
      if (stripped.includes("✗")) {
        score += 5;
      }
    }
  }
  return score;
}

export function _score_manifest_breakdown(sections: string[]): Record<string, number> {
  // Return per-section score contributions for `compact-hint --score`.
  const result: Record<string, number> = {};
  let current_section = "(header)";
  for (const section of sections) {
    let in_edited = false;
    let in_bash = false;
    let in_symbols = false;
    for (const line of section.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("**Edited**")) {
        in_edited = true;
        in_bash = false;
        in_symbols = false;
        current_section = "**Edited**";
        continue;
      }
      if (stripped.startsWith("**Bash**")) {
        in_edited = false;
        in_bash = true;
        in_symbols = false;
        current_section = "**Bash**";
        continue;
      }
      if (stripped.startsWith("**Symbols**")) {
        in_edited = false;
        in_bash = false;
        in_symbols = true;
        current_section = "**Symbols**";
        continue;
      }
      if (stripped.startsWith("**") && stripped.endsWith("**:")) {
        in_edited = false;
        in_bash = false;
        in_symbols = false;
        current_section = stripped.replace(/:+$/, "");
        continue;
      }
      if (!stripped.startsWith("- ")) {
        continue;
      }
      let pts = 0;
      if (in_edited) {
        pts += 10;
      } else if (in_bash) {
        pts += 3;
      } else if (in_symbols) {
        pts += 2;
      }
      if (stripped.includes("✗")) {
        pts += 5;
      }
      if (pts > 0) {
        result[current_section] = (result[current_section] ?? 0) + pts;
      }
    }
  }
  return result;
}

export function _parse_manifest_sections(manifest: string): Array<[string, number, boolean]> {
  // Return a list of [section_name, token_count, is_empty] tuples.
  if (!manifest) {
    return [];
  }

  const sections: Array<[string, number, boolean]> = [];
  let current_name = "(header)";
  let current_lines: string[] = [];

  const _flush = (name: string, lines: string[]): void => {
    const text = lines.join("\n");
    const tokens = estimate_tokens(text);
    const non_blank = lines.filter((ln) => ln.trim());
    const empty = non_blank.length === 0;
    sections.push([name, tokens, empty]);
  };

  for (const line of manifest.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("### ")) {
      _flush(current_name, current_lines);
      current_name = stripped.slice(4);
      current_lines = [];
    } else if (stripped.startsWith("**") && (stripped.includes("**:") || stripped.endsWith("**"))) {
      _flush(current_name, current_lines);
      current_name = stripped.replace(/^\*+|\*+$/g, "").replace(/:+$/, "");
      current_lines = [];
    } else {
      current_lines.push(line);
    }
  }

  _flush(current_name, current_lines);
  return sections;
}

export function find_latest_session_id(): string | null {
  // Return the session_id of the most-recently-modified session file under
  // sessions/, or null when none exist.
  try {
    const sessions_dir = paths.sessionsDir();
    let isDir = false;
    try {
      isDir = fs.statSync(sessions_dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return null;
    }
    const candidates = fs.readdirSync(sessions_dir).filter((f) => f.endsWith(".json"));
    if (candidates.length === 0) {
      return null;
    }
    let latest = candidates[0]!;
    let latestMtime = -Infinity;
    for (const c of candidates) {
      let mtime = 0;
      try {
        mtime = fs.statSync(nodePath.join(sessions_dir, c)).mtimeMs;
      } catch {
        mtime = 0;
      }
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = c;
      }
    }
    // .stem — strip the .json extension.
    return latest.replace(/\.json$/, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Blocker preview + formatting.
// ---------------------------------------------------------------------------

const _BLOCKER_PREVIEW_CACHE_MAX = 32;

export function _extract_blocker_error_preview(entry: unknown, opts: { max_chars?: number } = {}): string {
  // Return a short error line extracted from a blocker's cached bash output.
  // Lines containing error/failed/traceback/fatal/exception win first; else the
  // last non-blank line. Empty string on any failure. Cached per output_id.
  const max_chars = opts.max_chars ?? 70;
  const output_id = _strAttr(entry, "output_id") || "";
  if (!output_id) {
    return "";
  }
  const cached = _blocker_preview_cache.get(output_id);
  if (cached !== undefined) {
    return cached;
  }
  let raw_output: string | null;
  try {
    const bash_cache = _getBashCache();
    raw_output = bash_cache ? bash_cache.load_output(output_id) : null;
  } catch {
    _blocker_preview_cache.set(output_id, "");
    return "";
  }
  if (!raw_output) {
    _blocker_preview_cache.set(output_id, "");
    return "";
  }

  const lines = raw_output.split("\n");
  const head = lines.slice(0, 200);
  const tail = lines.length > 220 ? lines.slice(-20) : [];
  const error_tokens = ["error", "failed", "traceback", "fatal", "exception", "✗"];
  let picked = "";
  for (const line of head.concat(tail)) {
    const stripped = line.trim();
    if (!stripped) {
      continue;
    }
    const low = stripped.toLowerCase();
    if (error_tokens.some((tok) => low.includes(tok))) {
      picked = stripped;
      break;
    }
  }
  if (!picked) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const stripped = lines[i]!.trim();
      if (stripped) {
        picked = stripped;
        break;
      }
    }
  }

  picked = sanitize_log_str(picked, max_chars);
  if (_blocker_preview_cache.size >= _BLOCKER_PREVIEW_CACHE_MAX) {
    const oldest = _blocker_preview_cache.keys().next();
    if (!oldest.done) {
      _blocker_preview_cache.delete(oldest.value);
    }
  }
  _blocker_preview_cache.set(output_id, picked);
  return picked;
}

export function _format_blocker_entry(entry: unknown): string {
  // Render one failed BashEntry as a "Current Blockers" line, with an optional
  // "— <error preview>" clause from the cached output.
  const cmd_preview = sanitize_log_str(_strAttr(entry, "cmd_preview"), 80);
  const exit_code = _attr(entry, "exit_code", "?");
  const error_preview = _extract_blocker_error_preview(entry, { max_chars: 70 });
  if (error_preview) {
    return `- ✗ ${cmd_preview}  (exit ${exit_code}) — ${error_preview}`;
  }
  return `- ✗ ${cmd_preview}  (exit ${exit_code})`;
}

function _select_top_entries(
  history: unknown,
  min_bytes: number,
  size_fn: (e: unknown) => number,
  max_n: number,
  exclude_fn: ((e: unknown) => boolean) | null = null,
): unknown[] {
  // Recency-ranked selector shared by bash and web history dicts.
  if (!_isDict(history) || Object.keys(history).length === 0) {
    return [];
  }
  const candidates = Object.values(history).filter(
    (e) => size_fn(e) >= min_bytes && (exclude_fn === null || !exclude_fn(e)),
  );
  if (candidates.length === 0) {
    return [];
  }
  return _nlargest(max_n, candidates, (e) => _numAttr(e, "ts", 0.0));
}

export function _rank_symbols_by_recency(entry: FileEntry, now: number): string[] {
  // Return symbols from entry ranked by recency (most recent first). Symbols
  // without timestamps (legacy) fall back to original order / 1.0× multiplier.
  const symbols_ts = _attr(entry, "symbols_ts", null);
  if (!symbols_ts || !_isDict(symbols_ts)) {
    return entry.symbols_read;
  }

  const scored_symbols: Array<[string, number, number]> = [];
  for (const symbol of entry.symbols_read) {
    const ts = Number((symbols_ts as Record<string, unknown>)[symbol] ?? 0.0);
    const age_seconds = Math.max(0.0, now - ts);
    let multiplier: number;
    if (age_seconds < 300) {
      multiplier = 1.5;
    } else if (age_seconds < 1800) {
      multiplier = 1.2;
    } else {
      multiplier = 1.0;
    }
    scored_symbols.push([symbol, multiplier, ts]);
  }

  // Sort by tier desc, then raw timestamp desc.
  scored_symbols.sort((a, b) => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    return b[2] - a[2];
  });
  return scored_symbols.map((item) => item[0]);
}

function _collapse_class_methods(symbols: string[]): string[] {
  // Collapse 3+ methods of the same class to "ClassName.* (N methods)".
  if (symbols.length === 0) {
    return [];
  }

  const class_methods = new Map<string, string[]>();
  const non_methods: string[] = [];

  for (const symbol of symbols) {
    if (symbol.includes(".")) {
      const idx = symbol.lastIndexOf(".");
      const class_name = symbol.slice(0, idx);
      const method = symbol.slice(idx + 1);
      // Treat as method only if class name starts with an uppercase letter
      // (Python str[0].isupper() — true only for cased uppercase chars).
      const c0 = class_name[0];
      if (class_name && c0 !== undefined && /\p{Lu}/u.test(c0)) {
        const arr = class_methods.get(class_name);
        if (arr === undefined) {
          class_methods.set(class_name, [method]);
        } else {
          arr.push(method);
        }
      } else {
        non_methods.push(symbol);
      }
    } else {
      non_methods.push(symbol);
    }
  }

  const result: string[] = [];
  for (const class_name of [...class_methods.keys()].sort()) {
    const methods = class_methods.get(class_name) ?? [];
    if (methods.length >= 3) {
      result.push(`${class_name}.* (${methods.length} methods)`);
    } else {
      for (const method of methods) {
        result.push(`${class_name}.${method}`);
      }
    }
  }

  result.push(...non_methods);
  return result;
}

function _dedup_symbols_across_files(entries: FileEntry[], now: number): Map<string, [string, number]> {
  // Deduplicate symbols across multiple files, keeping only the most-recent
  // reference. Returns a map symbol -> [file_path, access_timestamp].
  const symbol_map = new Map<string, [string, number]>();

  for (const entry of entries) {
    const sr = _attr(entry, "symbols_read", null);
    if (!Array.isArray(sr) || sr.length === 0) {
      continue;
    }
    const ranked = _rank_symbols_by_recency(entry, now);
    const symbols_ts = (_attr(entry, "symbols_ts", null) as Record<string, unknown> | null) ?? {};
    for (const symbol of ranked) {
      const ts = Number(_isDict(symbols_ts) ? (symbols_ts[symbol] ?? 0.0) : 0.0);
      const rel_or_abs = _strAttr(entry, "rel_or_abs");
      const existing = symbol_map.get(symbol);
      if (existing === undefined || ts > existing[1]) {
        symbol_map.set(symbol, [rel_or_abs, ts]);
      }
    }
  }

  return symbol_map;
}

function _adaptive_bash_max(bash_history: unknown): number {
  // Effective Bash entry cap based on session size:
  //   min(_MAX_BASH_ENTRIES, max(2, len(bash_history) // 5)).
  const n = _isDict(bash_history) ? Object.keys(bash_history).length : 0;
  return Math.min(_MAX_BASH_ENTRIES, Math.max(2, Math.floor(n / 5)));
}

function _select_top_bash_entries(bash_history: unknown): unknown[] {
  // Pick up to an adaptive cap of cached Bash runs worth surfacing.
  const effective_max = _adaptive_bash_max(bash_history);
  return _select_top_entries(
    bash_history,
    _MIN_BASH_BYTES_FOR_MANIFEST,
    (e) => _numAttr(e, "stdout_bytes", 0) + _numAttr(e, "stderr_bytes", 0),
    effective_max,
    _is_noop_bash_command,
  );
}

// Prefixes that identify test-runner commands eligible for the "What Worked" section.
const _TEST_COMMAND_PREFIXES: readonly string[] = [
  "pytest",
  "uv run pytest",
  "python -m pytest",
  "npm test",
  "npm run test",
  "yarn test",
  "cargo test",
  "go test",
  "mocha",
  "jest",
  "make test",
  "make check",
];

function _is_test_command(entry: unknown): boolean {
  // Return true when entry's cmd_preview looks like a test-runner invocation.
  const cmd = _strAttr(entry, "cmd_preview").trim().toLowerCase();
  if (!cmd) {
    return false;
  }
  return _TEST_COMMAND_PREFIXES.some((prefix) => cmd.startsWith(prefix));
}

export function _select_what_worked(bash_history: unknown, blocker_ids: Set<unknown>): unknown[] {
  // Return at most 2 most-recent green (exit 0) test runs, most-recent-first.
  if (!_isDict(bash_history) || Object.keys(bash_history).length === 0) {
    return [];
  }
  const candidates = Object.values(bash_history).filter(
    (e) => _attr(e, "exit_code", null) === 0 && _is_test_command(e) && !blocker_ids.has(_attr(e, "output_id", null)),
  );
  if (candidates.length === 0) {
    return [];
  }
  return _nlargest(2, candidates, (e) => _numAttr(e, "ts", 0.0));
}

function _render_active_errors_section(session_id: string, max_errors = 3): string[] {
  // Render recent error outputs from bash cache as an "Active Errors" section.
  // Fail-soft: empty list when none found or the cache module is unavailable.
  if (!session_id) {
    return [];
  }

  let error_outputs: Array<Record<string, unknown>>;
  try {
    const bash_cache = _getBashCache();
    error_outputs = bash_cache ? bash_cache.get_recent_error_outputs(session_id, { max_entries: max_errors }) : [];
  } catch {
    return [];
  }

  if (!error_outputs || error_outputs.length === 0) {
    return [];
  }

  const lines: string[] = ["### Active Errors"];
  for (const error_entry of error_outputs.slice(0, max_errors)) {
    const cmd = sanitize_log_str(String(error_entry["command"] ?? ""), 80);
    const summary = sanitize_log_str(String(error_entry["error_summary"] ?? ""), 100);
    if (cmd && summary) {
      lines.push(`- \`${cmd}\` — ${summary}`);
    } else if (cmd) {
      lines.push(`- \`${cmd}\``);
    }
  }

  return lines.length > 1 ? lines : [];
}

export function _render_what_worked_section(entries: unknown[], now_ts: number): string[] {
  // Render a **Passed:** section listing at most 2 recent green test runs.
  if (entries.length === 0) {
    return [];
  }

  const _format_entry = (entry: unknown): string => {
    const raw_cmd = sanitize_log_str(_strAttr(entry, "cmd_preview"), 200);
    const cmd = raw_cmd.length > 60 ? raw_cmd.slice(0, 57) + "..." : raw_cmd;
    const ts = _numAttr(entry, "ts", now_ts);
    const age_min = Math.max(0, Math.trunc((now_ts - ts) / 60));
    return `\`${cmd}\` (${age_min}m)`;
  };

  if (entries.length <= 2) {
    const joined = entries.map((e) => _format_entry(e)).join(", ");
    return [`**Passed:** ${joined}`];
  }

  const lines: string[] = ["**Passed:**"];
  for (const entry of entries) {
    const raw_cmd = sanitize_log_str(_strAttr(entry, "cmd_preview"), 200);
    const cmd = raw_cmd.length > 60 ? raw_cmd.slice(0, 57) + "..." : raw_cmd;
    const ts = _numAttr(entry, "ts", now_ts);
    const age_min = Math.max(0, Math.trunc((now_ts - ts) / 60));
    const oid = _short_id(sanitize_log_str(_strAttr(entry, "output_id"), 64));
    lines.push(`- ✅ \`${cmd}\` (${age_min} min ago) \`${oid}\``);
  }
  return lines;
}

export function _extract_test_failures(bash_history: unknown): string[] {
  // Scan bash_history for pytest runs and extract FAILED test names, deduplicated,
  // newest-run first, capped at _MAX_TEST_FAILURES. Fail-soft (empty on error).
  if (!_isDict(bash_history) || Object.keys(bash_history).length === 0) {
    return [];
  }

  const test_entries = Object.values(bash_history)
    .filter((e) => _is_test_command(e))
    .sort((a, b) => _numAttr(b, "ts", 0.0) - _numAttr(a, "ts", 0.0));
  if (test_entries.length === 0) {
    return [];
  }

  const bash_cache = _getBashCache();
  if (bash_cache === null) {
    return [];
  }

  const seen = new Set<string>();
  const failures: string[] = [];

  for (const entry of test_entries) {
    if (failures.length >= _MAX_TEST_FAILURES) {
      break;
    }
    const output_id = _strAttr(entry, "output_id") || "";
    if (!output_id) {
      continue;
    }
    let raw: string | null;
    try {
      raw = bash_cache.load_output(output_id);
    } catch {
      continue;
    }
    if (!raw) {
      continue;
    }
    for (const line of raw.split("\n")) {
      const m = _PYTEST_FAILED_RE.exec(line);
      if (m && m[1]) {
        const name = sanitize_log_str(m[1], 120);
        if (name && !seen.has(name)) {
          seen.add(name);
          failures.push(name);
          if (failures.length >= _MAX_TEST_FAILURES) {
            break;
          }
        }
      }
    }
  }

  return failures;
}

// Package manager command prefixes that indicate a dependency change.
const _DEP_COMMAND_PREFIXES: readonly string[] = [
  "pip install",
  "pip3 install",
  "uv add",
  "uv pip install",
  "npm install",
  "npm i ",
  "yarn add",
  "yarn install",
  "pnpm add",
  "pnpm install",
  "cargo add",
  "poetry add",
  "gem install",
];

function _is_dep_command(entry: unknown): boolean {
  // Return true when entry's cmd_preview looks like a package-install command.
  const cmd = _strAttr(entry, "cmd_preview").trim().toLowerCase();
  return _DEP_COMMAND_PREFIXES.some((prefix) => cmd.startsWith(prefix));
}

export function _extract_dep_changes(bash_history: unknown): string[] {
  // Scan bash_history for package-manager runs and extract dependency change
  // lines, capped at _MAX_DEP_CHANGES. Fail-soft (empty on error).
  if (!_isDict(bash_history) || Object.keys(bash_history).length === 0) {
    return [];
  }

  const dep_entries = Object.values(bash_history)
    .filter((e) => _is_dep_command(e))
    .sort((a, b) => _numAttr(b, "ts", 0.0) - _numAttr(a, "ts", 0.0));
  if (dep_entries.length === 0) {
    return [];
  }

  const bash_cache = _getBashCache();
  if (bash_cache === null) {
    return [];
  }

  const seen = new Set<string>();
  const changes: string[] = [];

  for (const entry of dep_entries.slice(0, 3)) {
    if (changes.length >= _MAX_DEP_CHANGES) {
      break;
    }
    const output_id = _strAttr(entry, "output_id") || "";
    if (!output_id) {
      continue;
    }
    let raw: string | null;
    try {
      raw = bash_cache.load_output(output_id);
    } catch {
      continue;
    }
    if (!raw) {
      continue;
    }
    for (const line of raw.split("\n")) {
      const stripped = line.trim();
      if (!stripped) {
        continue;
      }
      for (const pat of _DEP_CHANGE_PATTERNS) {
        // Each pattern is reused across lines; reset lastIndex for safety with
        // the "m"-flagged ones (test() advances lastIndex only for /g).
        if (pat.test(stripped)) {
          const clean = sanitize_log_str(stripped, 100);
          if (clean && !seen.has(clean)) {
            seen.add(clean);
            changes.push(clean);
            if (changes.length >= _MAX_DEP_CHANGES) {
              break;
            }
          }
        }
      }
      if (changes.length >= _MAX_DEP_CHANGES) {
        break;
      }
    }
  }

  return changes;
}

export function _format_session_stats(cache: unknown): string | null {
  // Return a compact 1-line session stats summary: "Stats: 3 edited  12 bash  7
  // suppressed". Null when all three values are zero.
  const editedAttr = _attr(cache, "edited_files", null);
  const edited_count = _isDict(editedAttr) ? Object.keys(editedAttr).length : 0;
  const bashAttr = _attr(cache, "bash_history", null);
  const bash_count = _isDict(bashAttr) ? Object.keys(bashAttr).length : 0;
  const _sup_raw = _attr(cache, "hints_suppressed_by_type", null);
  const suppressed = _isDict(_sup_raw) ? Object.values(_sup_raw).reduce((s: number, v) => s + Number(v ?? 0), 0) : 0;

  if (edited_count === 0 && bash_count === 0 && suppressed === 0) {
    return null;
  }

  const parts: string[] = [];
  if (edited_count) {
    parts.push(`${edited_count} edited`);
  }
  if (bash_count) {
    parts.push(`${bash_count} bash`);
  }
  if (suppressed) {
    parts.push(`${suppressed} suppressed`);
  }

  return parts.length > 0 ? "Stats: " + parts.join("  ") : null;
}

export function _middle_truncate(text: string, max_lines = 20): string {
  // Return text middle-truncated to at most max_lines lines, keeping the first
  // ceil(max_lines*0.4) and last ceil(max_lines*0.4) with an omission marker.
  if (max_lines < 2) {
    max_lines = 2;
  }
  const lines = text.split("\n");
  if (lines.length <= max_lines) {
    return text;
  }
  const keep = Math.ceil(max_lines * 0.4);
  const head = lines.slice(0, keep);
  const tail = lines.slice(-keep);
  const omitted = lines.length - keep * 2;
  const marker = `... [${omitted} lines omitted] ...`;
  return head.concat([marker], tail).join("\n");
}

function _render_cache_meta(
  status: string,
  body_bytes: number,
  opts: { truncated?: boolean; output_id?: string } = {},
): string {
  // Build the parenthesised metadata suffix shared by bash and web manifest lines.
  const truncated = opts.truncated ?? false;
  const output_id = opts.output_id ?? "";
  const truncated_marker = truncated ? " (truncated)" : "";
  const bytes_str = _humanize_bytes(body_bytes);
  const id_part = output_id ? `, id=${_short_id(output_id)}` : "";
  return `(${status}, ${bytes_str}${truncated_marker}${id_part})`;
}

export function _format_bash_entry(entry: unknown, inline_snippet = true, opts: { is_blocker?: boolean } = {}): string {
  // Render one BashEntry as a single manifest line, optionally with a
  // middle-truncated inline output snippet.
  const is_blocker = opts.is_blocker ?? false;
  const bash_cache = _getBashCache();

  const cmd_preview = sanitize_log_str(_strAttr(entry, "cmd_preview"), 80);
  const total = Math.trunc(_numAttr(entry, "stdout_bytes", 0)) + Math.trunc(_numAttr(entry, "stderr_bytes", 0));
  const exit_code = _attr(entry, "exit_code", null);
  const output_id = _strAttr(entry, "output_id");
  const run_count = Math.trunc(_numAttr(entry, "run_count", 1));
  const run_count_marker = run_count > 1 ? ` [×${run_count}]` : "";
  const exit_str = exit_code === null || exit_code === undefined ? "e=?" : `e=${exit_code}`;
  const truncated = Boolean(_attr(entry, "truncated", false));
  let meta: string;
  if (!truncated && total < 1024) {
    meta = `(${exit_str})`;
  } else {
    meta = _render_cache_meta(exit_str, total, { truncated });
  }
  const header = `- $ ${cmd_preview}${run_count_marker}  ${meta}`;

  if (!inline_snippet) {
    return header;
  }

  let snippet: string | null = null;
  if (output_id && bash_cache) {
    try {
      const raw = bash_cache.load_output(output_id);
      if (raw && raw.trim()) {
        const snippet_max_lines = is_blocker ? 20 : 12;
        snippet = _middle_truncate(raw.trim(), snippet_max_lines);
      }
    } catch {
      // swallow
    }
  }

  if (snippet) {
    const indented = snippet
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return `${header}\n${indented}`;
  }
  return header;
}

export function _select_top_web_entries(web_history: unknown): unknown[] {
  // Pick up to _MAX_WEB_ENTRIES web fetches, filtering 4xx/5xx dead-ends.
  const is_dead_end = (entry: unknown): boolean => {
    const status_code = _attr(entry, "status_code", null);
    return typeof status_code === "number" && status_code >= 400;
  };

  return _select_top_entries(
    web_history,
    _MIN_WEB_BYTES_FOR_MANIFEST,
    (e) => _numAttr(e, "body_bytes", 0),
    _MAX_WEB_ENTRIES,
    is_dead_end,
  );
}

function _format_web_entry(entry: unknown): string {
  // Render one WebEntry as a single manifest line with status + cache id.
  const url_preview = sanitize_log_str(_strAttr(entry, "url_preview"), 100);
  const body_bytes = Math.trunc(_numAttr(entry, "body_bytes", 0));
  const status_code = _attr(entry, "status_code", null);
  const output_id = sanitize_log_str(_strAttr(entry, "output_id"), 24);
  const status_str = status_code !== null && status_code !== undefined ? String(status_code) : "?";
  const meta = _render_cache_meta(status_str, body_bytes, {
    truncated: Boolean(_attr(entry, "truncated", false)),
    output_id,
  });
  return `- 🌐 ${url_preview}  ${meta}`;
}

function _group_web_entries_by_domain(entries: unknown[]): string[] {
  // Group web entries by domain to save tokens. Single URLs show the full path.
  if (entries.length === 0) {
    return [];
  }

  const domain_groups = new Map<string, unknown[]>();
  for (const entry of entries) {
    const url_preview = _strAttr(entry, "url_preview");
    if (!url_preview) {
      continue;
    }
    let netloc: string;
    try {
      netloc = _urlparseNetloc(url_preview) || "unknown";
    } catch {
      netloc = "unknown";
    }
    const arr = domain_groups.get(netloc);
    if (arr === undefined) {
      domain_groups.set(netloc, [entry]);
    } else {
      arr.push(entry);
    }
  }

  const result: string[] = [];
  for (const netloc of [...domain_groups.keys()].sort()) {
    const group = domain_groups.get(netloc) ?? [];
    if (group.length === 1) {
      result.push(_format_web_entry(group[0]));
    } else {
      const pathParts: string[] = [];
      for (const entry of group) {
        const url_preview = _strAttr(entry, "url_preview");
        try {
          pathParts.push(_urlparsePathQuery(url_preview));
        } catch {
          pathParts.push("?");
        }
      }
      let path_str = pathParts.join(", ");
      if (path_str.length > 80) {
        path_str = path_str.slice(0, 77) + "...";
      }
      result.push(`- 🌐 ${netloc} (${group.length}): ${path_str}`);
    }
  }

  return result;
}

const _SKILL_STALE_THRESHOLD_SECS = 30 * 60;
const _SKILL_STALE_FOR_SESSION_SECS = 6 * 3600; // 6 hours
const _MAX_ACTIVE_SKILLS = 6;

export function _select_top_skill_entries(skill_history: unknown, opts: { session_started_ts?: number } = {}): unknown[] {
  // Pick up to _MAX_ACTIVE_SKILLS skill loads worth surfacing, newest-first.
  // Skills loaded within the current session window are always included.
  const session_started_ts = opts.session_started_ts ?? 0.0;
  if (!_isDict(skill_history) || Object.keys(skill_history).length === 0) {
    return [];
  }

  const now = _now();
  let cutoff_ts: number;
  if (session_started_ts > 0.0) {
    cutoff_ts = session_started_ts - 60.0;
  } else {
    cutoff_ts = now - _SKILL_STALE_THRESHOLD_SECS;
  }

  const recent_skills = Object.values(skill_history).filter((entry) => _numAttr(entry, "ts", 0.0) >= cutoff_ts);

  // Deduplicate by skill name: keep only the most-recent content_sha per skill.
  const deduped = new Map<string, unknown>();
  for (const entry of recent_skills) {
    const skill_name = _strAttr(entry, "skill_name");
    const ts = _numAttr(entry, "ts", 0.0);
    const existing = deduped.get(skill_name);
    if (existing === undefined || ts > _numAttr(existing, "ts", 0.0)) {
      deduped.set(skill_name, entry);
    }
  }

  const _RECENCY_BOOST_PER_LOAD_SECS = 60.0;
  const _skill_rank = (e: unknown): number => {
    const ts = _numAttr(e, "ts", 0.0);
    const rc = Math.max(1, Math.trunc(_numAttr(e, "run_count", 1)));
    return ts + (rc - 1) * _RECENCY_BOOST_PER_LOAD_SECS;
  };

  return _nlargest(_MAX_ACTIVE_SKILLS, [...deduped.values()], _skill_rank);
}

export function _format_skill_entry(entry: unknown): string {
  // Render one SkillEntry as a single manifest line with run-count, size, stale,
  // and truncation annotations plus a recall hint.
  const name = sanitize_log_str(_strAttr(entry, "skill_name"), 80);
  const body_bytes = Math.trunc(_numAttr(entry, "body_bytes", 0));
  const run_count = Math.trunc(_numAttr(entry, "run_count", 1));
  const truncated = Boolean(_attr(entry, "truncated", false));
  const ts = _numAttr(entry, "ts", _now());

  const count_str = run_count > 1 ? `  ×${run_count}` : "";
  const size_str = _humanize_bytes(body_bytes);
  const trunc_marker = truncated ? "*" : "";

  const now = _now();
  const age_secs = now - ts;
  let stale_str = "";
  if (age_secs > _SKILL_STALE_FOR_SESSION_SECS) {
    const age_hours = Math.trunc(age_secs / 3600);
    stale_str = `  (stale: ${age_hours}h)`;
  }

  return `- 🧠 ${name}${count_str}  (${size_str}${trunc_marker})${stale_str}  recall: \`token-goat skill-body ${name}\``;
}

const _MAX_DECISIONS = 5;
const _MAX_DECISION_RENDER_LEN = 140;

function _select_top_decision_entries(decisions: unknown): unknown[] {
  // Pick up to _MAX_DECISIONS recent decision entries (last slice, chronological).
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return [];
  }
  return decisions.slice(-_MAX_DECISIONS);
}

function _format_decision_entry(entry: unknown): string {
  // Render one DecisionEntry as a single manifest line, with an optional [tag].
  const text = sanitize_log_str(_strAttr(entry, "text"), _MAX_DECISION_RENDER_LEN);
  const tag = sanitize_log_str(_strAttr(entry, "tag"), 24);
  const tag_str = tag ? `[${tag}] ` : "";
  return `- 💡 ${tag_str}${text}`;
}

export function _format_hint_telemetry(cache: unknown): string | null {
  // Return a one-line hint activity summary "(12 hints, 4 suppressed)", or null
  // when no hints fired at all.
  const emitted = Math.trunc(_numAttr(cache, "hints_emitted", 0) || 0);
  const _sup_raw = _attr(cache, "hints_suppressed_by_type", null);
  const suppressed = _isDict(_sup_raw) ? Object.values(_sup_raw).reduce((s: number, v) => s + Number(v ?? 0), 0) : 0;
  if (emitted === 0 && suppressed === 0) {
    return null;
  }
  if (suppressed === 0) {
    return `(${emitted} hints)`;
  }
  return `(${emitted} hints, ${suppressed} suppressed)`;
}

function _select_top_glob_entries(glob_history: unknown): unknown[] {
  // Pick up to _MAX_GLOB_ENTRIES glob scans, filtering trivially broad patterns.
  if (!Array.isArray(glob_history) || glob_history.length === 0) {
    return [];
  }
  const _TRIVIAL = new Set(["", "*", "**"]);
  const candidates = glob_history.filter((e) => !_TRIVIAL.has(sanitize_log_str(_strAttr(e, "pattern"), 256).trim()));
  if (candidates.length === 0) {
    return [];
  }
  return _nlargest(_MAX_GLOB_ENTRIES, candidates, (e) => _numAttr(e, "ts", 0.0));
}

function _format_glob_entry(entry: unknown, opts: { cwd?: string | null } = {}): string {
  // Render one GlobEntry as a single manifest line: "- g: pattern  (scope, N files)".
  const cwd = opts.cwd ?? null;
  const pattern = sanitize_log_str(_strAttr(entry, "pattern"), 80);
  let path = _attr(entry, "path", null);
  if (path && cwd) {
    const norm_path = _norm_key(String(path)).replace(/\/+$/, "");
    const norm_cwd = _norm_key(String(cwd)).replace(/\/+$/, "");
    if (norm_path === norm_cwd) {
      path = null;
    }
  }
  const count = _attr(entry, "result_count", null);
  const scope = path ? `  (${String(path)}` : "";
  let hits: string;
  if (typeof count === "number" && Number.isInteger(count)) {
    hits = scope ? `, ${count} files)` : `  (${count} files)`;
  } else {
    hits = scope ? ")" : "";
  }
  return `- g: ${pattern}${scope}${hits}`;
}

export function _token_count(text: string): number {
  // Rough token estimate: 1 token ≈ 4 characters. Used for per-section budgets
  // inside _render (conservative vs. estimate_tokens' len//3+1).
  return Math.floor(text.length / 4);
}

// ---------------------------------------------------------------------------
// urlparse helpers (Python urllib.parse.urlparse -> WHATWG URL, fail-soft).
// ---------------------------------------------------------------------------

/** Return the netloc (host[:port]) of url_preview, "" when unparseable. */
function _urlparseNetloc(url_preview: string): string {
  try {
    const u = new URL(url_preview);
    return u.host;
  } catch {
    // urllib.parse.urlparse never raises; a bare path with no scheme yields ""
    // netloc. Mirror that: a non-URL string has no netloc.
    return "";
  }
}

/** Return path + params + query of url_preview (Python parsed.path/params/query). */
function _urlparsePathQuery(url_preview: string): string {
  try {
    const u = new URL(url_preview);
    let p = u.pathname || "/";
    // WHATWG URL has no separate `params` (the ";params" segment); urllib splits
    // it out but the manifest concatenates path+params+query, so the pathname
    // (which keeps any ";params") + the query reproduces the same visible string.
    if (u.search) {
      // u.search includes the leading "?".
      p += u.search;
    }
    return p;
  } catch {
    return "?";
  }
}

// ---------------------------------------------------------------------------
// Section budget allocation.
// ---------------------------------------------------------------------------

export function _section_budgets(
  total_budget: number,
  edited_tokens: number,
  section_content_counts: Record<string, number> | null = null,
): Record<string, number> {
  // Distribute the manifest token budget across variable sections. Sections with
  // zero entries are excluded and their share flows to sections with content.
  const remaining = Math.max(0, total_budget - edited_tokens);

  const base_proportions: Record<string, number> = {
    symbols: 0.38,
    files: 0.22,
    greps: 0.15,
    bash: 0.1,
    web: 0.1,
    glob: 0.05,
  };
  const baseNames = Object.keys(base_proportions);

  if (section_content_counts === null) {
    const _MIN_SECTION_TOKENS = 20;
    const budgets: Record<string, number> = {};
    for (const name of baseNames) {
      budgets[name] = Math.max(_MIN_SECTION_TOKENS, Math.trunc(remaining * (base_proportions[name] ?? 0)));
    }
    return budgets;
  }

  const sections_with_content = new Set(baseNames.filter((name) => (section_content_counts[name] ?? 0) > 0));

  if (sections_with_content.size === 0) {
    const zeros: Record<string, number> = {};
    for (const name of baseNames) {
      zeros[name] = 0;
    }
    return zeros;
  }

  const active_proportions: Record<string, number> = {};
  for (const name of sections_with_content) {
    active_proportions[name] = base_proportions[name] ?? 0;
  }
  const proportion_sum = Object.values(active_proportions).reduce((s, v) => s + v, 0);
  const normalized_proportions: Record<string, number> = {};
  for (const [name, prop] of Object.entries(active_proportions)) {
    normalized_proportions[name] = prop / proportion_sum;
  }

  const _MIN_SECTION_TOKENS = 40;
  const result_budgets: Record<string, number> = {};
  for (const name of baseNames) {
    if (!sections_with_content.has(name)) {
      result_budgets[name] = 0;
    } else {
      result_budgets[name] = Math.max(
        _MIN_SECTION_TOKENS,
        Math.trunc(remaining * (normalized_proportions[name] ?? 0)),
      );
    }
  }

  return result_budgets;
}

// ---------------------------------------------------------------------------
// Grep ranking + dedup.
// ---------------------------------------------------------------------------

function _grep_sort_key(entry: unknown, now_ts: number): number {
  // Composite sort key: recency_weight * (1 + normalised match_count). Recency
  // uses exp decay with _GREP_RECENCY_HALF_LIFE_SECS.
  const age = Math.max(0.0, now_ts - _numAttr(entry, "ts", 0.0));
  const recency = Math.exp((-age * Math.log(2)) / _GREP_RECENCY_HALF_LIFE_SECS);
  // Python: min(100, match_count or 1). `match_count or 1` yields match_count when
  // truthy (a non-zero number), else 1 (covers None and 0).
  const match_count = _attr(entry, "result_count", null);
  const mc = typeof match_count === "number" && match_count ? match_count : 1;
  const count_factor = 1.0 + Math.min(100, mc) / 100.0;
  return recency * count_factor;
}

function _select_top_grep_entries(greps: unknown[]): unknown[] {
  // Pick up to _MAX_GREP_ENTRIES best unique grep patterns: dedup by pattern
  // (keep most-recent), drop zero-result/stale entries, rank by composite score.
  if (!greps || greps.length === 0) {
    return [];
  }

  // Step 1: dedup by pattern — iterate oldest->newest so newest overwrites.
  const sortedByTs = [...greps].sort((a, b) => _numAttr(a, "ts", 0.0) - _numAttr(b, "ts", 0.0));
  const seen = new Map<string, unknown>();
  for (const g of sortedByTs) {
    seen.set(_strAttr(g, "pattern"), g);
  }
  let candidates = [...seen.values()];
  if (candidates.length === 0) {
    return [];
  }

  // Step 1b: drop zero-result greps unless every grep was zero-result.
  const with_hits = candidates.filter((g) => (Number(_attr(g, "result_count", 0)) || 0) > 0);
  if (with_hits.length > 0) {
    candidates = with_hits;
  }

  // Step 2: staleness filter.
  const now_ts = _now();
  let fresh = candidates.filter((g) => now_ts - _numAttr(g, "ts", 0.0) < _GREP_STALE_SECS);
  if (fresh.length === 0) {
    fresh = _nlargest(_GREP_MIN_WHEN_ALL_STALE, candidates, (g) => _numAttr(g, "ts", 0.0));
  }

  // Step 3: rank by composite score.
  return _nlargest(_MAX_GREP_ENTRIES, fresh, (g) => _grep_sort_key(g, now_ts));
}

/** Wrapper mirroring Python's _AugmentedEntry: substitutes an annotated pattern
 *  without mutating the original. getattr falls through to the original. */
class _AugmentedEntry {
  private _orig: unknown;
  private _pattern: string;
  constructor(orig: unknown, new_pattern: string) {
    this._orig = orig;
    this._pattern = new_pattern;
    // Mirror the original's enumerable own fields so getattr-style reads (and the
    // _strAttr/_attr helpers, which test `name in obj`) resolve to the original
    // values; `pattern` is then overridden below.
    if (orig !== null && typeof orig === "object") {
      for (const [k, v] of Object.entries(orig as Record<string, unknown>)) {
        if (k === "pattern" || k === "_orig" || k === "_pattern") {
          continue;
        }
        (this as Record<string, unknown>)[k] = v;
      }
    }
  }
  get pattern(): string {
    return this._pattern;
  }
}

export function _dedup_grep_entries(
  entries: unknown[],
  raw_counts: Record<string, number> | null = null,
): unknown[] {
  // Deduplicate and annotate grep entries: group by pattern, keep best
  // representative, append " [×N]" when the count > 1.
  if (!entries || entries.length === 0) {
    return [];
  }

  const pattern_groups = new Map<string, [unknown, number]>();
  for (const entry of entries) {
    const pattern = _strAttr(entry, "pattern");
    if (!pattern) {
      continue;
    }

    const result_count = _attr(entry, "result_count", null);
    const ts = _numAttr(entry, "ts", 0.0);

    const existing = pattern_groups.get(pattern);
    if (existing === undefined) {
      pattern_groups.set(pattern, [entry, 1]);
    } else {
      const [existing_entry, count] = existing;
      const existing_count = _attr(existing_entry, "result_count", null);
      const existing_ts = _numAttr(existing_entry, "ts", 0.0);

      let should_replace = false;
      if (result_count !== null && result_count !== undefined && existing_count !== null && existing_count !== undefined) {
        should_replace = Number(result_count) > Number(existing_count);
      } else if ((result_count !== null && result_count !== undefined) || ts > existing_ts) {
        should_replace = true;
      }

      if (should_replace) {
        pattern_groups.set(pattern, [entry, count + 1]);
      } else {
        pattern_groups.set(pattern, [existing_entry, count + 1]);
      }
    }
  }

  const result: unknown[] = [];
  for (const [pattern, [entry, count]] of pattern_groups) {
    const effective_count = (raw_counts ?? {})[pattern] ?? count;
    if (effective_count === 1) {
      result.push(entry);
    } else {
      const annotated_pattern = `${pattern} [×${effective_count}]`;
      result.push(new _AugmentedEntry(entry, annotated_pattern));
    }
  }

  return result;
}

function _format_grep_entry(entry: unknown): string {
  // Render one GrepEntry as a single manifest line: "- `pattern` in path (N)".
  const pattern = sanitize_log_str(_strAttr(entry, "pattern"), 80);
  const path = _attr(entry, "path", null);
  const result_count = _attr(entry, "result_count", null);
  const path_str = path ? ` in ${_short_path(String(path))}` : "";
  const count_str = result_count !== null && result_count !== undefined ? ` (${result_count})` : "";
  return `- \`${pattern}\`${path_str}${count_str}`;
}

// ---------------------------------------------------------------------------
// Session cache load + age tiering.
// ---------------------------------------------------------------------------

function _load_session_cache(session_id: string, caller: string): SessionCache | null {
  // Validate session_id and load the session cache, returning null on failure.
  const cache = session.safe_load(session_id, { caller });
  if (cache !== null && cache !== undefined) {
    _LOG.debug(
      "%s: session=%s loaded (files=%d greps=%d edited=%d)",
      caller,
      session_id.slice(0, 8),
      Object.keys(cache.files).length,
      cache.greps.length,
      Object.keys(cache.edited_files).length,
    );
  }
  return cache;
}

export function _session_age_tier(age_seconds: number): string {
  // young < 10 min, active 10-60 min, mature > 60 min.
  if (age_seconds < 600) {
    return "young";
  }
  if (age_seconds < 3600) {
    return "active";
  }
  return "mature";
}

function _compute_activity_multiplier(age_seconds: number, edit_count: number): number {
  // Adaptive tier multiplier considering age and edit density.
  //   young=0.6 active=1.0 mature=1.4; density downgrade caps at 1.0 when
  //   age>=10min and edits/min < 0.3.
  const tier = _session_age_tier(age_seconds);
  const age_factors: Record<string, number> = { young: 0.6, active: 1.0, mature: 1.4 };
  let factor = age_factors[tier] ?? 1.0;

  if (age_seconds >= 600) {
    const age_minutes = age_seconds / 60.0;
    const density = edit_count / Math.max(1.0, age_minutes);
    if (density < 0.3) {
      factor = Math.min(factor, 1.0);
    }
  }

  return factor;
}

function _compute_stale_compact_fraction(session_id: string, skill_history: Record<string, unknown>): number {
  // Return the fraction of loaded skills whose compact is missing or stale.
  // Fail-soft to 0.0 when the skill_cache module is unavailable (no compacts to
  // check) — matches the Python ImportError-on-lazy-import path effectively.
  if (!skill_history || Object.keys(skill_history).length === 0) {
    return 0.0;
  }

  const sc = _getSkillCache();
  if (sc === null) {
    // No skill_cache module: cannot assess staleness. Treat as all-fresh (0.0)
    // so the budget is not inflated. (The Python lazy import would raise and the
    // caller's try/except returns its default; the only caller wraps this so 0.0
    // is the safe equivalent.)
    return 0.0;
  }

  let total = 0;
  let stale_count = 0;
  for (const name of Object.keys(skill_history)) {
    const entry = skill_history[name];
    total += 1;
    const entry_sha = _strAttr(entry, "content_sha") || "";
    const compact_text = sc.get_compact_any_session(name);
    if (compact_text === null) {
      stale_count += 1;
      continue;
    }
    const embedded_sha = sc.extract_compact_source_sha(compact_text);
    if (embedded_sha === null) {
      continue;
    }
    if (entry_sha && !entry_sha.startsWith(embedded_sha)) {
      stale_count += 1;
    }
  }

  return total > 0 ? stale_count / total : 0.0;
}

export function compute_adaptive_budget(
  cache: SessionCache,
  age_seconds = 0.0,
  opts: {
    has_pending_diff?: boolean;
    has_uncommitted_changes?: boolean;
    stale_compact_fraction?: number;
    context_pressure?: ContextPressure | null;
  } = {},
): number {
  // Compute an adaptive token budget for the manifest based on session
  // complexity. Capped to [200, 800], then further capped by context pressure
  // (critical -> 300, hot -> 500).
  const has_pending_diff = opts.has_pending_diff ?? false;
  const has_uncommitted_changes = opts.has_uncommitted_changes ?? false;
  const stale_compact_fraction = opts.stale_compact_fraction ?? 0.0;
  const context_pressure = opts.context_pressure ?? null;

  const base = 200;
  let max_total = 800;
  const min_total = 200;

  const edited_count = _isDict(cache.edited_files) ? Object.keys(cache.edited_files).length : 0;
  const edited_bonus = Math.min(200, edited_count * 50);

  const symbols_files = Object.values(cache.files).filter((e) => e.symbols_read.length > 0).length;
  const symbols_bonus = Math.min(150, symbols_files * 30);

  const bash_bonus = _isDict(cache.bash_history) && Object.keys(cache.bash_history).length > 0 ? 20 : 0;
  const web_bonus = _isDict(cache.web_history) && Object.keys(cache.web_history).length > 0 ? 15 : 0;

  const diff_bonus = has_pending_diff ? 50 : 0;
  const uncommitted_bonus = has_uncommitted_changes ? 10 : 0;

  const _safe_frac = Math.max(0.0, Math.min(1.0, stale_compact_fraction));
  const stale_bonus = Math.min(60, Math.round(_safe_frac * 60));

  const raw_total =
    base + edited_bonus + symbols_bonus + bash_bonus + web_bonus + diff_bonus + uncommitted_bonus + stale_bonus;

  const factor = _compute_activity_multiplier(age_seconds, edited_count);
  const total = Math.trunc(Math.round(raw_total * factor));

  if (context_pressure !== null) {
    if (context_pressure.tier === "critical") {
      max_total = Math.min(max_total, 300);
    } else if (context_pressure.tier === "hot") {
      max_total = Math.min(max_total, 500);
    }
  }

  return Math.max(min_total, Math.min(max_total, total));
}

export function _compute_budget_multiplier(cache: SessionCache, base_multiplier: number): number {
  // Adaptive multiplier for the manifest token budget. Escalates to
  // max(base, 2.5) on > 10 edited files or > 5 distinct failing tests.
  const _EDITED_FILES_THRESHOLD = 10;
  const _TEST_FAILURES_THRESHOLD = 5;
  const _ESCALATED_MULTIPLIER = 2.5;

  const edited_count = _isDict(cache.edited_files) ? Object.keys(cache.edited_files).length : 0;
  if (edited_count > _EDITED_FILES_THRESHOLD) {
    return Math.max(base_multiplier, _ESCALATED_MULTIPLIER);
  }

  const bash_hist = (_attr(cache, "bash_history", null) as Record<string, unknown> | null) ?? {};
  const failure_names = _extract_test_failures(bash_hist);
  if (failure_names.length > _TEST_FAILURES_THRESHOLD) {
    return Math.max(base_multiplier, _ESCALATED_MULTIPLIER);
  }

  return base_multiplier;
}

const _ACTIVITY_FLOOR = 3;
// Re-exported under the same name for tests that import compact._ACTIVITY_FLOOR.
export { _ACTIVITY_FLOOR };

export function build_manifest_adaptive(session_id: string): string {
  // Load session cache and build manifest with an adaptively-computed token
  // budget. Returns "" when the cache is missing/unreadable or activity is below
  // the floor.
  _LOG.debug("build_manifest_adaptive: session=%s", session_id.slice(0, 8));
  const cache = _load_session_cache(session_id, "build_manifest_adaptive");
  if (cache === null) {
    return "";
  }
  const created_ts = _attr(cache, "created_ts", null);
  const age_seconds = created_ts !== null && created_ts !== undefined ? Math.max(0.0, _now() - Number(created_ts)) : 0.0;
  const cwd = _attr(cache, "cwd", null) as string | null;
  const pending_diff = _get_git_diff_stat_summary(cwd);
  const uncommitted = _get_uncommitted_changes(cwd);
  const skill_history = (_attr(cache, "skill_history", null) as Record<string, unknown> | null) ?? {};
  const stale_frac = _compute_stale_compact_fraction(session_id, skill_history);
  const pressure = get_context_pressure(session_id, { cache });
  const budget = compute_adaptive_budget(cache, age_seconds, {
    has_pending_diff: Boolean(pending_diff),
    has_uncommitted_changes: Boolean(uncommitted),
    stale_compact_fraction: stale_frac,
    context_pressure: pressure,
  });
  const activity_score = _session_activity_score(cache);
  if (activity_score < _ACTIVITY_FLOOR) {
    _LOG.info(
      "build_manifest_adaptive: session=%s suppressed (activity_score=%d < floor=%d)",
      session_id.slice(0, 8),
      activity_score,
      _ACTIVITY_FLOOR,
    );
    return "";
  }

  _LOG.debug(
    "build_manifest_adaptive: session=%s budget=%d tier=%s pressure=%s",
    session_id.slice(0, 8),
    budget,
    _session_age_tier(age_seconds),
    pressure.tier,
  );
  const cfg = config.load();
  return _build_manifest_from_cache(cache, session_id, budget, _compact_render_kwargs(cfg));
}

export function event_count(session_id: string): number {
  // Count tracked events (reads + greps + edits + bash runs + skills).
  const cache = _load_session_cache(session_id, "event_count");
  if (cache === null) {
    return 0;
  }
  return (
    Object.keys(cache.files).length +
    cache.greps.length +
    Object.keys(cache.edited_files).length +
    Object.keys((_attr(cache, "bash_history", null) as Record<string, unknown> | null) ?? {}).length +
    Object.keys((_attr(cache, "skill_history", null) as Record<string, unknown> | null) ?? {}).length
  );
}

// ---------------------------------------------------------------------------
// Render kwargs + top-level manifest builders.
// ---------------------------------------------------------------------------

/** The render-tuning kwargs unpacked from config (Python _compact_render_kwargs). */
interface CompactRenderKwargs {
  edited_dir_group_threshold: number;
  max_section_lines: number;
  noise_floor_tokens: number;
  wide_session_threshold: number;
  orchestrator_commit_threshold: number;
  lazy_skill_injection: boolean;
  harness: string;
}

function _compact_render_kwargs(cfg: ConfigSchema): CompactRenderKwargs {
  // Unpack the render-tuning fields from cfg. lazy_skill_injection derives from
  // [skill_preservation] inline_snippets (True -> eager -> lazy=False) with the
  // legacy [compact_assist] lazy_skill_injection as the inline_snippets=False
  // fallback. config.load() always populates compact_assist + skill_preservation
  // (the TS _buildConfig builds both unconditionally), so the ?? defaults below
  // mirror the Python dataclass defaults only as a belt-and-suspenders guard.
  const ca = cfg.compact_assist ?? {};
  const sp = cfg.skill_preservation ?? {};
  const inline_snippets = sp.inline_snippets ?? true;
  const lazy = inline_snippets ? false : (ca.lazy_skill_injection ?? true);
  return {
    edited_dir_group_threshold: ca.edited_dir_group_threshold ?? 3,
    max_section_lines: ca.max_section_lines ?? 0,
    noise_floor_tokens: ca.noise_floor_tokens ?? 0,
    wide_session_threshold: ca.wide_session_threshold ?? 15,
    orchestrator_commit_threshold: ca.orchestrator_commit_threshold ?? 5,
    lazy_skill_injection: lazy,
    harness: detect_harness(ca.harness ?? "auto"),
  };
}

export function _build_manifest_from_cache(
  cache: SessionCache,
  session_id: string,
  max_tokens: number,
  kwargs: Partial<CompactRenderKwargs> = {},
): string {
  // Render the manifest from an already-loaded cache. Separated from
  // build_manifest so build_manifest_with_count can share the render path.
  const edited_dir_group_threshold = kwargs.edited_dir_group_threshold ?? 3;
  const max_section_lines = kwargs.max_section_lines ?? 0;
  const noise_floor_tokens = kwargs.noise_floor_tokens ?? 0;
  const wide_session_threshold = kwargs.wide_session_threshold ?? 15;
  const orchestrator_commit_threshold = kwargs.orchestrator_commit_threshold ?? 5;
  const lazy_skill_injection = kwargs.lazy_skill_injection ?? true;
  const harness = kwargs.harness ?? "claudecode";

  const clamped = Math.max(1, Math.min(max_tokens, _MAX_MANIFEST_TOKENS_CAP));
  if (clamped !== max_tokens) {
    _LOG.warning(
      "build_manifest: max_tokens=%d out of range [1, %d], clamped to %d",
      max_tokens,
      _MAX_MANIFEST_TOKENS_CAP,
      clamped,
    );
  }
  max_tokens = clamped;
  const start = _monotonic();
  const [renderResult, files_with_symbols_count] = _render(cache, session_id, max_tokens, {
    edited_dir_group_threshold,
    max_section_lines,
    noise_floor_tokens,
    wide_session_threshold,
    orchestrator_commit_threshold,
    lazy_skill_injection,
    harness,
  });
  let result = renderResult;
  const elapsed = _monotonic() - start;

  if (elapsed > _MANIFEST_TIMEOUT_SECS) {
    result += `\n\n⚠ manifest build timed out after ${elapsed.toFixed(2)}s — output may be incomplete`;
    _LOG.warning(
      "build_manifest: timeout exceeded for session=%s (%ss > %ss)",
      session_id.slice(0, 8),
      elapsed.toFixed(2),
      _MANIFEST_TIMEOUT_SECS.toFixed(2),
    );
  } else if (elapsed > _MANIFEST_TIMEOUT_SECS * 0.8) {
    result += `\n\n(rendered in ${Math.trunc(elapsed * 1000)}ms)`;
    _LOG.info(
      "build_manifest: slow-render warning for session=%s (%ss > 80%% of %ss)",
      session_id.slice(0, 8),
      elapsed.toFixed(2),
      _MANIFEST_TIMEOUT_SECS.toFixed(2),
    );
  }

  const token_estimate = estimate_tokens(result);
  _LOG.info(
    "build_manifest: session=%s edited_files=%d files_read=%d symbols_files=%d manifest_tokens=%d elapsed=%ss",
    session_id.slice(0, 8),
    Object.keys(cache.edited_files).length,
    Object.keys(cache.files).length,
    files_with_symbols_count,
    token_estimate,
    elapsed.toFixed(3),
  );

  if (result) {
    const _quality_score = _score_manifest([result]);
    if (_quality_score === 0) {
      _LOG.debug(
        "build_manifest: quality score=0 (noop manifest) session=%s — consider tightening min_events gate",
        session_id.slice(0, 8),
      );
    } else if (_quality_score < _MANIFEST_THIN_THRESHOLD) {
      _LOG.debug(
        "build_manifest: thin manifest quality score=%d (<%d) session=%s — manifest may not preserve enough context",
        _quality_score,
        _MANIFEST_THIN_THRESHOLD,
        session_id.slice(0, 8),
      );
    }
  }

  return result;
}

export function _enforce_char_budget(manifest: string, max_chars: number): string {
  // Truncate manifest to max_chars characters with section-aware priority
  // (header + edited > symbols > skills > the rest). Appends a truncation suffix.
  if (max_chars <= 0 || manifest.length <= max_chars) {
    return manifest;
  }

  const _TRUNCATION_SUFFIX = "\n... (manifest truncated at budget limit)";
  const suffix_len = _TRUNCATION_SUFFIX.length;
  const available = max_chars - suffix_len;
  if (available <= 0) {
    return _TRUNCATION_SUFFIX.replace(/^\s+/, "");
  }

  const lines = manifest.split("\n");

  const _classify = (line: string): string | null => {
    if (
      line.startsWith("**Staged/Uncommitted:**") ||
      line.startsWith("**Edited:**") ||
      line.startsWith("**Files:**") ||
      line.startsWith("**Committed This Session:**")
    ) {
      return "edited";
    }
    if (line.startsWith("**Symbols Accessed:**")) {
      return "symbols";
    }
    if (line.startsWith("**Skills:**")) {
      return "skills";
    }
    return null;
  };

  const segments: Array<[string, number[]]> = [];
  let current_seg_name = "header";
  let current_seg_indices: number[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const new_seg = _classify(line);
    if (new_seg !== null && new_seg !== current_seg_name) {
      if (current_seg_indices.length > 0) {
        segments.push([current_seg_name, current_seg_indices]);
      }
      current_seg_name = new_seg;
      current_seg_indices = [idx];
    } else {
      current_seg_indices.push(idx);
    }
  }

  if (current_seg_indices.length > 0) {
    segments.push([current_seg_name, current_seg_indices]);
  }

  const _PRIORITY_ORDER = ["header", "edited", "symbols", "skills"];

  const kept_indices: number[] = [];

  const _current_result_len = (): number => {
    if (kept_indices.length === 0) {
      return 0;
    }
    return kept_indices.reduce((s, i) => s + lines[i]!.length, 0) + Math.max(0, kept_indices.length - 1);
  };

  const _add_line_fits = (line_idx: number): boolean => {
    const separator_cost = kept_indices.length > 0 ? 1 : 0;
    const line_cost = lines[line_idx]!.length + separator_cost;
    const current_len = _current_result_len();
    if (current_len + line_cost <= available) {
      kept_indices.push(line_idx);
      return true;
    }
    return false;
  };

  // Pass 1: header + edited.
  for (const [seg_name, seg_idxs] of segments) {
    if (seg_name === "header" || seg_name === "edited") {
      for (const idx of seg_idxs) {
        _add_line_fits(idx);
      }
    }
  }

  // Pass 2: symbols and skills.
  for (const seg_name of ["symbols", "skills"]) {
    for (const [s_name, s_idxs] of segments) {
      if (s_name === seg_name) {
        for (const idx of s_idxs) {
          if (!_add_line_fits(idx)) {
            break;
          }
        }
      }
    }
  }

  // Pass 3: remaining segments.
  for (const [seg_name, seg_idxs] of segments) {
    if (_PRIORITY_ORDER.includes(seg_name)) {
      continue;
    }
    for (const idx of seg_idxs) {
      if (!_add_line_fits(idx)) {
        break;
      }
    }
  }

  const result_body = _rstrip(kept_indices.map((i) => lines[i]!).join("\n"));
  let result = result_body + _TRUNCATION_SUFFIX;
  if (result.length > max_chars) {
    result = _rstrip(result.slice(0, max_chars - suffix_len)) + _TRUNCATION_SUFFIX;
  }
  return result;
}

export function build_manifest(session_id: string, opts: { max_tokens?: number } = {}): string {
  // Build a compact session manifest from the session cache. Returns structured
  // text under max_tokens tokens. Safe even when the cache is empty/missing.
  const max_tokens = opts.max_tokens ?? 400;
  _LOG.debug("build_manifest: session=%s max_tokens=%d", session_id.slice(0, 8), max_tokens);
  const cache = _load_session_cache(session_id, "build_manifest");
  if (cache === null) {
    return "";
  }

  // --- Manifest delta-cache (item #1) ---
  const now = _now();
  const fingerprint = _compute_manifest_fingerprint(cache);

  const sidecar_data = _read_manifest_sidecar(session_id);
  let prior_counts: Record<string, number> | null = null;
  if (sidecar_data !== null && !_manifest_sha_written_this_process.has(session_id)) {
    const [, cached_fp, cached_ts, sidecarCounts] = sidecar_data;
    prior_counts = sidecarCounts;
    const sidecar_age = now - cached_ts;
    if (cached_ts > 0.0 && sidecar_age >= 0.0 && sidecar_age < _MANIFEST_CACHE_TTL_SECS && cached_fp === fingerprint) {
      const emit_time = _strftimeHM(cached_ts);
      const short_id = session_id.length >= 8 ? session_id.slice(0, 8) : session_id;
      _LOG.debug(
        "build_manifest: sidecar cache-hit session=%s fp=%s age=%ss — returning stub",
        session_id.slice(0, 8),
        fingerprint,
        sidecar_age.toFixed(0),
      );
      return (
        `## Token-Goat Manifest — unchanged since ${emit_time}. ` +
        `Recall: \`token-goat compact-hint --session-id ${short_id}\`.`
      );
    }
    if (sidecar_age < 0.0) {
      _LOG.warning(
        "build_manifest: sidecar ts is in the future session=%s skew=%ss — ignoring cache, rebuilding manifest",
        session_id.slice(0, 8),
        (-sidecar_age).toFixed(0),
      );
      prior_counts = null;
    } else if (cached_ts <= 0.0) {
      _LOG.warning(
        "build_manifest: sidecar ts is non-positive session=%s ts=%s — ignoring cache, rebuilding manifest",
        session_id.slice(0, 8),
        String(cached_ts),
      );
      prior_counts = null;
    } else if (sidecar_age >= _MANIFEST_CACHE_TTL_SECS) {
      _LOG.debug(
        "build_manifest: sidecar cache expired session=%s age=%ss ttl=%ss — rebuilding manifest",
        session_id.slice(0, 8),
        sidecar_age.toFixed(0),
        _MANIFEST_CACHE_TTL_SECS.toFixed(0),
      );
    } else if (cached_fp !== fingerprint) {
      _LOG.debug(
        "build_manifest: sidecar fingerprint mismatch session=%s — session changed, rebuilding (stored=%s current=%s)",
        session_id.slice(0, 8),
        cached_fp,
        fingerprint,
      );
    }
  } else if (sidecar_data !== null) {
    const [, , , sidecarCounts] = sidecar_data;
    prior_counts = sidecarCounts;
  }

  // Cache miss or TTL expired: render the full manifest.
  const cfg = config.load();
  const _will_append_directives = max_tokens >= _DIRECTIVE_APPEND_MIN_TOKENS;
  const _reserve = _will_append_directives ? _DIRECTIVE_TOKEN_RESERVE : 0;
  const body_budget = Math.max(1, max_tokens - _reserve - _AS_OF_TOKEN_RESERVE);
  let full_manifest = _build_manifest_from_cache(cache, session_id, body_budget, _compact_render_kwargs(cfg));
  if (!full_manifest) {
    return full_manifest;
  }

  // Item #26: prepend a one-line **Δ since last compact:** when applicable.
  const current_counts = _compute_section_counts(cache);
  const delta_line = _format_manifest_delta(prior_counts, current_counts);
  if (delta_line) {
    full_manifest = delta_line + "\n" + full_manifest;
  }

  // Hard char-budget enforcement.
  const _max_chars = cfg.compact_assist?.max_manifest_chars ?? 1600;
  if (_max_chars > 0 && full_manifest.length > _max_chars) {
    const _original_len = full_manifest.length;
    full_manifest = _enforce_char_budget(full_manifest, _max_chars);
    const _final_len = full_manifest.length;
    _LOG.debug("manifest truncated: %d chars → %d chars (budget: %d)", _original_len, _final_len, _max_chars);
  }

  // Persist the sidecar with the new SHA + fingerprint + counts.
  const sha = _short_content_hash(full_manifest);
  _write_manifest_sidecar(session_id, sha, fingerprint, now, current_counts);
  _manifest_sha_written_this_process.add(session_id);

  // Update the session-JSON fields too.
  cache.last_manifest_sha = sha;
  cache.last_manifest_ts = now;
  cache._invalidate_json_cache();
  session.save(cache);

  // Inject the static directive block before the first dynamic section.
  if (_will_append_directives) {
    const _dir_block = _COMPACT_DIRECTIVES.replace(/^\n+/, "");
    let _ins_pos = full_manifest.indexOf("\n**");
    if (_ins_pos === -1) {
      _ins_pos = full_manifest.indexOf("\n## Pinned");
    }
    if (_ins_pos !== -1) {
      full_manifest = full_manifest.slice(0, _ins_pos + 1) + _dir_block + "\n" + full_manifest.slice(_ins_pos + 1);
    } else {
      full_manifest = _dir_block + "\n" + full_manifest;
    }
  }

  // Append a stable as-of timestamp suffix.
  const as_of_str = _strftimeISO(now);
  full_manifest = full_manifest.replace(/\n+$/, "") + `\n# as-of: ${as_of_str}`;

  // Save the full manifest text sidecar (developer tooling; best-effort).
  try {
    const text_sidecar = paths.manifestTextSidecarPath(session_id);
    paths.ensureDir(nodePath.dirname(text_sidecar));
    paths.atomicWriteText(text_sidecar, full_manifest);
  } catch {
    // swallow
  }

  return full_manifest;
}

export function build_manifest_with_count(session_id: string, opts: { max_tokens?: number } = {}): [string, number] {
  // Load the session cache once and return [manifest, event_count]. Returns
  // ["", 0] when the cache is missing/unreadable.
  const max_tokens = opts.max_tokens ?? 400;
  _LOG.debug("build_manifest_with_count: session=%s max_tokens=%d", session_id.slice(0, 8), max_tokens);
  const cache = _load_session_cache(session_id, "build_manifest_with_count");
  if (cache === null) {
    return ["", 0];
  }
  const n_events =
    Object.keys(cache.files).length +
    cache.greps.length +
    Object.keys(cache.edited_files).length +
    Object.keys((_attr(cache, "bash_history", null) as Record<string, unknown> | null) ?? {}).length +
    Object.keys((_attr(cache, "skill_history", null) as Record<string, unknown> | null) ?? {}).length;
  const manifest = build_manifest(session_id, { max_tokens });
  return [manifest, n_events];
}

export function normalize_for_cache(manifest_text: string): string {
  // Strip the trailing `# as-of: ...` line so two manifests built at different
  // wall-clock times from identical session content compare byte-equal.
  let lines = manifest_text.replace(/\n+$/, "").split("\n");
  if (lines.length > 0 && lines[lines.length - 1]!.startsWith("# as-of:")) {
    lines = lines.slice(0, -1);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cross-session manifest deduplication.
// ---------------------------------------------------------------------------

export function write_session_manifest(
  project_hash: string,
  session_id: string,
  manifest_json: Record<string, unknown>,
): void {
  // Write per-session manifest JSON for cross-session deduplication. Atomic.
  // Routes through paths.dataDir so the cross-session-dedup tests' spy on
  // paths.dataDir is observed.
  const sessions_dir = nodePath.join(paths.dataDir(), "projects", project_hash, "sessions");
  paths.ensureDir(sessions_dir);
  const dest = nodePath.join(sessions_dir, `${session_id}.json`);
  paths.atomicWriteText(dest, JSON.stringify(manifest_json));
}

export function read_all_session_manifests(
  project_hash: string,
  max_age_seconds = 3600,
): Array<Record<string, unknown>> {
  // Read all session manifest JSON files for project_hash, skipping stale and
  // corrupt entries. Stale = filesystem mtime older than max_age_seconds.
  const sessions_dir = nodePath.join(paths.dataDir(), "projects", project_hash, "sessions");
  if (!fs.existsSync(sessions_dir)) {
    return [];
  }
  const now = _now();
  const results: Array<Record<string, unknown>> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(sessions_dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const name of entries) {
    const p = nodePath.join(sessions_dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs / 1000 > max_age_seconds) {
        continue;
      }
      const data = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
      if (_isDict(data) && "files" in data) {
        results.push(data);
      }
    } catch {
      // swallow
    }
  }
  return results;
}

export function merge_session_manifests(
  manifests: Array<Record<string, unknown>>,
  budget_tokens: number,
): Array<Record<string, unknown>> {
  // Merge file entries from multiple sessions, deduplicating by rel_path (keep
  // highest hit_count). Sorted by hit_count desc, capped at budget_tokens (~10
  // chars of rel_path ≈ 1 token).
  const merged = new Map<string, Record<string, unknown>>();
  for (const manifest of manifests) {
    const files = Array.isArray(manifest["files"]) ? (manifest["files"] as unknown[]) : [];
    for (const entryRaw of files) {
      if (!_isDict(entryRaw)) {
        continue;
      }
      const entry = entryRaw;
      const rel = String(entry["rel_path"] ?? "");
      if (!rel) {
        continue;
      }
      const existing = merged.get(rel);
      const hit = Number(entry["hit_count"] ?? 0);
      const existingHit = existing ? Number(existing["hit_count"] ?? 0) : -Infinity;
      if (existing === undefined || hit > existingHit) {
        merged.set(rel, entry);
      }
    }
  }
  const sorted_entries = [...merged.values()].sort(
    (a, b) => Number(b["hit_count"] ?? 0) - Number(a["hit_count"] ?? 0),
  );
  const result: Array<Record<string, unknown>> = [];
  let total_tokens = 0;
  for (const entry of sorted_entries) {
    const entry_tokens = Math.max(1, Math.floor(String(entry["rel_path"] ?? "").length / 10));
    if (total_tokens + entry_tokens > budget_tokens) {
      break;
    }
    result.push(entry);
    total_tokens += entry_tokens;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Section assembly helpers used by _render.
// ---------------------------------------------------------------------------

export function _cap_line(line: string, max_len = 120): string {
  // Cap a line to max_len characters, truncating with '…' if exceeded.
  return ellipsize(line, max_len);
}

export function _load_task_list(session_id: string): Array<Record<string, string>> {
  // Load TaskList entries for session_id from ~/.claude/tasks/<session_id>/.
  // Empty list on any error.
  let tasks_dir: string;
  try {
    tasks_dir = paths.safeJoin(nodePath.join(paths.claudeConfigDir(), "tasks"), session_id);
  } catch {
    return [];
  }
  let isDir = false;
  try {
    isDir = fs.statSync(tasks_dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return [];
  }

  const results: Array<Record<string, string>> = [];
  try {
    for (const name of fs.readdirSync(tasks_dir).filter((f) => f.endsWith(".json"))) {
      const p = nodePath.join(tasks_dir, name);
      try {
        const raw = fs.readFileSync(p, "utf8");
        const data = JSON.parse(raw) as unknown;
        if (!_isDict(data)) {
          continue;
        }
        const stem = name.replace(/\.json$/, "");
        const task_id = String(data["id"] ?? stem);
        const subject = String(data["subject"] ?? "").trim();
        const status = String(data["status"] ?? "").trim().toLowerCase();
        if (subject && status) {
          results.push({ id: task_id, subject, status });
        }
      } catch {
        _LOG.debug("_load_task_list: skipping malformed task file %s", p);
      }
    }
  } catch {
    _LOG.debug("_load_task_list: error reading tasks dir %s", tasks_dir);
  }
  return results;
}

export function _find_open_questions(edited_file_paths: string[], max_questions = 5): string[] {
  // Extract TODO/FIXME/WHY/HACK/XXX comments from edited files (first 500 lines).
  // Returns up to max_questions "filename:line — TODO: description" strings.
  if (edited_file_paths.length === 0) {
    return [];
  }

  const questions: Array<[string, number, string]> = [];

  for (const filepath of edited_file_paths) {
    try {
      if (!fs.existsSync(filepath)) {
        continue;
      }
      let size: number;
      try {
        size = fs.statSync(filepath).size;
        if (size > 500_000) {
          continue;
        }
      } catch {
        continue;
      }

      let text: string;
      try {
        text = fs.readFileSync(filepath, "utf8");
      } catch {
        continue;
      }

      const lines = text.split("\n").slice(0, 500);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const line_num = i + 1;
        const trimmed = line.trim();
        if (trimmed.startsWith("#") && trimmed.length < 5) {
          continue;
        }

        const m = _OPEN_QUESTION_MARKER_RE.exec(line);
        if (m) {
          const marker = m[1] ?? "";
          let description = (m[2] ?? "").trim();
          if (!description) {
            description = marker;
          }
          description = description.slice(0, 80);
          const rel_path = _basename(filepath);
          const formatted =
            description && description !== marker ? `${marker}: ${description}` : marker;
          questions.push([rel_path, line_num, formatted]);
          continue;
        }

        if (_OPEN_QUESTION_INLINE_RE.test(line) && line.includes("#")) {
          const comment_start = line.indexOf("#");
          const comment = line.slice(comment_start).trim().slice(0, 80);
          const rel_path = _basename(filepath);
          questions.push([rel_path, line_num, comment]);
        }
      }
    } catch {
      continue;
    }
  }

  const seen = new Set<string>();
  const deduped: Array<[string, number, string]> = [];
  for (const [filepath, line_num, desc] of questions) {
    const key = `${filepath} ${line_num}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push([filepath, line_num, desc]);
      if (deduped.length >= max_questions) {
        break;
      }
    }
  }

  return deduped.map(([fp, ln, desc]) => `${fp}:${ln} — ${desc}`);
}

export function _render_tasks_section(tasks: Array<Record<string, string>>, opts: { edited_paths?: Set<string> | null } = {}): string[] {
  // Render a TODOs section: filter to pending/in_progress, cap at
  // _MAX_TODO_ENTRIES, truncate subjects, suppress tasks about edited files.
  const edited_paths = opts.edited_paths ?? null;
  const active_statuses = new Set(["pending", "in_progress", "in-progress"]);
  const active = tasks.filter((t) => active_statuses.has(t["status"] ?? ""));
  if (active.length === 0) {
    return [];
  }

  const _suppress_tokens = new Set<string>();
  if (edited_paths) {
    for (const p of edited_paths) {
      const norm = _norm_key(p);
      const basename = _basename(norm);
      if (basename) {
        _suppress_tokens.add(basename);
      }
      const parts = norm.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length >= 2) {
        _suppress_tokens.add(parts.slice(-2).join("/"));
      }
    }
  }

  const _is_about_edited_file = (subject: string): boolean => {
    if (_suppress_tokens.size === 0) {
      return false;
    }
    const s = subject.toLowerCase();
    return [..._suppress_tokens].some((tok) => s.includes(tok));
  };

  const filtered_active = active.filter((t) => !_is_about_edited_file(t["subject"] ?? ""));
  if (filtered_active.length === 0) {
    return [];
  }

  const lines: string[] = ["**TODOs:**"];
  const shown = filtered_active.slice(0, _MAX_TODO_ENTRIES);
  for (const t of shown) {
    let subject = t["subject"] ?? "";
    subject = ellipsize(subject, _MAX_TODO_SUBJECT_CHARS);
    const status = t["status"] ?? "pending";
    const marker = status === "in_progress" || status === "in-progress" ? "[→]" : "[ ]";
    lines.push(`- ${marker} ${subject}`);
  }

  const overflow = filtered_active.length - shown.length;
  if (overflow > 0) {
    lines.push(`- …+${overflow} more`);
  }

  return lines;
}

export function _apply_section_line_cap(lines: string[], cap: number): string[] {
  // Truncate a section's bullet list to at most cap items, appending a "+N more"
  // tail. cap <= 0 or cap >= items disables the cap.
  if (cap <= 0 || lines.length === 0) {
    return lines;
  }
  if (lines.length <= 1) {
    return lines;
  }
  const item_count = lines.length - 1;
  if (item_count <= cap) {
    return lines;
  }
  const kept_lines = lines.slice(0, cap + 1);
  const overflow = item_count - cap;
  kept_lines.push(`- ... (+${overflow} more)`);
  return kept_lines;
}

function _render_section<E>(header: string, entries: E[], fmt: (e: E) => string): string[] {
  // Render a manifest section as a list of lines. Empty entries -> empty list.
  // Bold-label headers ("**...") are used verbatim; plain headers get "### ".
  if (entries.length === 0) {
    return [];
  }
  const hdr_line = header.startsWith("**") ? header : `### ${header}`;
  const lines: string[] = [hdr_line];
  for (const entry of entries) {
    const line = fmt(entry);
    if (line) {
      lines.push(_cap_line(line));
    }
  }
  return lines;
}

const _SLOW_BASH_THRESHOLD_SECS = 5.0;

function _classify_bash_entry(entry: unknown): string {
  // Return "failed" (exit != 0), "slow" (exit 0 + wall > 5s), or "ok".
  const exit_code = _attr(entry, "exit_code", null);
  if (exit_code !== null && exit_code !== undefined && exit_code !== 0) {
    return "failed";
  }
  const elapsed_ms = _attr(entry, "elapsed_ms", null);
  let elapsed_s: number;
  if (elapsed_ms === null || elapsed_ms === undefined) {
    elapsed_s = Number(_attr(entry, "elapsed_s", 0.0) || 0.0);
  } else {
    const n = Number(elapsed_ms);
    elapsed_s = Number.isFinite(n) ? n / 1000.0 : 0.0;
  }
  if (exit_code === 0 && elapsed_s > _SLOW_BASH_THRESHOLD_SECS) {
    return "slow";
  }
  return "ok";
}

function _render_bash_grouped(
  bash_entries: unknown[],
  budget: number,
  should_inline: (e: unknown) => boolean,
): [string[], number] {
  // Item #28: emit bash entries grouped by exit-code class (failed/slow/ok).
  if (bash_entries.length === 0) {
    return [[], 0];
  }

  const by_class: Record<string, unknown[]> = { failed: [], slow: [], ok: [] };
  for (const be of bash_entries) {
    (by_class[_classify_bash_entry(be)] ?? by_class["ok"]!).push(be);
  }

  const header = "**Recent Commands:**";
  const header_cost = _token_count(header);
  const out: string[] = [header];
  let used = header_cost;

  const only_ok = (by_class["failed"]?.length ?? 0) === 0 && (by_class["slow"]?.length ?? 0) === 0 && (by_class["ok"]?.length ?? 0) > 0;

  const _ORDER: Array<[string, string | null]> = [
    ["failed", "**Failed:**"],
    ["slow", "**Slow:**"],
    ["ok", only_ok ? null : "**Ok:**"],
  ];

  let emitted_any = false;
  for (const [group_key, sub_header] of _ORDER) {
    const group_entries = by_class[group_key] ?? [];
    if (group_entries.length === 0) {
      continue;
    }
    const sub_header_cost = sub_header ? _token_count(sub_header) : 0;
    if (sub_header && used + sub_header_cost > budget) {
      break;
    }

    const group_lines: string[] = [];
    let group_cost = 0;
    for (const be of group_entries) {
      const line = _format_bash_entry(be, should_inline(be));
      const cost = _token_count(line);
      if (used + sub_header_cost + group_cost + cost > budget) {
        break;
      }
      group_lines.push(line);
      group_cost += cost;
    }

    if (group_lines.length === 0) {
      continue;
    }

    if (sub_header) {
      out.push(sub_header);
      used += sub_header_cost;
    }
    out.push(...group_lines);
    used += group_cost;
    emitted_any = true;
  }

  if (!emitted_any) {
    return [[], 0];
  }
  return [out, used];
}

export function _render_budget_lines(
  header: string,
  lines: string[],
  budget: number,
  min_lines = 1,
): [string[], number] {
  // Emit header + as many pre-formatted lines as fit within budget tokens.
  if (lines.length === 0) {
    return [[], 0];
  }
  const header_cost = _token_count(header);
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = _token_count(line);
    if (used + header_cost + cost <= budget) {
      out.push(line);
      used += cost;
    } else {
      break;
    }
  }
  if (out.length < min_lines) {
    return [[], 0];
  }
  return [[header, ...out], used + header_cost];
}

export function _build_sealed_block(
  edited_clean: Record<string, number>,
  blocker_entries: unknown[],
  raw_skills: Record<string, unknown>,
  test_failure_names: string[] | null = null,
  raw_bash: Record<string, unknown> | null = null,
  opts: { session_started_ts?: number } = {},
): string[] {
  // Build the above-the-fold sealed MUST_PRESERVE block. Omitted (empty list)
  // when all five content slots are empty. Bounded at 80 tokens.
  const session_started_ts = opts.session_started_ts ?? 0.0;

  // Slot (a): <=3 edited basenames with edit counts.
  let edit_slot = "";
  let top_edited_basename = "";
  if (Object.keys(edited_clean).length > 0) {
    const top_edits = Object.entries(edited_clean)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const parts: string[] = [];
    for (const [path, count] of top_edits) {
      const basename = sanitize_log_str(_basename(path) || path, 40);
      parts.push(count > 1 ? `${basename}×${count}` : basename);
    }
    edit_slot = "✎ " + parts.join("  ");
    if (top_edits.length > 0) {
      const first = top_edits[0]!;
      top_edited_basename = sanitize_log_str(_basename(first[0]) || first[0], 40);
    }
  }

  // Slot (b): most-recent blocker.
  let blocker_slot = "";
  let blocker_cmd_word = "";
  if (blocker_entries.length > 0) {
    const most_recent = blocker_entries.reduce((a, b) => (_numAttr(b, "ts", 0.0) > _numAttr(a, "ts", 0.0) ? b : a));
    const cmd = sanitize_log_str(_strAttr(most_recent, "cmd_preview"), 70);
    const exit_code = _attr(most_recent, "exit_code", "?");
    const framing = `⛔ ${cmd} — `;
    const room = Math.max(0, 80 - framing.length);
    const preview = room >= 12 ? _extract_blocker_error_preview(most_recent, { max_chars: room }) : "";
    const raw = preview ? `⛔ ${cmd} — ${preview}` : `⛔ ${cmd}  (exit ${exit_code})`;
    blocker_slot = raw.slice(0, 80);
    for (const tok of cmd.split(/\s+/).filter((x) => x !== "")) {
      if (!tok.includes("=") && !tok.startsWith("-")) {
        blocker_cmd_word = sanitize_log_str(tok, 30);
        break;
      }
    }
  }

  // Slot (c): <=2 active skill names.
  let skill_slot = "";
  if (raw_skills && Object.keys(raw_skills).length > 0) {
    const _sealed_top = _select_top_skill_entries(raw_skills, { session_started_ts });
    const top_skills = _sealed_top.slice(0, 2);
    let names = top_skills.map((e) => sanitize_log_str(_strAttr(e, "skill_name"), 40));
    names = names.filter((n) => n);
    if (names.length > 0) {
      skill_slot = "🧠 " + names.join("  ");
    }
  }

  // Slot (d): up to 3 unique test-file paths.
  let fail_files_slot = "";
  if (test_failure_names && test_failure_names.length > 0) {
    const _seen_fail_files = new Set<string>();
    const _fail_file_names: string[] = [];
    for (const _fn of test_failure_names) {
      const _parts = _fn.split("::");
      if (_parts.length > 0) {
        const _fpath = _basename(_parts[0]!);
        if (_fpath && !_seen_fail_files.has(_fpath)) {
          _seen_fail_files.add(_fpath);
          _fail_file_names.push(sanitize_log_str(_fpath, 40));
          if (_fail_file_names.length >= 3) {
            break;
          }
        }
      }
    }
    if (_fail_file_names.length > 0) {
      fail_files_slot = "❌ " + _fail_file_names.join("  ");
    }
  }

  // Slot (e): last _MAX_SEALED_BASH_CMDS bash command previews.
  let bash_cmds_slot = "";
  if (_isDict(raw_bash) && Object.keys(raw_bash).length > 0) {
    const _blocker_oids = new Set(blocker_entries.map((e) => _attr(e, "output_id", null)));
    const _recent_bash = _nlargest(
      _MAX_SEALED_BASH_CMDS,
      Object.values(raw_bash).filter((e) => !_is_noop_bash_command(e) && !_blocker_oids.has(_attr(e, "output_id", null))),
      (e) => _numAttr(e, "ts", 0.0),
    );
    let _bash_previews = _recent_bash.map((e) => sanitize_log_str(_strAttr(e, "cmd_preview"), 40));
    _bash_previews = _bash_previews.filter((p) => p);
    if (_bash_previews.length > 0) {
      bash_cmds_slot = "🕐 " + _bash_previews.join("  ");
    }
  }

  if (!edit_slot && !blocker_slot && !skill_slot && !fail_files_slot && !bash_cmds_slot) {
    return [];
  }

  let resume_slot = "";
  if (top_edited_basename) {
    resume_slot = `🎯 RESUME: ${top_edited_basename}`;
  } else if (blocker_cmd_word) {
    resume_slot = `🎯 RESUME: re-run ${blocker_cmd_word}`;
  }

  const inner = [resume_slot, edit_slot, blocker_slot, skill_slot, fail_files_slot, bash_cmds_slot].filter((s) => s);
  let block = ["### MUST_PRESERVE", "<<preserve>>", ...inner, "<</preserve>>"];

  const block_text = block.join("\n");
  if (_token_count(block_text) > 80) {
    const trimmed_rest = [edit_slot, blocker_slot, skill_slot, fail_files_slot, bash_cmds_slot]
      .filter((line) => line)
      .map((line) => line.slice(0, 60));
    const inner_trimmed = (resume_slot ? [resume_slot] : []).concat(trimmed_rest);
    block = ["### MUST_PRESERVE", "<<preserve>>", ...inner_trimmed, "<</preserve>>"];
    for (const _drop_slot of [
      bash_cmds_slot ? bash_cmds_slot.slice(0, 60) : "",
      fail_files_slot ? fail_files_slot.slice(0, 60) : "",
      skill_slot ? skill_slot.slice(0, 60) : "",
    ]) {
      if (_drop_slot && inner_trimmed.includes(_drop_slot) && _token_count(block.join("\n")) > 80) {
        const idx = inner_trimmed.indexOf(_drop_slot);
        if (idx >= 0) {
          inner_trimmed.splice(idx, 1);
        }
        block = ["### MUST_PRESERVE", "<<preserve>>", ...inner_trimmed, "<</preserve>>"];
      }
    }
  }

  return block;
}

function _apply_noise_floor(
  section_groups: Array<[string, string[], boolean]>,
  noise_floor: number,
): Array<[string, string[], boolean]> {
  // Filter out small unprotected sections when their token count is below the
  // noise floor. Protected sections are always kept. noise_floor <= 0 = no-op.
  if (noise_floor <= 0) {
    return section_groups;
  }

  const filtered: Array<[string, string[], boolean]> = [];
  for (const [name, lines, protectedFlag] of section_groups) {
    if (protectedFlag) {
      filtered.push([name, lines, protectedFlag]);
    } else {
      if (lines.length === 0) {
        continue;
      }
      const section_text = lines.join("\n");
      const section_tokens = _token_count(section_text);
      if (section_tokens >= noise_floor) {
        filtered.push([name, lines, protectedFlag]);
      } else {
        _LOG.debug("_apply_noise_floor: dropped section=%s tokens=%d < floor=%d", name, section_tokens, noise_floor);
      }
    }
  }
  return filtered;
}

export function _render_most_accessed_section(symbol_access_counts: Record<string, number>, max_entries = 5): string[] {
  // Render the "Most Accessed Symbols" section from symbol_access_counts (count
  // >= 2 only). Format: "- Session.refresh (session.py) — 7 reads".
  if (!symbol_access_counts || Object.keys(symbol_access_counts).length === 0) {
    return [];
  }

  const candidates: Array<[string, number]> = Object.entries(symbol_access_counts)
    .map(([key, count]) => [key, Number(count)] as [string, number])
    .filter(([, count]) => count >= 2);
  if (candidates.length === 0) {
    return [];
  }

  candidates.sort((a, b) => b[1] - a[1]);
  const top_symbols = candidates.slice(0, max_entries);

  const lines: string[] = ["### Most Accessed"];
  for (const [key, count] of top_symbols) {
    if (key.includes("::")) {
      const idx = key.lastIndexOf("::");
      const filepath = key.slice(0, idx);
      const symbol = key.slice(idx + 2);
      const basename = _basename(filepath);
      const symbol_safe = sanitize_log_str(symbol, 60);
      lines.push(`- ${symbol_safe} (${basename}) — ${count} reads`);
    } else {
      const key_safe = sanitize_log_str(key, 80);
      lines.push(`- ${key_safe} — ${count} reads`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// _render — the manifest assembler.
// ---------------------------------------------------------------------------

interface RenderKwargs {
  edited_dir_group_threshold?: number;
  max_section_lines?: number;
  noise_floor_tokens?: number;
  wide_session_threshold?: number;
  orchestrator_commit_threshold?: number;
  lazy_skill_injection?: boolean;
  harness?: string;
}

export function _render(
  cache: SessionCache,
  session_id: string,
  max_tokens: number,
  kwargs: RenderKwargs = {},
): [string, number] {
  // Build the Markdown session manifest string from cache for the PreCompact
  // hook. Inverted-pyramid order so truncation hurts least. Returns
  // [manifest_string, files_with_symbols_count].
  const edited_dir_group_threshold = kwargs.edited_dir_group_threshold ?? 3;
  const max_section_lines = kwargs.max_section_lines ?? 0;
  const noise_floor_tokens = kwargs.noise_floor_tokens ?? 0;
  const wide_session_threshold = kwargs.wide_session_threshold ?? 15;
  const orchestrator_commit_threshold = kwargs.orchestrator_commit_threshold ?? 5;
  const lazy_skill_injection = kwargs.lazy_skill_injection ?? true;
  const harness = kwargs.harness ?? "claudecode";

  // Filter noise paths out of both maps before any other work.
  const raw_edited = _isDict(cache.edited_files) ? cache.edited_files : {};
  const _noise_cache = new Map<string, boolean>();
  const _is_noise = (path: string): boolean => {
    let cached = _noise_cache.get(path);
    if (cached === undefined) {
      cached = is_noise_path(path);
      _noise_cache.set(path, cached);
    }
    return cached;
  };

  const edited_clean: Record<string, number> = {};
  for (const [path, count] of Object.entries(raw_edited)) {
    if (!_is_noise(path)) {
      edited_clean[path] = count;
    }
  }
  const files_clean: Record<string, FileEntry> = {};
  for (const [key, entry] of Object.entries(cache.files)) {
    if (!_is_noise(entry.rel_or_abs) && !_is_noise(key)) {
      files_clean[key] = entry;
    }
  }
  const noise_skipped =
    Object.keys(raw_edited).length - Object.keys(edited_clean).length + (Object.keys(cache.files).length - Object.keys(files_clean).length);
  if (noise_skipped) {
    _LOG.debug("_render: filtered %d noise path(s) from manifest input (session=%s)", noise_skipped, session_id.slice(0, 8));
  }

  const raw_greps = (_attr(cache, "greps", null) as unknown[] | null) ?? [];
  const _raw_bash = _attr(cache, "bash_history", null);
  const raw_bash: Record<string, unknown> = _isDict(_raw_bash) ? _raw_bash : {};
  const _raw_web = _attr(cache, "web_history", null);
  const raw_web: Record<string, unknown> = _isDict(_raw_web) ? _raw_web : {};
  const _raw_skills = _attr(cache, "skill_history", null);
  const raw_skills: Record<string, unknown> = _isDict(_raw_skills) ? _raw_skills : {};
  const _raw_decisions = _attr(cache, "decisions", null);
  const raw_decisions_for_activity = Array.isArray(_raw_decisions) ? _raw_decisions : [];
  if (
    Object.keys(edited_clean).length === 0 &&
    Object.keys(files_clean).length === 0 &&
    raw_greps.length === 0 &&
    Object.keys(raw_bash).length === 0 &&
    Object.keys(raw_web).length === 0 &&
    Object.keys(raw_skills).length === 0 &&
    raw_decisions_for_activity.length === 0
  ) {
    _LOG.info(
      "_render: manifest suppressed for session=%s (no activity tracked: edited=0 files_read=0 greps=0 bash=0 skills=0 decisions=0)",
      session_id.slice(0, 8),
    );
    return ["", 0];
  }

  const edited_keys = new Set(Object.keys(edited_clean).map((p) => _norm_key(p)));

  const _created_ts0 = _attr(cache, "created_ts", null);
  const age_secs = _created_ts0 !== null && _created_ts0 !== undefined ? Math.max(0.0, _now() - Number(_created_ts0)) : 0.0;
  const age_tier = _session_age_tier(age_secs);

  const stale_read_files: string[] = [];
  for (const [key, entry] of Object.entries(files_clean)) {
    if (_numAttr(entry, "last_edit_ts", 0.0) > entry.last_read_ts && !edited_keys.has(_norm_key(key))) {
      stale_read_files.push(entry.rel_or_abs);
    }
  }

  const files_with_symbols_all = Object.values(files_clean).filter((e) => e.symbols_read.length > 0);
  const files_with_symbols = _nlargest(_MAX_SYMBOLS_FILES, files_with_symbols_all, (e) => e.last_read_ts);
  const files_with_symbols_count = files_with_symbols.length;

  const now_for_scoring = _now();
  const total_files_read = Object.keys(files_clean).length;
  const key_files_candidates: FileEntry[] = [];
  for (const [key, entry] of Object.entries(files_clean)) {
    if (!edited_keys.has(_norm_key(key))) {
      key_files_candidates.push(entry);
    }
  }
  const edited_keys_set = edited_keys;
  const _n_edited = Object.keys(edited_clean).length;
  let _dynamic_max_files: number;
  if (_n_edited >= 10) {
    _dynamic_max_files = 4;
  } else if (_n_edited >= 5) {
    _dynamic_max_files = 6;
  } else {
    _dynamic_max_files = _MAX_FILES_READ;
  }
  const max_key_files = Math.max(_dynamic_max_files + (age_tier === "mature" ? 2 : 0), _TOP_FILES_GUARANTEED_MIN);
  const top_files = _nlargest(max_key_files, key_files_candidates, (e) =>
    _importance_score(e, now_for_scoring, edited_keys_set.has(_norm_key(e.rel_or_abs)) ? 15.0 : 0.0),
  );
  _LOG.debug(
    "_render: selected top %d/%d files by importance_score (cap=%d); files_with_symbols=%d edited=%d noise_skipped=%d",
    top_files.length,
    total_files_read,
    _MAX_FILES_READ,
    files_with_symbols_count,
    Object.keys(edited_clean).length,
    noise_skipped,
  );

  const cwd = (_attr(cache, "cwd", null) as string | null) ?? null;
  const created_ts = Number(_attr(cache, "created_ts", 0.0));

  const header_lines: string[] = ["## Token-Goat Session Manifest", "manifest_version: 1"];
  const _branch = cwd ? _get_current_branch(cwd) : null;
  if (_branch) {
    header_lines.push(`branch: ${_branch}`);
  }

  const _hint_telemetry = _format_hint_telemetry(cache);
  if (_hint_telemetry) {
    header_lines.push(_hint_telemetry);
  }

  // Pinned symbols.
  const _raw_pinned = _attr(cache, "pinned_symbols", null);
  const pinned_symbols_list: string[] = Array.isArray(_raw_pinned) ? (_raw_pinned as string[]) : [];
  const pinned_lines: string[] = [];
  if (pinned_symbols_list.length > 0) {
    pinned_lines.push("## Pinned");
    for (const _ps of pinned_symbols_list) {
      pinned_lines.push(`- ${_ps}`);
    }
  }

  const _session_stats = _format_session_stats(cache);
  if (_session_stats) {
    header_lines.push(_session_stats);
  }

  // 0. Current Blockers.
  const now_ts_for_blockers = _now();
  const blocker_entries = _select_failed_bash_entries(raw_bash, now_ts_for_blockers);
  const blocker_lines = _render_section("**Blocked:**", blocker_entries, _format_blocker_entry);

  // 0a-bis. Decisions.
  const raw_decisions = _attr(cache, "decisions", null);
  const decision_entries = _select_top_decision_entries(raw_decisions);
  let decision_lines: string[];
  if (decision_entries.length > 0) {
    decision_lines = ["**Decisions:**"];
    for (const _de of decision_entries) {
      decision_lines.push(_format_decision_entry(_de));
    }
    if (Array.isArray(raw_decisions) && raw_decisions.length > decision_entries.length) {
      const overflow_n = raw_decisions.length - decision_entries.length;
      decision_lines.push(`- …+${overflow_n} more — recall via \`token-goat decision --list\``);
    }
  } else {
    decision_lines = [];
  }

  const _session_started_ts = Number(_attr(cache, "started_ts", 0.0) || 0.0);
  const skill_entries = _select_top_skill_entries(raw_skills, { session_started_ts: _session_started_ts });
  let skill_lines: string[];
  if (skill_entries.length > 0) {
    const _skill_parts: string[] = [];
    for (const _se of skill_entries) {
      const _sname = sanitize_log_str(_strAttr(_se, "skill_name"), 40);
      const _src = Math.trunc(_numAttr(_se, "run_count", 1));
      _skill_parts.push(_src > 1 ? `${_sname} ×${_src}` : _sname);
    }
    const _unique_skill_names = new Set(
      Object.values(raw_skills)
        .map((e) => _strAttr(e, "skill_name"))
        .filter((n) => n),
    );
    const overflow_skills = Math.max(0, _unique_skill_names.size - skill_entries.length);
    if (overflow_skills > 0) {
      _skill_parts.push(`+${overflow_skills} more`);
    }
    const _skills_summary = _skill_parts.join(", ");
    skill_lines = [`**Skills:** ${_skills_summary} — recall via \`token-goat skill-body <name>\``];

    const skill_cache = _getSkillCache();

    if (lazy_skill_injection) {
      for (const _se of skill_entries) {
        const _skill_name = sanitize_log_str(_strAttr(_se, "skill_name"), 40);
        if (!_skill_name) {
          continue;
        }
        let _compact_text: string | null = skill_cache ? skill_cache.get_compact(session_id, _skill_name) : null;
        if (!_compact_text && skill_cache) {
          _compact_text = skill_cache.get_compact_any_session(_skill_name);
        }
        if (_compact_text && skill_cache) {
          const _bare_compact = skill_cache._strip_compact_header(_compact_text);
          const _tok_est = Math.max(1, Math.floor(_bare_compact.length / 4));
          const _entry_sha = _strAttr(_se, "content_sha") || "";
          const _compact_sha = skill_cache.extract_compact_source_sha(_compact_text);
          let _stale_ann = "";
          if (_compact_sha && _entry_sha && !_entry_sha.startsWith(_compact_sha)) {
            _stale_ann = " [stale]";
          }
          skill_lines.push(
            `- ${_skill_name} (${_tok_est} tok${_stale_ann}) → \`token-goat skill-body ${_skill_name} --compact\``,
          );
        } else {
          skill_lines.push(`- ${_skill_name} → \`token-goat skill-body ${_skill_name} --compact\``);
        }
      }
    } else {
      let _skills_with_compact: Array<[string, string | null]> = skill_entries
        .map((_se) => [_strAttr(_se, "skill_name"), skill_cache ? skill_cache.get_compact(session_id, _strAttr(_se, "skill_name")) : null] as [string, string | null])
        .filter(([_name]) => _name);
      _skills_with_compact = _skills_with_compact.filter(([, _ct]) => _ct);
      const _n_with_compact = _skills_with_compact.length;
      let _per_skill_chars: number;
      if (_n_with_compact > 0) {
        _per_skill_chars = Math.min(_SKILL_COMPACT_INLINE_MAX_CHARS, Math.floor((_SKILL_INLINE_TOTAL_TOKEN_BUDGET * 3) / _n_with_compact));
      } else {
        _per_skill_chars = _SKILL_COMPACT_INLINE_MAX_CHARS;
      }

      for (const [_skill_name, compact_text_raw] of _skills_with_compact) {
        let compact_text = compact_text_raw;
        if (!compact_text) {
          continue;
        }
        if (compact_text.length > _per_skill_chars) {
          let cut = compact_text.slice(0, _per_skill_chars).lastIndexOf("\n");
          if (cut <= 0) {
            cut = _per_skill_chars;
          }
          compact_text = _rstrip(compact_text.slice(0, cut)) + "…";
        }
        skill_lines.push("");
        skill_lines.push(`**${_skill_name} key-rules:**`);
        for (const line of compact_text.split("\n")) {
          skill_lines.push(`  ${line}`);
        }
        try {
          session.record_skill_compact_hit(session_id, _skill_name);
        } catch {
          // swallow
        }
      }
    }
  } else {
    skill_lines = [];
  }

  // 0c. Recent Test Failures.
  const _test_failure_names = _extract_test_failures(raw_bash);
  const test_failure_lines: string[] = [];
  if (_test_failure_names.length > 0) {
    test_failure_lines.push("### Recent Test Failures");
    for (const _tf of _test_failure_names) {
      test_failure_lines.push(`- ${_tf}`);
    }
  }

  // 0d. Dependency Changes.
  const _dep_changes = _extract_dep_changes(raw_bash);
  const dep_change_lines: string[] = [];
  if (_dep_changes.length > 0) {
    dep_change_lines.push("### Dependency Changes");
    for (const _dc of _dep_changes) {
      dep_change_lines.push(`- ${_dc}`);
    }
  }

  // 0b. Uncommitted Changes.
  const uncommitted_changes = _get_uncommitted_changes(cwd);
  const uncommitted_lines: string[] = [];
  if (uncommitted_changes) {
    uncommitted_lines.push("**Uncommitted:**");
    for (const line of uncommitted_changes.split("\n")) {
      uncommitted_lines.push(`  ${_rstrip(line)}`);
    }
  }

  // 1. Edited files.
  let edited_lines: string[] = [];
  const pending_diff_stat = _get_git_diff_stat_summary(cwd);

  const _edit_ts_by_norm: Record<string, number> = {};
  for (const [key, entry] of Object.entries(files_clean)) {
    const lt = _numAttr(entry, "last_edit_ts", 0.0);
    if (lt > 0.0) {
      _edit_ts_by_norm[_norm_key(key)] = lt;
    }
  }

  const committed_files_norm = _get_committed_files(cache, cwd);

  // Bindings that downstream sections reference; default to safe values for the
  // no-edited-files path (Python relies on `possibly-undefined` semantics gated
  // by `if edited_clean`; here we initialise explicitly).
  let session_commits: string[] = [];
  let sorted_edited: Array<[string, number]> = [];
  let _inline_diffs_were_emitted = false;
  let _inlined_paths: Set<string> = new Set();
  let _tracked_edits: Record<string, number> = {};

  if (Object.keys(edited_clean).length > 0) {
    const uncommitted_edits: Record<string, number> = {};
    const committed_edits: Record<string, number> = {};
    for (const [path, count] of Object.entries(edited_clean)) {
      if (!committed_files_norm.has(_norm_key(path))) {
        uncommitted_edits[path] = count;
      } else {
        committed_edits[path] = count;
      }
    }

    sorted_edited = Object.entries(edited_clean).sort((a, b) => {
      const ta = _edit_ts_by_norm[_norm_key(a[0])] ?? 0.0;
      const tb = _edit_ts_by_norm[_norm_key(b[0])] ?? 0.0;
      if (ta !== tb) {
        return tb - ta;
      }
      return b[1] - a[1];
    });
    const shown_edited = sorted_edited.slice(0, _MAX_EDITED_FILES_SHOWN);
    const overflow_edited = sorted_edited.length - shown_edited.length;

    const shown_uncommitted = shown_edited.filter((item) => !committed_files_norm.has(_norm_key(item[0])));
    const shown_committed = shown_edited.filter((item) => committed_files_norm.has(_norm_key(item[0])));

    if (Object.keys(uncommitted_edits).length > 0) {
      edited_lines.push("**Staged/Uncommitted:**");
      _tracked_edits = uncommitted_edits;
    } else if (Object.keys(committed_edits).length > 0) {
      edited_lines.push("**Edited:** All edits committed — see git log");
      _tracked_edits = {};
    } else {
      _tracked_edits = {};
    }

    if (Object.keys(uncommitted_edits).length > 0 && Object.keys(committed_edits).length > 0 && shown_committed.length > 0) {
      edited_lines.push("**Committed This Session:**");
      for (const [path, count] of shown_committed) {
        const short = _short_path(path, 70, cwd);
        const suffix = _count_suffix(count);
        edited_lines.push(`- ${short}${suffix}`);
      }
      const overflow_committed =
        sorted_edited.filter((item) => committed_files_norm.has(_norm_key(item[0]))).length - shown_committed.length;
      if (overflow_committed > 0) {
        edited_lines.push(`- …+${overflow_committed} more committed`);
      }
    }

    // #17: single-file inline diff.
    const _files_to_render = Object.keys(uncommitted_edits).length > 0 ? shown_uncommitted : shown_edited;

    let _single_file_diff_used = false;
    if (_files_to_render.length === 1 && cwd) {
      const _only = _files_to_render[0]!;
      const _whole_diff = _get_whole_repo_diff(cwd);
      if (_whole_diff) {
        edited_lines.push(`#### ${_short_path(_only[0], 70, cwd)} (inline diff)`);
        for (const _dl of _whole_diff.split("\n")) {
          edited_lines.push(`  ${_dl}`);
        }
        _single_file_diff_used = true;
        _inline_diffs_were_emitted = true;
      }
    }

    if (!_single_file_diff_used) {
      // #7: per-file inline diffs for top 2.
      let _inline_budget = _INLINE_DIFF_TOTAL_CAP;
      _inlined_paths = new Set<string>();
      if (cwd && _files_to_render.length >= 1) {
        for (const [_ip, _ic] of _files_to_render.slice(0, 2)) {
          if (_inline_budget <= 0) {
            break;
          }
          const _idiff = _get_inline_diff_for_file(_ip, cwd);
          if (_idiff && _idiff.length <= _inline_budget) {
            edited_lines.push(`#### ${_short_path(_ip, 70, cwd)}${_count_suffix(_ic)} (inline diff)`);
            for (const _dl of _idiff.split("\n")) {
              edited_lines.push(`  ${_dl}`);
            }
            _inlined_paths.add(_ip);
            _inline_budget -= _idiff.length;
            _inline_diffs_were_emitted = true;
          }
        }
      }

      const remaining_shown = _files_to_render.filter((item) => !_inlined_paths.has(item[0]));
      if (remaining_shown.length > 0) {
        let _adaptive_threshold = edited_dir_group_threshold;
        if (remaining_shown.length >= 15) {
          _adaptive_threshold = Math.max(2, edited_dir_group_threshold - 1);
        }
        const grouped_lines = _group_edited_by_dir(remaining_shown, cwd, _adaptive_threshold);
        edited_lines.push(...grouped_lines);
      }
    } else {
      _inlined_paths = new Set();
    }

    if (overflow_edited > 0 && Object.keys(_tracked_edits).length > 0) {
      edited_lines.push(`- …+${overflow_edited} more staged/uncommitted`);
    }

    // 1a. Pending Changes.
    const _skip_pending = _inline_diffs_were_emitted && _inlined_paths.size >= Object.keys(_tracked_edits).length - 1;
    if (pending_diff_stat && !_skip_pending) {
      edited_lines.push("**Pending:**");
      for (const line of pending_diff_stat.split("\n")) {
        edited_lines.push(`  ${line}`);
      }
    }

    // 1b. Diff summary + Commits this session.
    const edited_paths = Object.keys(uncommitted_edits).length > 0 ? Object.keys(uncommitted_edits) : Object.keys(edited_clean);
    const diff_stat = _get_git_diff_stat(edited_paths, cwd);
    session_commits = created_ts > 0 ? _get_session_commits(cwd, created_ts) : [];

    const stash_count = cwd ? _get_stash_count(cwd) : 0;
    if (stash_count > 0) {
      edited_lines.push(`**Stashes:** ${stash_count}  (run \`git stash list\` to inspect)`);
    }

    if (diff_stat) {
      edited_lines.push("### Diff Summary");
      for (const line of diff_stat.split("\n")) {
        edited_lines.push(`- ${line}`);
      }
    }

    if (session_commits.length > 0) {
      edited_lines.push("### Commits This Session");
      edited_lines.push(...session_commits);
    }
  }

  // 1c-bis. Recent Branch Commits.
  const _session_commits_for_branch = Object.keys(edited_clean).length > 0 ? session_commits : [];
  const _need_branch_context = _session_commits_for_branch.length < 2 && age_tier !== "young";
  const recent_branch_commit_lines: string[] = [];
  if (_need_branch_context && cwd && _is_git_repo(cwd)) {
    const _branch_commits = _get_recent_commits_for_orchestrator(cwd, 3);
    if (_branch_commits.length > 0) {
      recent_branch_commit_lines.push("### Recent Branch Commits");
      for (const line of _branch_commits) {
        recent_branch_commit_lines.push(`  ${line}`);
      }
    }
  }

  // 1d. Stale file snapshots.
  const stale_lines = _render_section("Outdated File Snapshots", stale_read_files.slice(0, 6), (path) => `- ⚠ ${_short_path(path, 70, cwd)}`);

  // 1e. Most accessed symbols.
  const raw_symbol_access = (_attr(cache, "symbol_access_counts", null) as Record<string, number> | null) ?? {};
  const most_accessed_lines = _render_most_accessed_section(raw_symbol_access, 5);

  // Compute sealed block early (deducted from the section-budget pool).
  const sealed_block = _build_sealed_block(edited_clean, blocker_entries, raw_skills, _test_failure_names, raw_bash, {
    session_started_ts: _session_started_ts,
  });
  const sealed_tokens = sealed_block.length > 0 ? _token_count(sealed_block.join("\n")) : 0;

  const fixed_text = header_lines
    .concat(pinned_lines, blocker_lines, decision_lines, skill_lines, test_failure_lines, dep_change_lines, uncommitted_lines, edited_lines, recent_branch_commit_lines, stale_lines)
    .join("\n");
  const fixed_tokens = _token_count(fixed_text) + sealed_tokens;

  const section_content_counts: Record<string, number> = {
    symbols: files_with_symbols.length,
    files: top_files.length,
    greps: raw_greps.length,
    bash: Object.keys(raw_bash).length,
    web: Object.keys(raw_web).length,
    glob: ((_attr(cache, "glob_history", null) as unknown[] | null) ?? []).length,
  };

  const _SECTION_BUDGET_SAFETY_FACTOR = 0.85;
  const sec_budget_max = Math.max(1, Math.trunc(max_tokens * _SECTION_BUDGET_SAFETY_FACTOR));
  const sec_budgets = _section_budgets(sec_budget_max, fixed_tokens, section_content_counts);
  _LOG.debug(
    "_render: fixed_tokens=%d section_budgets=%o content_counts=%o (max_tokens=%d sec_budget_max=%d) (session=%s)",
    fixed_tokens,
    sec_budgets,
    section_content_counts,
    max_tokens,
    sec_budget_max,
    session_id.slice(0, 8),
  );

  // 2. Symbols accessed.
  const sym_budget = sec_budgets["symbols"] ?? 0;
  const _wide_session = Object.keys(cache.files).length >= wide_session_threshold;
  let _syms_protected = false;
  let sym_lines: string[];
  let sym_used: number;
  if (_wide_session) {
    const _wide_line = `**Symbols Accessed:** ${Object.keys(cache.files).length} files accessed — use \`token-goat map --compact\` to re-orient.`;
    const _wide_cost = _token_count(_wide_line);
    const _pointer_budget = sec_budget_max >= _WIDE_POINTER_MIN_SECTION_BUDGET ? Math.max(sym_budget, _wide_cost) : sym_budget;
    sym_lines = _wide_cost <= _pointer_budget ? [_wide_line] : [];
    sym_used = sym_lines.length > 0 ? _wide_cost : 0;
    _syms_protected = sym_lines.length > 0;
  } else {
    const _top_files_paths_norm = new Set(top_files.map((e) => _norm_key(_strAttr(e, "rel_or_abs"))));

    const _global_symbol_refs = _dedup_symbols_across_files(files_with_symbols, now_for_scoring);

    const _budget_tight = sym_budget < 80;
    const _stale_threshold_secs = _budget_tight ? 3600 : Infinity;

    const _readonly_symbol_files: FileEntry[] = [];
    for (const entry of files_with_symbols) {
      const entry_norm = _norm_key(entry.rel_or_abs);
      if (!edited_keys.has(entry_norm)) {
        _readonly_symbol_files.push(entry);
      }
    }
    const _prioritized_symbol_files = _readonly_symbol_files;

    const sym_formatted: string[] = [];
    let _suppressed_sym_files = 0;
    for (const entry of _prioritized_symbol_files) {
      const _entry_path_norm = _norm_key(entry.rel_or_abs);
      if (_top_files_paths_norm.has(_entry_path_norm)) {
        _suppressed_sym_files += 1;
        continue;
      }
      const ranked_symbols = _rank_symbols_by_recency(entry, now_for_scoring);
      const _seen_syms = new Set<string>();
      const deduped_symbols = ranked_symbols.filter((s) => {
        if (_seen_syms.has(s)) {
          return false;
        }
        _seen_syms.add(s);
        return true;
      });

      const filtered_symbols = deduped_symbols.filter((s) => (_global_symbol_refs.get(s)?.[0] ?? "") === entry.rel_or_abs);

      let final_symbols = filtered_symbols;
      let stale_removed = 0;
      if (_budget_tight) {
        const symbols_ts = (_attr(entry, "symbols_ts", null) as Record<string, unknown> | null) ?? {};
        const fresh_symbols = filtered_symbols.filter(
          (s) => now_for_scoring - Number(_isDict(symbols_ts) ? (symbols_ts[s] ?? 0.0) : 0.0) < _stale_threshold_secs,
        );
        stale_removed = filtered_symbols.length - fresh_symbols.length;
        final_symbols = fresh_symbols;
      }

      const grouped_symbols = _collapse_class_methods(final_symbols);

      const dupes_removed = ranked_symbols.length - deduped_symbols.length;
      const cross_file_dupes = deduped_symbols.length - filtered_symbols.length - stale_removed;
      const syms = grouped_symbols.slice(0, _MAX_SYMBOLS_PER_FILE_ENTRY).map((s) => sanitize_log_str(s, 80));
      const overflow = grouped_symbols.length - _MAX_SYMBOLS_PER_FILE_ENTRY;
      const dupe_note = dupes_removed >= 3 ? ` (+${dupes_removed} dupes)` : "";
      const xfile_note = cross_file_dupes >= 1 ? ` (-${cross_file_dupes} xfile)` : "";
      const stale_note = stale_removed >= 1 ? ` (-${stale_removed} stale)` : "";
      const sym_str = syms.join(", ") + (overflow > 0 ? ` +${overflow}` : "") + dupe_note + xfile_note + stale_note;
      sym_formatted.push(`- ${_short_path(entry.rel_or_abs, 70, cwd)} → ${sym_str}`);
    }
    if (_suppressed_sym_files) {
      _LOG.debug("_render: suppressed %d symbol-detail line(s) for files in **Files:** (item #8)", _suppressed_sym_files);
    }
    [sym_lines, sym_used] = _render_budget_lines("**Symbols Accessed:**", sym_formatted, sym_budget);
  }

  // 3. Bash history.
  const bash_budget = sec_budgets["bash"] ?? 0;
  const _all_bash_entries = age_tier !== "young" ? _select_top_bash_entries(_attr(cache, "bash_history", null)) : [];
  const _blocker_ids = new Set(blocker_entries.map((e) => _attr(e, "output_id", null)));
  const _dedup_emitted_raw = _attr(cache, "bash_dedup_emitted_ids", null);
  const _dedup_emitted_ids: Set<unknown> =
    _dedup_emitted_raw instanceof Set ? _dedup_emitted_raw : new Set(Array.isArray(_dedup_emitted_raw) ? (_dedup_emitted_raw as unknown[]) : []);
  let bash_entries = _all_bash_entries.filter(
    (e) => !_blocker_ids.has(_attr(e, "output_id", null)) && !_dedup_emitted_ids.has(_attr(e, "output_id", null)),
  );
  const _blocker_ids_for_snippet = new Set(blocker_entries.map((e) => _attr(e, "output_id", null)));
  const _should_inline = (be: unknown): boolean => {
    const oid = _attr(be, "output_id", null);
    if (oid && _blocker_ids_for_snippet.has(oid)) {
      return true;
    }
    const total = Math.trunc(_numAttr(be, "stdout_bytes", 0)) + Math.trunc(_numAttr(be, "stderr_bytes", 0));
    return total >= 600;
  };

  let [bash_lines, bash_used] = _render_bash_grouped(bash_entries, bash_budget, _should_inline);

  // 3a. What Worked.
  const _what_worked_exclude = new Set<unknown>([..._blocker_ids, ..._dedup_emitted_ids]);
  const _what_worked_entries = _select_what_worked(raw_bash, _what_worked_exclude);
  const now_ts_for_worked = _now();
  let what_worked_lines = _render_what_worked_section(_what_worked_entries, now_ts_for_worked);

  // Orchestrator mode override.
  const _orchestrator_mode = _detect_orchestrator_mode(cache, cwd, orchestrator_commit_threshold);
  if (_orchestrator_mode) {
    const _orch_total_raw =
      cwd && created_ts && created_ts > 0 ? _run_git(["log", "--oneline", `--since=${Math.trunc(created_ts)}`], cwd, 3) : null;
    const _orch_total_count = (_orch_total_raw ?? "").split("\n").filter((ln) => ln.trim()).length;
    const _orch_header_line = `⚙ Orchestrator session detected (${_orch_total_count} commits)`;
    const _orch_commits = _get_recent_commits_for_orchestrator(cwd, 10);
    sym_lines = [_orch_header_line, "### Recent Commits"];
    sym_lines.push(..._orch_commits);
    sym_used = _token_count(sym_lines.join("\n"));
    _syms_protected = false;
    bash_lines = [];
    bash_used = 0;
    what_worked_lines = [];
    _LOG.info("_render: orchestrator mode active session=%s commits=%d edited=%d", session_id.slice(0, 8), _orch_total_count, Object.keys(edited_clean).length);
  }

  // Cold outputs (grouped with bash; mature sessions only).
  const now_ts = _now();
  const bash_hist_raw = age_tier === "mature" ? (_attr(cache, "bash_history", null) as Record<string, unknown> | null) ?? {} : {};
  const cold_candidates = Object.values(bash_hist_raw)
    .filter(
      (be) =>
        now_ts - _numAttr(be, "ts", now_ts) > _COLD_OUTPUT_AGE_SECS &&
        _numAttr(be, "stdout_bytes", 0) + _numAttr(be, "stderr_bytes", 0) >= _MIN_BASH_BYTES_FOR_MANIFEST &&
        _attr(be, "exit_code", 0) === 0,
    )
    .sort((a, b) => _numAttr(b, "ts", 0.0) - _numAttr(a, "ts", 0.0));
  const cold_outputs: unknown[] = [];
  if (cold_candidates.length > 0) {
    const cold_header = "**Cold:** evict, recall via `token-goat bash-output <id>`";
    const cold_header_cost = _token_count(cold_header);
    if (bash_used + cold_header_cost <= bash_budget) {
      const cold_content_lines: string[] = [];
      let cold_content_used = 0;
      for (const be of cold_candidates.slice(0, _MAX_COLD_OUTPUTS)) {
        const age_min = Math.trunc((now_ts - _numAttr(be, "ts", now_ts)) / 60);
        const total = _numAttr(be, "stdout_bytes", 0) + _numAttr(be, "stderr_bytes", 0);
        const oid = _short_id(sanitize_log_str(_strAttr(be, "output_id") || "?", 64));
        const prev = sanitize_log_str(_strAttr(be, "cmd_preview") || "?", 60);
        const line = `- ❄ \`${prev}\` (${_humanize_bytes(total)}, ${age_min}min old, ${oid})`;
        const cost = _token_count(line);
        if (bash_used + cold_header_cost + cold_content_used + cost > bash_budget) {
          break;
        }
        cold_content_lines.push(line);
        cold_content_used += cost;
        cold_outputs.push(be);
      }
      if (cold_outputs.length >= 2) {
        bash_lines.push(cold_header);
        bash_used += cold_header_cost;
        bash_lines.push(...cold_content_lines);
        bash_used += cold_content_used;
        const dropped_cold = cold_candidates.length - cold_outputs.length;
        if (dropped_cold > 0 && bash_used < bash_budget) {
          const overflow_line = `- …+${dropped_cold} more cold outputs`;
          if (bash_used + _token_count(overflow_line) <= bash_budget) {
            bash_lines.push(overflow_line);
          }
        }
      }
    }
  }

  // 3b. Web fetches.
  const web_budget = sec_budgets["web"] ?? 0;
  const web_entries = age_tier !== "young" ? _select_top_web_entries(raw_web) : [];
  const [web_lines, web_used] = _render_budget_lines(
    "**Web Fetches:**",
    web_entries.length > 0 ? _group_web_entries_by_domain(web_entries) : [],
    web_budget,
  );

  // 4. Grep patterns.
  const grep_budget = sec_budgets["greps"] ?? 0;
  const _raw_grep_counts: Record<string, number> = {};
  for (const _rg of raw_greps) {
    const _rp = _strAttr(_rg, "pattern");
    if (_rp) {
      _raw_grep_counts[_rp] = (_raw_grep_counts[_rp] ?? 0) + 1;
    }
  }
  let grep_entries = _dedup_grep_entries(_select_top_grep_entries(raw_greps), _raw_grep_counts);
  const _all_grep_zero = grep_entries.length > 0 && grep_entries.every((g) => (Number(_attr(g, "result_count", 0)) || 0) === 0);
  if (_all_grep_zero && age_secs > 300) {
    grep_entries = [];
  }
  const [grep_lines, grep_used] = _render_budget_lines("**Patterns Searched:**", grep_entries.map((ge) => _format_grep_entry(ge)), grep_budget);
  if (grep_lines.length > 0) {
    const included_greps = grep_lines.length - 1;
    const dropped_greps = grep_entries.length - included_greps;
    if (dropped_greps > 0) {
      const overflow_line = `- …+${dropped_greps} more patterns`;
      if (grep_used + _token_count(overflow_line) <= grep_budget) {
        grep_lines.push(overflow_line);
      }
    }
  }

  // 4b. Glob scans.
  const glob_budget = sec_budgets["glob"] ?? 0;
  let glob_lines: string[] = [];
  let glob_used = 0;
  const glob_entries = age_tier !== "young" ? _select_top_glob_entries(_attr(cache, "glob_history", null)) : [];
  glob_lines = _render_section("Directory Scans", glob_entries, (e) => _format_glob_entry(e, { cwd }));
  if (glob_lines.length > 0) {
    const content_lines = glob_lines.length - 1;
    if (content_lines < 2) {
      glob_lines = [];
      glob_used = 0;
    } else {
      glob_used = _token_count(glob_lines.join("\n"));
      if (glob_used > glob_budget) {
        glob_lines = [];
        glob_used = 0;
      }
    }
  }

  // 5. Key files read.
  const files_budget = sec_budgets["files"] ?? 0;
  let files_lines: string[] = [];
  let files_core_lines: string[] = [];
  let files_used = 0;
  const included_top_files: FileEntry[] = [];

  if (top_files.length > 0) {
    const header = "**Files:**";
    const header_cost = _token_count(header);
    const files_entries_for_section: string[] = [];

    const hot_files = top_files.filter((e) => e.read_count >= _HOT_FILE_READ_THRESHOLD);
    let _score_map: Map<string, number> = new Map();
    if (cwd !== null) {
      try {
        _score_map = db.get_entry_scores(_project_hash_fn(_canonicalize(cwd)));
      } catch {
        // swallow
      }
    }
    const _normal_candidates = top_files.filter((e) => e.read_count < _HOT_FILE_READ_THRESHOLD);
    let normal_files: FileEntry[];
    if (_score_map.size > 0) {
      normal_files = [..._normal_candidates].sort((a, b) => (_score_map.get(b.rel_or_abs) ?? 0.0) - (_score_map.get(a.rel_or_abs) ?? 0.0));
    } else {
      normal_files = [..._normal_candidates].sort((a, b) => {
        const la = a.rel_or_abs.toLowerCase();
        const lb = b.rel_or_abs.toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
      });
    }

    if (hot_files.length > 0) {
      const shown = hot_files.slice(0, _HOT_FILE_MAX_SHOWN);
      const overflow = hot_files.length - _HOT_FILE_MAX_SHOWN;
      const name_parts = shown.map((e) => `${_basename(e.rel_or_abs)}${_count_suffix(e.read_count)}`);
      let hot_line_text = "Hot (5+×): " + name_parts.join(", ");
      if (overflow > 0) {
        hot_line_text += ` +${overflow} more`;
      }
      const hot_line = `- → ${hot_line_text}`;
      const cost = _token_count(hot_line);
      files_entries_for_section.push(hot_line);
      files_used += cost;
      included_top_files.push(...shown);
    }

    // Item #37: symbol lookup for files whose symbol lines were suppressed.
    const _symbols_by_norm_path = new Map<string, string[]>();
    for (const _sym_entry of files_with_symbols_all) {
      const _entry_norm = _norm_key(_sym_entry.rel_or_abs);
      if (!edited_keys.has(_entry_norm)) {
        const _ranked = _rank_symbols_by_recency(_sym_entry, now_for_scoring);
        const _seen = new Set<string>();
        const _deduped = _ranked.filter((s) => {
          if (_seen.has(s)) {
            return false;
          }
          _seen.add(s);
          return true;
        });
        if (_deduped.length > 0) {
          _symbols_by_norm_path.set(_entry_norm, _deduped);
        }
      }
    }

    for (const entry of normal_files) {
      const ranges_str = _format_ranges(entry.line_ranges);
      const read_annotation = entry.read_count >= 3 ? ` (read ${entry.read_count}x)` : "";
      let _sym_suffix = "";
      if (entry.read_count >= 3) {
        const _file_syms = _symbols_by_norm_path.get(_norm_key(entry.rel_or_abs)) ?? [];
        if (_file_syms.length > 0) {
          const _top_syms = _file_syms.slice(0, 3).map((s) => sanitize_log_str(s, 50));
          _sym_suffix = ": " + _top_syms.join(", ");
        }
      }
      const line = `- → ${_short_path(entry.rel_or_abs, 80, cwd)}${read_annotation}${_sym_suffix}${ranges_str}`;
      const cost = _token_count(line);
      const total_included = included_top_files.length;
      const within_guarantee = total_included < _TOP_FILES_GUARANTEED_MIN;
      if (!within_guarantee && files_used + header_cost + cost > files_budget) {
        break;
      }
      files_entries_for_section.push(line);
      files_used += cost;
      included_top_files.push(entry);
    }

    if (files_entries_for_section.length > 0) {
      const core_entry_count = Math.min(_TOP_FILES_GUARANTEED_MIN, files_entries_for_section.length);
      const core_entries = files_entries_for_section.slice(0, core_entry_count);
      const rest_entries = files_entries_for_section.slice(core_entry_count);
      files_core_lines.push(header);
      files_core_lines.push(...core_entries);
      files_used += header_cost;
      if (rest_entries.length > 0) {
        files_lines.push(...rest_entries);
      }
    }
  }

  // 6b. TODOs.
  const raw_tasks = _load_task_list(session_id);
  const todo_lines = _render_tasks_section(raw_tasks, {
    edited_paths: Object.keys(edited_clean).length > 0 ? new Set(Object.keys(edited_clean)) : null,
  });

  // 6b.5. Session Goal.
  let session_goal_lines: string[] = [];
  const _session_goal = infer_session_goal(cache);
  if (_session_goal) {
    session_goal_lines = [`**Session goal:** ${_session_goal}`];
  }

  // 6c. Open Questions.
  const open_questions_lines: string[] = [];
  if (Object.keys(edited_clean).length > 0) {
    const questions = _find_open_questions(Object.keys(edited_clean), 5);
    if (questions.length > 0) {
      open_questions_lines.push("### Open Questions");
      for (const q of questions) {
        open_questions_lines.push(`- ${q}`);
      }
    }
  }

  // 6d. Active Errors.
  const active_errors_lines = _render_active_errors_section(session_id, 3);

  // Item #16 — Merge Files Edited + Key Files Read when overlap >= 50%.
  const _all_read_paths_norm = new Set(Object.keys(files_clean).map((key) => _norm_key(key)));
  const _edited_paths_norm = new Map<string, string>();
  for (const p of Object.keys(edited_clean)) {
    _edited_paths_norm.set(_norm_key(p), p);
  }
  const _overlap_set = new Set([..._edited_paths_norm.keys()].filter((k) => _all_read_paths_norm.has(k)));
  const _overlap_ratio = _overlap_set.size / Math.max(Object.keys(edited_clean).length, 1);
  const _do_merge =
    _overlap_ratio >= 0.5 && Object.keys(edited_clean).length > 0 && included_top_files.length > 0 && !_inline_diffs_were_emitted;
  if (_do_merge) {
    const merged_entries: string[] = [];
    const _read_count_map = new Map<string, FileEntry>();
    for (const entry of included_top_files) {
      _read_count_map.set(_norm_key(entry.rel_or_abs), entry);
    }
    const _files_clean_norm = new Map<string, FileEntry>();
    for (const [key, entry] of Object.entries(files_clean)) {
      _files_clean_norm.set(_norm_key(key), entry);
    }
    for (const [_ep, _ec] of sorted_edited) {
      const _ep_norm = _norm_key(_ep);
      const _re = _read_count_map.get(_ep_norm) ?? _files_clean_norm.get(_ep_norm);
      const _rc = _re ? _re.read_count : 0;
      let _annotation = _ec > 1 ? `✎×${_ec}` : "✎";
      if (_rc > 0) {
        _annotation += ` →×${_rc}`;
      }
      merged_entries.push(`- ${_short_path(_ep, 70, cwd)} ${_annotation}`);
    }
    const _edited_norm_set = new Set(_edited_paths_norm.keys());
    for (const _re of included_top_files) {
      const _rp_norm = _norm_key(_re.rel_or_abs);
      if (!_edited_norm_set.has(_rp_norm)) {
        const _rc = _re.read_count;
        const _annotation = _rc > 1 ? `→×${_rc}` : "→";
        merged_entries.push(`- ${_short_path(_re.rel_or_abs, 70, cwd)} ${_annotation}`);
      }
    }
    const _merged_section_lines = ["**Files:**", ...merged_entries];
    const _edited_subsections: string[] = [];
    let _in_subsection = false;
    for (const _el of edited_lines) {
      if (_el.startsWith("**Pending:**") || _el.startsWith("### Diff Summary") || _el.startsWith("### Commits This Session")) {
        _in_subsection = true;
      }
      if (_in_subsection) {
        _edited_subsections.push(_el);
      }
    }
    edited_lines = _merged_section_lines.concat(_edited_subsections);
    files_lines = [];
    files_core_lines = [];
  }

  // Legend.
  const has_edit = Object.keys(edited_clean).length > 0;
  const has_read = included_top_files.length > 0 || sym_lines.length > 0;
  const has_stale = stale_read_files.length > 0;
  const has_cold = cold_outputs.length > 0;
  const has_skill = skill_lines.length > 0;
  const legend_parts: string[] = [];
  if (has_edit) {
    legend_parts.push("edited=✎");
  }
  if (has_read) {
    legend_parts.push("read=→");
  }
  if (has_stale) {
    legend_parts.push("stale=⚠");
  }
  if (has_cold) {
    legend_parts.push("cold=❄");
  }
  if (has_skill) {
    legend_parts.push("skill=🧠");
  }

  // Section assembly with truncation priority.
  let _section_groups: Array<[string, string[], boolean]> = [
    ["sealed", sealed_block, true],
    ["header", header_lines, true],
    ["pinned", pinned_lines, true],
    ["blockers", blocker_lines, true],
    ["decisions", decision_lines, true],
    ["test_failures", test_failure_lines, true],
    ["uncommitted", uncommitted_lines, true],
    ["edited", edited_lines, true],
    ["recent_commits", recent_branch_commit_lines, false],
    ["stale", stale_lines, false],
    ["most_accessed", most_accessed_lines, false],
    ["session_goal", session_goal_lines, false],
    ["bash", bash_lines, false],
    ["what_worked", what_worked_lines, false],
    ["syms", sym_lines, _syms_protected],
    ["web", web_lines, false],
    ["glob", glob_lines, false],
    ["dep_changes", dep_change_lines, false],
    ["grep", grep_lines, false],
    ["todos", todo_lines, true],
    ["files_core", files_core_lines, true],
    ["files", files_lines, false],
    ["open_questions", open_questions_lines, false],
    ["active_errors", active_errors_lines, false],
    ["skills", skill_lines, true],
  ];

  // Harness-specific section filtering.
  if (harness === "codex") {
    _section_groups = _section_groups.filter(([name]) => name !== "skills" && name !== "decisions");
    _LOG.debug("_render: codex harness — skipped skills and decisions sections");
  } else if (harness === "opencode") {
    const _new_header = [...header_lines];
    _new_header.splice(1, 0, "### harness: opencode");
    _section_groups = _section_groups.map(([name, lines, prot]) => (name === "header" ? [name, _new_header, prot] : [name, lines, prot]) as [string, string[], boolean]);
    _LOG.debug("_render: opencode harness — injected harness tag into header");
  } else if (harness === "generic") {
    const _GENERIC_KEEP = new Set(["sealed", "header", "uncommitted", "edited", "syms"]);
    _section_groups = _section_groups.filter(([name]) => _GENERIC_KEEP.has(name));
    _LOG.debug("_render: generic harness — keeping only minimal sections");
  }

  _section_groups = _apply_noise_floor(_section_groups, noise_floor_tokens);
  const max_section_lines_cap = max_section_lines;

  if (max_section_lines_cap > 0) {
    for (let idx = 0; idx < _section_groups.length; idx++) {
      const [_name, _lines, _protected] = _section_groups[idx]!;
      if (!_protected && (_name === "edited" || _name === "files" || _name === "syms")) {
        _section_groups[idx] = [_name, _apply_section_line_cap(_lines, max_section_lines_cap), _protected];
      }
    }
  }

  let sections: string[] = [];
  for (const [, _lines] of _section_groups) {
    sections.push(..._lines);
  }
  let legend_line: string | null = null;
  if (legend_parts.length === 1) {
    legend_line = legend_parts[0]!;
  } else if (legend_parts.length >= 2) {
    legend_line = "Legend: " + legend_parts.join("  ");
  }
  if (legend_line !== null) {
    sections.push(legend_line);
  }

  // Common prefix stripping.
  const path_lines = sections.filter((line) => _extract_path_from_line(line) !== null);
  const paths_only: string[] = [];
  for (const line of path_lines) {
    const p = _extract_path_from_line(line);
    if (p !== null) {
      paths_only.push(p);
    }
  }
  let _applied_prefix: string | null = null;
  if (path_lines.length >= 3 && paths_only.length > 0) {
    const common_prefix = _find_common_prefix(paths_only);
    if (common_prefix && common_prefix.length >= 6 && paths_only.length >= Math.trunc(path_lines.length * 0.7)) {
      sections = _strip_common_prefix_from_sections(sections, common_prefix);
      _applied_prefix = common_prefix;
    }
  }

  let result = sections.map((l) => l).join("\n").replace(/\s+$/, "");
  const token_count = estimate_tokens(result);
  _LOG.debug(
    "_render: manifest assembled for session=%s; ~%d tokens (budget=%d) sym=%d bash=%d web=%d glob=%d grep=%d files=%d",
    session_id.slice(0, 8),
    token_count,
    max_tokens,
    sym_used,
    bash_used,
    web_used,
    glob_used,
    grep_used,
    files_used,
  );

  // Safety net: priority-aware section truncation.
  if (token_count > max_tokens) {
    _LOG.info("_render: safety trim for session=%s (%d tokens > %d budget)", session_id.slice(0, 8), token_count, max_tokens);

    const _assemble = (live_groups: Array<[string, string[], boolean]>): string => {
      let body: string[] = [];
      for (const [, _lines] of live_groups) {
        body.push(..._lines);
      }
      if (legend_line !== null) {
        body.push(legend_line);
      }
      if (_applied_prefix) {
        body = _strip_common_prefix_from_sections(body, _applied_prefix);
      }
      return body.join("\n").replace(/\s+$/, "");
    };

    const _truncate_section_lines = (lines: string[], keep_items = 3): string[] => {
      if (lines.length <= keep_items + 1) {
        return lines;
      }
      const item_lines = lines.slice(1);
      const hidden = item_lines.length - keep_items;
      if (hidden <= 0) {
        return lines;
      }
      return [lines[0]!, ...item_lines.slice(0, keep_items), `- ... (+${hidden} more)`];
    };

    const _SECTION_TRUNCATE_KEEP = 3;

    const _droppable_names_in_drop_order = [
      "open_questions",
      "active_errors",
      "session_goal",
      "files",
      "grep",
      "glob",
      "web",
      "most_accessed",
      "recent_commits",
      "syms",
      "what_worked",
      "dep_changes",
      "bash",
      "stale",
    ];
    let _live_groups: Array<[string, string[], boolean]> = [..._section_groups];
    let _solved = false;
    for (const _drop_name of _droppable_names_in_drop_order) {
      const _named = _live_groups.find(([n]) => n === _drop_name);
      if (_named !== undefined && _named[2]) {
        continue;
      }
      const _truncate_idx = _live_groups.findIndex(([n]) => n === _drop_name);
      if (_truncate_idx >= 0) {
        const [_orig_name, _orig_lines, _orig_protected] = _live_groups[_truncate_idx]!;
        const _truncated_lines = _truncate_section_lines(_orig_lines, _SECTION_TRUNCATE_KEEP);
        if (_truncated_lines.length < _orig_lines.length) {
          const _trial_groups = [..._live_groups];
          _trial_groups[_truncate_idx] = [_orig_name, _truncated_lines, _orig_protected];
          const _trial_text = _assemble(_trial_groups);
          if (estimate_tokens(_trial_text) <= max_tokens) {
            _live_groups = _trial_groups;
            result = _trial_text;
            _solved = true;
            _LOG.info("_render: safety trim truncated section=%s to %d items (session=%s)", _drop_name, _SECTION_TRUNCATE_KEEP, session_id.slice(0, 8));
            break;
          }
          _LOG.debug("_render: safety trim truncation of section=%s still over budget, will drop", _drop_name);
        }
      }

      _live_groups = _live_groups.filter(([n]) => n !== _drop_name);
      const _candidate_text = _assemble(_live_groups);
      if (estimate_tokens(_candidate_text) <= max_tokens) {
        result = _candidate_text;
        _solved = true;
        _LOG.info("_render: safety trim dropped section=%s (session=%s)", _drop_name, session_id.slice(0, 8));
        break;
      }
      _LOG.debug("_render: safety trim dropped section=%s, still over budget", _drop_name);
    }
    if (!_solved) {
      const _pop_floor_names = new Set(["sealed", "header"]);
      let _pop_floor = 0;
      for (const [_name, _lines] of _live_groups) {
        if (_pop_floor_names.has(_name)) {
          _pop_floor += _lines.length;
        }
      }
      _pop_floor = Math.max(3, _pop_floor);
      const _pinned_lines2: string[] = [];
      const _body_lines: string[] = [];
      for (const [_name, _lines, _prot] of _live_groups) {
        if (_name === "syms" && _prot) {
          _pinned_lines2.push(..._lines);
        } else {
          _body_lines.push(..._lines);
        }
      }
      const _legend_suffix = legend_line !== null ? [legend_line] : [];
      const _pinned_suffix = _pinned_lines2.concat(_legend_suffix);
      const _trimmed = [..._body_lines];
      while (
        _trimmed.length > _pop_floor &&
        estimate_tokens(
          (_applied_prefix
            ? _strip_common_prefix_from_sections(_trimmed.concat(_pinned_suffix), _applied_prefix)
            : _trimmed.concat(_pinned_suffix)
          ).join("\n"),
        ) > max_tokens
      ) {
        _trimmed.pop();
      }
      let _final = _trimmed.concat(_pinned_suffix);
      if (_applied_prefix) {
        _final = _strip_common_prefix_from_sections(_final, _applied_prefix);
      }
      result = _final.join("\n").replace(/\s+$/, "");
    }
  }

  const final_tokens = estimate_tokens(result);
  _LOG.debug(
    "_render: final manifest for session=%s; %d tokens (budget=%d, trimmed=%s)",
    session_id.slice(0, 8),
    final_tokens,
    max_tokens,
    String(token_count > max_tokens),
  );
  return [result, files_with_symbols_count];
}
