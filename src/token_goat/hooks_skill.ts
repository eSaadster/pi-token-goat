/**
 * PostToolUse(Skill) / PreToolUse(Skill) hooks: capture loaded-skill bodies to
 * the on-disk cache and dedup repeat loads.
 *
 * Faithful TypeScript port of src/token_goat/hooks_skill.py.
 *
 * When the agent invokes the Skill tool, Claude Code loads the skill's body
 * (typically a SKILL.md prose file plus any inlined examples and checklists) into
 * the conversation as a tool result. That body is exactly the kind of long-form
 * protocol content that gets summarised lossily by Claude Code's PreCompact step.
 *
 * post_skill captures the body to data_dir()/"skills" immediately after each
 * Skill invocation so the agent can recall the full text later via
 * `token-goat skill-body NAME`. pre_skill blocks repeat loads and serves a
 * compact summary instead.
 *
 * Behaviour is gated by config.toml [skill_preservation] and the
 * TOKEN_GOAT_SKILL_PRESERVATION env override; both default to enabled.
 * Failures at every step are logged and swallowed — a broken token-goat must
 * never interrupt the agent's work.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY (snake_case) for every name a test
 *    imports / asserts on: pre_skill, post_skill, _normalize_skill_name,
 *    _compaction_occurred_after, _resolve_skill_body_path, etc.
 *  - skill_cache is now ported and its seam defaults to the real module; worker
 *    (Layer 6) is still NOT ported. Both are reached via fail-soft injection seams
 *    (_setSkillCacheModule / _setWorkerModule) that degrade to "no compact / no
 *    async" exactly as the Python ImportError fail-soft paths would (and let a test
 *    force the null branch). compact.get_context_pressure / CONTEXT_AUTOCOMPACT_TOKENS
 *    are also not exported by the ported compact.ts, so the pre_skill non-blocking
 *    advisory path (2a) is reached via a _setCompactPressureModule seam; absent it
 *    degrades to "no advisory" (the surrounding try/except swallows it in Python).
 *  - Sibling modules a test spies on (session, config, db, paths) are reached via
 *    STATIC `import * as x from "./x.js"` so vi.spyOn(x, "fn") is observed.
 *  - Byte counts use util.utf8Bytes (UTF-8), never String.length, matching
 *    Python's .encode("utf-8", errors="replace") length. Token estimates use
 *    integer floor division (Math.trunc on a non-negative quotient).
 *  - The TS session.mark_skill_loaded signature moved source_path into an opts
 *    bag: mark_skill_loaded(session_id, skill_name, output_id, content_sha,
 *    body_bytes, truncated, { source_path }). This module adapts accordingly.
 *
 * verbatimModuleSyntax is on -> type-only imports use `import type`.
 * noUncheckedIndexedAccess is on -> indexed accesses are narrowed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { getLogger, utf8Bytes } from "./util.js";
import { registerReset } from "./reset.js";
import * as config from "./config.js";
import * as db from "./db.js";
import * as session from "./session.js";
import * as paths from "./paths.js";
import * as cache_common from "./cache_common.js";
import * as skill_cache from "./skill_cache.js";
import * as worker from "./worker.js";
import {
  CONTINUE,
  deny_redirect,
  extract_tool_response_text,
  get_hook_context,
  get_tool_input,
  pre_tool_use_with_context,
  record_cached_stat,
  sanitize_log_str,
} from "./hooks_common.js";
// Self-namespace import so the post_skill paths call `_generate_and_store_compact`
// through the module's own namespace — this lets tests `vi.spyOn(hooks_skill,
// "_generate_and_store_compact")` observe/stub the call (the ESM live-binding
// analogue of Python's `patch("token_goat.hooks_skill._generate_and_store_compact")`).
import * as self from "./hooks_skill.js";

import type { HookPayload, HookResponse } from "./types.js";

export const __all__ = ["pre_skill", "post_skill"] as const;

const _LOG = getLogger("hooks_skill");

// Smallest skill body worth caching. Below this size the body is almost
// certainly a confirmation stub ("Skill loaded") rather than the real prose;
// storing it would waste the cache slot without enabling useful recall.
const _SKILL_CACHE_MIN_BYTES = 256;

// Hard upper bound on skill body size accepted for caching. 2 MB of characters
// covers all realistic skill bodies and ensures the hook never stalls on a
// runaway tool response.
const _SKILL_CACHE_MAX_CHARS = 2 * 1024 * 1024; // 2 MB character cap

// Compact advisory thresholds for post_skill.
const _ADVISORY_BODY_THRESHOLD_BYTES = 8_000; // ~2 K tokens
const _LARGE_BODY_THRESHOLD_BYTES = 40_000; // ~10 K tokens

// pre_skill context advisory thresholds.
const _PRE_SKILL_ADVISORY_FILL_FLOOR = 0.6;
const _PRE_SKILL_ADVISORY_MIN_SKILL_TOKENS = 4_000;

// ---------------------------------------------------------------------------
// Fail-soft injection seams for unported Layer 6/7 modules.
// ---------------------------------------------------------------------------

/** Subset of skill_cache the hook calls. */
export interface SkillCacheModule {
  content_hash(text: string): string;
  generate_compact_summary(body: string): string | null | undefined;
  store_compact(
    session_id: string,
    skill_name: string,
    compact_text: string,
    source_sha?: string | null,
  ): unknown;
  get_compact(session_id: string, skill_name: string): string | null | undefined;
  get_compact_any_session(skill_name: string): string | null | undefined;
  extract_compact_source_sha(compact: string): string | null | undefined;
  extract_compact_from_marker(body: string): string | null | undefined;
  store_output(
    session_id: string,
    skill_name: string,
    body: string,
    opts?: { source_path?: string | undefined; max_total_bytes?: number | undefined },
  ): SkillCacheMeta | null | undefined;
  write_sidecar(meta: SkillCacheMeta): unknown;
}

/** Shape of skill_cache.store_output's return value (the parts the hook reads). */
export interface SkillCacheMeta {
  skill_name: string;
  output_id: string;
  content_sha: string;
  body_bytes: number;
  truncated: boolean;
  source_path: string;
}

/** Subset of worker the hook calls. */
export interface WorkerModule {
  is_worker_alive(): boolean;
}

/** Subset of compact the pre_skill advisory path calls. */
export interface CompactPressureModule {
  CONTEXT_AUTOCOMPACT_TOKENS: number;
  get_context_pressure(session_id: string): { fill_fraction: number };
}

// skill_cache and worker are now ported, so their seams default to the real
// module; compact's pressure surface is NOT yet ported, so it stays
// null-by-default. reset.ts restores the ported seams to their real defaults.
const _skillCacheDefault: SkillCacheModule = skill_cache;
const _workerDefault: WorkerModule = worker;

let _skillCacheModule: SkillCacheModule | null = _skillCacheDefault;
let _workerModule: WorkerModule | null = _workerDefault;
let _compactPressureModule: CompactPressureModule | null = null;

/**
 * Test/late-layer seam: inject a skill_cache implementation. Pass null to force
 * the fail-soft (no-module) path; reset.ts restores the real default.
 */
export function _setSkillCacheModule(mod: SkillCacheModule | null): void {
  _skillCacheModule = mod;
}

/** Test/late-layer seam: inject a worker implementation (null to clear). */
export function _setWorkerModule(mod: WorkerModule | null): void {
  _workerModule = mod;
}

/** Test/late-layer seam: inject compact's context-pressure surface (null to clear). */
export function _setCompactPressureModule(mod: CompactPressureModule | null): void {
  _compactPressureModule = mod;
}

// Test seams for the two internal functions the Python test monkeypatches
// (hooks_skill._compaction_occurred_after and ._resolve_skill_body_path). The
// module's own internal calls route through these overridable references so a
// test can substitute behaviour, exactly as `patch("...hooks_skill.<fn>")` did
// in Python. Default to the real implementations; cleared on reset.
let _compactionOccurredAfterOverride: ((session_id: string, skill_ts: number) => boolean) | null =
  null;
let _resolveSkillBodyPathOverride: ((skill_name: string) => string) | null = null;

/** Test seam: override _compaction_occurred_after (null to clear). */
export function _setCompactionOccurredAfterOverride(
  fn: ((session_id: string, skill_ts: number) => boolean) | null,
): void {
  _compactionOccurredAfterOverride = fn;
}

/** Test seam: override _resolve_skill_body_path (null to clear). */
export function _setResolveSkillBodyPathOverride(
  fn: ((skill_name: string) => string) | null,
): void {
  _resolveSkillBodyPathOverride = fn;
}

registerReset(() => {
  // Restore the real-module defaults for skill_cache and worker; compact's
  // pressure surface stays unported.
  _skillCacheModule = _skillCacheDefault;
  _workerModule = _workerDefault;
  _compactPressureModule = null;
  _compactionOccurredAfterOverride = null;
  _resolveSkillBodyPathOverride = null;
});

function _getSkillCache(): SkillCacheModule | null {
  return _skillCacheModule;
}

function _getWorker(): WorkerModule | null {
  return _workerModule;
}

function _getCompactPressure(): CompactPressureModule | null {
  return _compactPressureModule;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** UTF-8 byte length, matching Python s.encode("utf-8", errors="replace"). */
function _utf8Len(s: string): number {
  return utf8Bytes(s).length;
}

/** True for a plain (non-array, non-null) object — the JS analogue of isinstance(x, dict). */
function _isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pull the skill body text from a PostToolUse(Skill) payload.
 *
 * Delegates to hooks_common.extract_tool_response_text which handles all payload
 * shapes (bare string, MCP content array, named-field dict). Returns "" when
 * nothing decodable is present.
 */
function _extract_skill_body(payload: HookPayload): string {
  return extract_tool_response_text(payload, {
    text_keys: ["output", "text", "body", "content", "response"],
  });
}

/**
 * Best-effort lookup of the skill body file on the local filesystem.
 *
 * Resolves the on-disk path for user-installed, plugin flat-layout, and plugin
 * marketplace-layout skills. Returns the resolved absolute path as a string when
 * a file exists, else an empty string. Never raises.
 *
 * Exported so skill_cache.get_skill_file_path can delegate to it (Python's
 * `hooks_skill._resolve_skill_body_path`); internal calls and that delegate
 * both honour the _setResolveSkillBodyPathOverride test seam below.
 */
export function _resolve_skill_body_path(skill_name: string): string {
  if (_resolveSkillBodyPathOverride !== null) {
    return _resolveSkillBodyPathOverride(skill_name);
  }
  if (!skill_name) {
    return "";
  }

  const home = os.homedir();
  const candidates: string[] = [];

  if (skill_name.includes(":")) {
    const idx = skill_name.indexOf(":");
    const plugin = skill_name.slice(0, idx);
    const name = skill_name.slice(idx + 1);
    if (plugin && name) {
      // Legacy flat layout first (cheaper — direct path stat without globbing).
      candidates.push(nodePath.join(home, ".claude", "plugins", plugin, "skills", name, "SKILL.md"));
      candidates.push(nodePath.join(home, ".claude", "plugins", plugin, "skills", name, `${name}.md`));
      // Marketplace layout: cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md.
      const cache_root = nodePath.join(home, ".claude", "plugins", "cache");
      try {
        if (_isDir(cache_root)) {
          for (const mkt of _iterdir(cache_root)) {
            if (!_isDir(mkt)) {
              continue;
            }
            const plugin_dir = nodePath.join(mkt, plugin);
            if (!_isDir(plugin_dir)) {
              continue;
            }
            let versions: string[];
            try {
              versions = _iterdir(plugin_dir)
                .filter((v) => _isDir(v))
                .sort()
                .reverse();
            } catch {
              continue;
            }
            for (const ver of versions) {
              candidates.push(nodePath.join(ver, "skills", name, "SKILL.md"));
              candidates.push(nodePath.join(ver, "skills", name, `${name}.md`));
            }
          }
        }
      } catch {
        // OSError analogue — ignore.
      }
      // Fallback: mirrored under the bare name in ~/.claude/skills/<name>.
      candidates.push(nodePath.join(home, ".claude", "skills", name, "SKILL.md"));
      candidates.push(nodePath.join(home, ".claude", "skills", name, `${name}.md`));
    }
  } else {
    candidates.push(nodePath.join(home, ".claude", "skills", skill_name, "SKILL.md"));
    candidates.push(nodePath.join(home, ".claude", "skills", skill_name, `${skill_name}.md`));
    // Nested subdir layout: skills/<name>/<name>/SKILL.md
    candidates.push(nodePath.join(home, ".claude", "skills", skill_name, skill_name, "SKILL.md"));
  }

  for (const p of candidates) {
    try {
      if (_isFile(p)) {
        return p;
      }
    } catch {
      continue;
    }
  }
  return "";
}

function _isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function _iterdir(p: string): string[] {
  return fs.readdirSync(p).map((name) => nodePath.join(p, name));
}

/**
 * Record a skill_compact_served savings row in the stats DB.
 *
 * Failures are logged and swallowed — a broken stats DB must never abort the hook.
 */
function _record_skill_compact_stat(
  skill_name: string,
  bytes_saved: number,
  tokens_saved: number,
): void {
  try {
    db.recordStat(undefined, "skill_compact_served", {
      bytesSaved: bytes_saved,
      tokensSaved: tokens_saved,
      detail: sanitize_log_str(skill_name, 200),
    });
  } catch {
    _LOG.debug("post-skill: skill_compact_served stat record failed");
  }
}

/**
 * Normalize a raw skill name from tool_input to a consistent cache key.
 *
 * Strip whitespace, take the last path component when slashes are present, strip
 * a trailing .md suffix, and lowercase the result. Returns "" when the result is
 * empty after all steps.
 */
export function _normalize_skill_name(raw: string): string {
  let stripped = raw.trim();
  if (stripped.includes("/") || stripped.includes("\\")) {
    const parts = stripped.replace(/\\/g, "/").split("/");
    stripped = parts[parts.length - 1] ?? "";
  }
  if (stripped.toLowerCase().endsWith(".md")) {
    stripped = stripped.slice(0, -3);
  }
  return stripped ? stripped.toLowerCase() : "";
}

/**
 * Rough fill fraction [0..1] of the autocompact trigger point.
 *
 * Delegates to compact.get_context_pressure. Returns 0.0 on any error / when the
 * compact pressure seam is absent.
 */
function _estimate_context_fill(session_id: string): number {
  try {
    const mod = _getCompactPressure();
    if (mod === null) {
      return 0.0;
    }
    return mod.get_context_pressure(session_id).fill_fraction;
  } catch {
    return 0.0;
  }
}

/**
 * Estimate the on-disk skill body size in tokens without reading the file.
 *
 * Uses _resolve_skill_body_path plus stat().size for an O(1) size estimate.
 * Returns 0 when the path cannot be found or the stat fails.
 */
function _estimate_incoming_skill_tokens(skill_name: string): number {
  try {
    const source = _resolve_skill_body_path(skill_name);
    if (source) {
      return Math.trunc(fs.statSync(source).size / 4);
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * Generate a compact summary, apply the budget cap, store it, and record stats.
 *
 * Returns [compact_tokens, full_tokens] on success or null when generation
 * produces no output. Failures inside budget / store steps propagate.
 */
export function _generate_and_store_compact(
  session_id: string,
  skill_name: string,
  body: string,
  body_size: number,
  content_sha: string,
): [number, number] | null {
  const sc = _getSkillCache();
  if (sc === null) {
    return null;
  }
  let compact_text = sc.generate_compact_summary(body);
  if (!compact_text) {
    return null;
  }
  let _cfg_budget: number;
  try {
    _cfg_budget = config.load().skill_preservation?.truncation_budget_tokens ?? 800;
  } catch {
    _cfg_budget = 800;
  }
  if (_cfg_budget > 0) {
    const _budget_chars = _cfg_budget * 4;
    if (compact_text.length > _budget_chars) {
      let _cut = cache_common.find_markdown_boundary(compact_text, _budget_chars);
      if (_cut <= 0) {
        _cut = _budget_chars;
      }
      compact_text = compact_text.slice(0, _cut).replace(/\s+$/, "") + "…";
      _LOG.debug(
        "post-skill: compact for %s truncated to budget (%d tokens) at markdown boundary",
        sanitize_log_str(skill_name, 80),
        _cfg_budget,
      );
    }
  }
  sc.store_compact(session_id, skill_name, compact_text, content_sha);
  const _compact_bytes = _utf8Len(compact_text);
  const _compact_tokens = Math.trunc(_compact_bytes / 4);
  const _full_tokens = Math.trunc(body_size / 4);
  _record_skill_compact_stat(
    skill_name,
    Math.max(0, body_size - _compact_bytes),
    Math.max(0, _full_tokens - _compact_tokens),
  );
  return [_compact_tokens, _full_tokens];
}

/**
 * Return true when a compaction event fired more recently than skill_ts.
 *
 * Uses the mtime of the manifest-SHA sidecar as a proxy for the most recent
 * compaction. Returns false when the sidecar does not exist or on any error.
 */
export function _compaction_occurred_after(session_id: string, skill_ts: number): boolean {
  if (_compactionOccurredAfterOverride !== null) {
    return _compactionOccurredAfterOverride(session_id, skill_ts);
  }
  try {
    const sidecar = paths.manifestShaSidecarPath(session_id);
    let st: fs.Stats;
    try {
      st = fs.statSync(sidecar);
    } catch {
      return false;
    }
    // st.mtimeMs is in ms; skill_ts is in seconds (Python time.time()).
    return st.mtimeMs / 1000 > skill_ts;
  } catch {
    return false;
  }
}

/**
 * Try to extract a compact form from the skill file on disk for first-load serving.
 *
 * Returns null when the file cannot be found / read, or it has no COMPACT_END
 * marker. The compact is NOT stored here — that is done by post_skill.
 */
function _read_first_load_compact(skill_name: string): string | null {
  const path = _resolve_skill_body_path(skill_name);
  if (!path) {
    return null;
  }
  let body: string;
  try {
    body = fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const sc = _getSkillCache();
  if (sc === null) {
    return null;
  }
  return sc.extract_compact_from_marker(body) ?? null;
}

/**
 * PreToolUse(Skill) hook: block repeat loads; serve compact on first load when curated.
 *
 * Always returns CONTINUE on any exception — a broken pre_skill must never
 * interrupt the agent's work.
 */
export function pre_skill(payload: HookPayload): HookResponse {
  if (!_isDict(payload)) {
    return CONTINUE();
  }

  const tool_name = (payload as Record<string, unknown>)["tool_name"] ?? "";
  if (tool_name !== "Skill") {
    return CONTINUE();
  }

  const cfg = config.load().skill_preservation;
  if (!cfg || !cfg.enabled || !cfg.pre_skill_enabled) {
    return CONTINUE();
  }

  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return CONTINUE();
  }

  const tool_input = get_tool_input(payload);
  const skill_name_raw =
    tool_input["skill"] ?? tool_input["skillName"] ?? tool_input["name"];
  if (typeof skill_name_raw !== "string" || !skill_name_raw) {
    return CONTINUE();
  }

  const skill_name = _normalize_skill_name(skill_name_raw);
  if (!skill_name) {
    return CONTINUE();
  }

  const prior_entry = session.lookup_skill_entry(session_id, skill_name);

  // -----------------------------------------------------------------------
  // Repeat-load branch: skill was loaded before in this session.
  // -----------------------------------------------------------------------
  if (prior_entry !== null) {
    const skill_ts = prior_entry.ts;
    if (_compaction_occurred_after(session_id, skill_ts)) {
      if (cfg.post_compact_full_loads) {
        // Opt-in: allow one full body reload per compaction epoch.
        _LOG.debug(
          "pre-skill: compaction detected after skill load (skill=%s ts=%.0f); allowing reload",
          sanitize_log_str(skill_name, 80),
          skill_ts,
        );
        return CONTINUE();
      }
      // Default: serve compact after compaction, but only when a compact is
      // actually cached. Without a compact fall back to a full reload.
      const sc = _getSkillCache();
      const cached = sc !== null ? sc.get_compact(session_id, skill_name) : null;
      if (!cached) {
        _LOG.debug(
          "pre-skill: compaction for %s; no compact cached — allowing full reload",
          sanitize_log_str(skill_name, 80),
        );
        return CONTINUE();
      }
      _LOG.debug(
        "pre-skill: compaction detected for %s; post_compact_full_loads=False — serving compact",
        sanitize_log_str(skill_name, 80),
      );
    }

    const run_count = prior_entry.run_count;
    const body_tokens = Math.trunc(prior_entry.body_bytes / 4); // rough: 4 bytes/token
    const sc = _getSkillCache();
    const compact_text = sc !== null ? sc.get_compact(session_id, skill_name) : null;

    let context: string;
    if (compact_text) {
      const compact_tokens = Math.trunc(_utf8Len(compact_text) / 4);
      context =
        `Skill **${skill_name}** is already in context from this session ` +
        `(${run_count}× loaded, ~${body_tokens} tok). ` +
        `Re-loading blocked to save ${body_tokens - compact_tokens} tok.\n\n` +
        `**Compact operative summary** (~${compact_tokens} tok):\n\n` +
        `${compact_text}\n\n` +
        `Full sections: \`token-goat skill-body ${skill_name} --section <heading>\``;
      _LOG.info(
        "pre-skill: blocked repeat load of %s (run_count=%d); served compact (%d tokens)",
        sanitize_log_str(skill_name, 80),
        run_count,
        compact_tokens,
      );
    } else {
      context =
        `Skill **${skill_name}** is already in context from this session ` +
        `(${run_count}× loaded, ~${body_tokens} tok). ` +
        `Re-loading blocked — its instructions are still active.\n\n` +
        `Recall the cached body: \`token-goat skill-body ${skill_name}\`\n` +
        `Recall a specific section: \`token-goat skill-body ${skill_name} --section <heading>\``;
      _LOG.info(
        "pre-skill: blocked repeat load of %s (run_count=%d); no compact cached",
        sanitize_log_str(skill_name, 80),
        run_count,
      );
    }

    return deny_redirect(
      `Skill '${skill_name}' already loaded in this session (run ${run_count}×); re-injection skipped`,
      context,
    );
  }

  // -----------------------------------------------------------------------
  // First-load compact branch: opt-in; requires COMPACT_END marker in file.
  // -----------------------------------------------------------------------
  if (cfg.first_load_compact) {
    const compact_text = _read_first_load_compact(skill_name);
    if (compact_text) {
      const compact_tokens = Math.trunc(_utf8Len(compact_text) / 4);
      const context =
        `Skill **${skill_name}** has a curated compact section ` +
        `(~${compact_tokens} tok). ` +
        `Serving compact on first load (\`first_load_compact\` is enabled).\n\n` +
        `**Compact operative summary**:\n\n` +
        `${compact_text}\n\n` +
        `Full skill body: \`token-goat skill-body ${skill_name}\`\n` +
        `Specific section: \`token-goat skill-body ${skill_name} --section <heading>\``;
      _LOG.info(
        "pre-skill: first-load compact served for %s (~%d tokens)",
        sanitize_log_str(skill_name, 80),
        compact_tokens,
      );
      return deny_redirect(
        `Skill '${skill_name}' first load: compact section served (full body available via skill-body)`,
        context,
      );
    }
    _LOG.debug(
      "pre-skill: first_load_compact enabled but no COMPACT_END marker found for %s; allowing full load",
      sanitize_log_str(skill_name, 80),
    );
  }

  // 2a: Non-blocking context advisory — warn when context fill is high and the
  // incoming skill body is large. Uses pre_tool_use_with_context so the Skill
  // tool is NOT blocked.
  try {
    const _hints_cfg = config.load().hints;
    if (_hints_cfg && _hints_cfg.pre_skill_advisory) {
      const _ctx_pct = _estimate_context_fill(session_id);
      if (_ctx_pct > _PRE_SKILL_ADVISORY_FILL_FLOOR) {
        const _skill_tokens = _estimate_incoming_skill_tokens(skill_name);
        if (_skill_tokens > _PRE_SKILL_ADVISORY_MIN_SKILL_TOKENS) {
          const cm = _getCompactPressure();
          if (cm !== null) {
            const _new_pct = Math.min(
              1.0,
              _ctx_pct + _skill_tokens / cm.CONTEXT_AUTOCOMPACT_TOKENS,
            );
            const _advisory =
              `[token-goat: context at ~${_pct(_ctx_pct)}. ` +
              `Loading ${skill_name} (~${_thousands(_skill_tokens)} tokens) ` +
              `will push to ~${_pct(_new_pct)}. ` +
              `Consider /compact first to preserve headroom.]`;
            return pre_tool_use_with_context(_advisory);
          }
        }
      }
    }
  } catch {
    // pass
  }

  return CONTINUE();
}

/** Python "{:.0%}".format(x) — round-half-to-even is not required for the tested path. */
function _pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Python "{:,}".format(n) — thousands grouping with commas. */
function _thousands(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/**
 * PostToolUse(Skill) hook: persist the loaded skill body to disk + session history.
 *
 * Always returns CONTINUE — this hook never modifies the tool result. Failures at
 * any step are logged and swallowed.
 */
export function post_skill(payload: HookPayload): HookResponse {
  if (!_isDict(payload)) {
    _LOG.debug("post-skill: non-dict payload; skipping");
    return CONTINUE();
  }
  const tool_name = (payload as Record<string, unknown>)["tool_name"] ?? "";
  if (tool_name !== "Skill") {
    return CONTINUE();
  }

  const cfg = config.load().skill_preservation;
  if (!cfg || !cfg.enabled) {
    _LOG.debug("post-skill: disabled by config; skipping capture");
    return CONTINUE();
  }

  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return CONTINUE();
  }

  const tool_input = get_tool_input(payload);
  const skill_name_raw =
    tool_input["skill"] ?? tool_input["skillName"] ?? tool_input["name"];
  if (typeof skill_name_raw !== "string" || !skill_name_raw) {
    _LOG.debug(
      "post-skill: tool_input skill field missing or non-string (tried 'skill', 'skillName', 'name'); skipping",
    );
    return CONTINUE();
  }
  const skill_name = _normalize_skill_name(skill_name_raw);
  if (!skill_name) {
    _LOG.debug(
      "post-skill: skill name empty after normalization (raw=%s); skipping",
      sanitize_log_str(skill_name_raw, 120),
    );
    return CONTINUE();
  }

  let body = _extract_skill_body(payload);
  // Pre-cap runaway bodies before the byte-count.
  if (body.length > _SKILL_CACHE_MAX_CHARS) {
    _LOG.debug(
      "post-skill: body exceeds max chars cap (%d chars > %d); pre-truncating",
      body.length,
      _SKILL_CACHE_MAX_CHARS,
    );
    body = body.slice(body.length - _SKILL_CACHE_MAX_CHARS); // keep tail
  }
  const body_size = _utf8Len(body);
  if (body_size < _SKILL_CACHE_MIN_BYTES) {
    _LOG.debug(
      "post-skill: body too small to cache (%d bytes < %d threshold); skipping",
      body_size,
      _SKILL_CACHE_MIN_BYTES,
    );
    return CONTINUE();
  }

  const source_path = _resolve_skill_body_path(skill_name);

  const sc = _getSkillCache();
  if (sc === null) {
    // skill_cache (Layer 6) absent — degrade to continue. The body cannot be
    // stored without the cache module.
    _LOG.debug("post-skill: skill_cache module unavailable; skipping capture");
    return CONTINUE();
  }

  // Compute body SHA before the duplicate-load check.
  const body_sha = sc.content_hash(body);

  const prior_entry = session.lookup_skill_entry(session_id, skill_name);
  if (prior_entry !== null && prior_entry.content_sha === body_sha) {
    const run_count = prior_entry.run_count ?? 1;
    const body_tokens = Math.trunc(body_size / 4); // rough estimate: 4 chars/token
    const reload_msg =
      `Note: skill '${skill_name}' was already loaded in this session ` +
      `(${run_count}x prior). Its body (${body_tokens} tokens) is already ` +
      `in context — you do not need to re-read it. ` +
      `Recall the cached body: \`token-goat skill-body ${skill_name}\`. ` +
      `Recall a specific section: \`token-goat skill-section ${skill_name} <heading>\`.`;
    _LOG.info(
      "post-skill: duplicate load for skill %s (run_count=%d); emitting reload hint",
      sanitize_log_str(skill_name, 80),
      run_count,
    );
    // Advance skill_ts so _compaction_occurred_after returns False for the next load.
    try {
      session.mark_skill_loaded(
        session_id,
        skill_name,
        prior_entry.output_id,
        prior_entry.content_sha,
        body_size,
        prior_entry.truncated,
        { source_path: prior_entry.source_path ?? "" },
      );
    } catch (exc) {
      _LOG.debug(
        "post-skill: session ts-advance failed for %s: %s",
        sanitize_log_str(skill_name, 80),
        String(exc),
      );
    }
    const resp = CONTINUE();
    resp.systemMessage = reload_msg;
    return resp;
  }

  const meta = sc.store_output(session_id, skill_name, body, {
    source_path,
    max_total_bytes: cfg.max_cache_bytes,
  });
  if (meta === null || meta === undefined) {
    return CONTINUE();
  }
  sc.write_sidecar(meta);

  // Compact large skill bodies (> 4000 chars ~= 1000 tokens).
  let system_message: string | null = null;
  if (body_size > 4000) {
    try {
      const marker_compact = sc.extract_compact_from_marker(body);
      if (marker_compact !== null && marker_compact !== undefined) {
        sc.store_compact(session_id, skill_name, marker_compact, meta.content_sha);
        const compact_bytes = _utf8Len(marker_compact);
        const compact_tokens = Math.trunc(compact_bytes / 4);
        const total_tokens = Math.trunc(body_size / 4);
        _LOG.debug(
          "post-skill: compact stored for %s via explicit marker (%d chars)",
          sanitize_log_str(skill_name, 80),
          marker_compact.length,
        );
        // Warn when the explicit compact slice exceeds the configured budget.
        try {
          const _budget = config.load().skill_preservation?.truncation_budget_tokens ?? 0;
          if (_budget > 0 && compact_tokens > _budget) {
            process.stderr.write(
              `token-goat warning: skill '${sanitize_log_str(skill_name, 80)}'` +
                ` compact slice is ${compact_tokens} tokens` +
                ` (budget: ${_budget} tokens).` +
                ` Move <!-- COMPACT_END --> earlier in the file.\n`,
            );
            _LOG.warning(
              "post-skill: compact for %s exceeds budget (%d > %d tokens)",
              sanitize_log_str(skill_name, 80),
              compact_tokens,
              _budget,
            );
          }
        } catch {
          // pass
        }
        const _saved_bytes = Math.max(0, body_size - compact_bytes);
        const _saved_tokens = Math.max(0, total_tokens - compact_tokens);
        _record_skill_compact_stat(skill_name, _saved_bytes, _saved_tokens);
        system_message =
          `Skill '${skill_name}' has explicit compact section` +
          ` (${compact_tokens} tokens above marker vs ${total_tokens} total).` +
          ` Detail at: token-goat skill-section ${skill_name} <heading>.`;
      } else {
        // Priority 2: pre-generated compact from any prior session.
        const _pregen = sc.get_compact_any_session(skill_name);
        const _pregen_sha = _pregen ? sc.extract_compact_source_sha(_pregen) : null;
        if (
          _pregen !== null &&
          _pregen !== undefined &&
          _pregen_sha !== null &&
          _pregen_sha !== undefined &&
          meta.content_sha.startsWith(_pregen_sha)
        ) {
          // Path 1: fresh pre-gen compact hit — copy to session; skip generation.
          sc.store_compact(session_id, skill_name, _pregen, meta.content_sha);
          const _cp_bytes = _utf8Len(_pregen);
          const _cp_tokens = Math.trunc(_cp_bytes / 4);
          const _full_tokens = Math.trunc(body_size / 4);
          _record_skill_compact_stat(
            skill_name,
            Math.max(0, body_size - _cp_bytes),
            Math.max(0, _full_tokens - _cp_tokens),
          );
          _LOG.debug(
            "post-skill: pre-gen compact hit for %s (~%d tokens saved)",
            sanitize_log_str(skill_name, 80),
            Math.max(0, _full_tokens - _cp_tokens),
          );
          if (body_size > _ADVISORY_BODY_THRESHOLD_BYTES) {
            system_message =
              `[token-goat: ${skill_name} loaded (~${_thousands(_full_tokens)} tokens). ` +
              `Compact available: ~${_thousands(_cp_tokens)} tokens ` +
              `(saves ~${_thousands(Math.max(0, _full_tokens - _cp_tokens))} tokens/compact). ` +
              `Pre-generated — no extra computation needed.]`;
          }
        } else {
          // No valid pre-gen compact; warn on large bodies missing a marker.
          const _LARGE_BODY_WARN_BYTES = 32_768;
          if (body_size >= _LARGE_BODY_WARN_BYTES) {
            process.stderr.write(
              `token-goat warning: skill '${sanitize_log_str(skill_name, 80)}'` +
                ` body is ${Math.trunc(body_size / 1024)} KB but has no <!-- COMPACT_END --> marker.` +
                ` Add the marker after the section the agent needs most to improve` +
                ` context savings accuracy.\n`,
            );
            _LOG.warning(
              "post-skill: large skill body (%d bytes) without COMPACT_END marker: %s",
              body_size,
              sanitize_log_str(skill_name, 80),
            );
          }
          if (body_size < _LARGE_BODY_THRESHOLD_BYTES) {
            // Path 2: sync auto-extraction for small-to-medium bodies.
            const result = self._generate_and_store_compact(
              session_id,
              skill_name,
              body,
              body_size,
              meta.content_sha,
            );
            if (result !== null) {
              const [_compact_tokens] = result;
              _LOG.debug(
                "post-skill: compact stored for %s via auto-extraction (%d tokens)",
                sanitize_log_str(skill_name, 80),
                _compact_tokens,
              );
              if (body_size > _ADVISORY_BODY_THRESHOLD_BYTES) {
                system_message =
                  `[token-goat: ${skill_name} loaded (~${_thousands(Math.trunc(body_size / 4))} tokens). ` +
                  `Compact generated: ~${_thousands(_compact_tokens)} tokens ` +
                  `(saves ~${_thousands(Math.max(0, Math.trunc(body_size / 4) - _compact_tokens))} tokens/compact).]`;
              }
            }
          } else {
            // Paths 3 + 4: large body (>= 10 K tokens) — async or info-only.
            const worker = _getWorker();
            if (worker !== null && worker.is_worker_alive()) {
              // Path 3: dispatch compact generation to a background task.
              const _b = body;
              const _s = session_id;
              const _n = skill_name;
              const _z = body_size;
              const _h = meta.content_sha;
              // Node has no daemon threads; run the generation asynchronously so
              // the hook returns promptly (errors are suppressed).
              setImmediate(() => {
                try {
                  self._generate_and_store_compact(_s, _n, _b, _z, _h);
                } catch {
                  // suppress
                }
              });
              if (body_size > _ADVISORY_BODY_THRESHOLD_BYTES) {
                system_message =
                  `[token-goat: ${skill_name} loaded ` +
                  `(~${_thousands(Math.trunc(body_size / 4))} tokens — large skill). ` +
                  `Generating compact in background. ` +
                  `Run \`token-goat skill-compact ${skill_name}\` ` +
                  `if needed immediately.]`;
              }
            } else {
              // Path 4: worker down — no generation, info-only advisory.
              if (body_size > _ADVISORY_BODY_THRESHOLD_BYTES) {
                system_message =
                  `[token-goat: ${skill_name} loaded ` +
                  `(~${_thousands(Math.trunc(body_size / 4))} tokens — large skill). ` +
                  `No compact cached. Run \`token-goat install\` or ` +
                  `\`token-goat skill-compact --all\` to pre-generate compacts.]`;
              }
            }
          }
        }
      }
    } catch (exc) {
      _LOG.debug("post-skill: compact failed: %s", String(exc));
    }
  }

  try {
    session.mark_skill_loaded(
      session_id,
      meta.skill_name,
      meta.output_id,
      meta.content_sha,
      meta.body_bytes,
      meta.truncated,
      { source_path: meta.source_path },
    );
  } catch (exc) {
    _LOG.debug("post-skill: session record failed: %s", String(exc));
  }

  record_cached_stat("skill_cached", sanitize_log_str(skill_name, 200), body_size);

  _LOG.info(
    "post-skill: cached skill name=%s bytes=%d truncated=%s source=%s",
    sanitize_log_str(skill_name, 120),
    body_size,
    meta.truncated,
    source_path ? sanitize_log_str(source_path, 200) : "(none)",
  );
  if (system_message) {
    const resp = CONTINUE();
    resp.systemMessage = system_message;
    return resp;
  }
  return CONTINUE();
}
