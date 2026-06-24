/**
 * Consolidated type root for the TypeScript port of token-goat.
 *
 * This file is the single source of truth for wire/index shapes. It gathers the
 * TypedDicts / dataclasses / enums / frozensets scattered across the Python
 * modules into one export-type-only, zero-runtime-dep file.
 *
 * Rules honoured throughout:
 *   - `export type` / `export interface` ONLY (no runtime values).
 *   - enums / frozensets -> union string-literal types.
 *   - Python field names preserved EXACTLY (snake_case).
 *   - `unknown` preferred over `any`.
 *
 * Field optionality follows the Python `total=False` semantics on TypedDicts;
 * for dataclasses with defaults the corresponding TS fields are marked optional
 * (`?`). Inline comments carry over the Python clamp bounds so they are not lost.
 */

// ===========================================================================
// hooks_common.py — inbound payload + hookSpecificOutput variants + response
// ===========================================================================

/** Typed shape for the JSON object received on stdin by every hook handler.
 *  All fields optional (total=False) because the harness may omit any field. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  turn_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_result?: unknown;
  response?: unknown;
  file_path?: string;
  file_content?: string;
  line_number?: number;
  result_count?: number;
  trigger?: string;
  /** Harness-specific ID (Claude/Codex). normalize_payload remaps functionCallId -> toolUseId. */
  toolUseId?: string;
  /** Harness-specific ID (Gemini). */
  functionCallId?: string;
  /** Internal metadata stamped by normalize_payload — not present in raw harness payload. */
  _tg_harness?: string;
  [key: string]: unknown;
}

/** hookSpecificOutput produced by deny_redirect — deny a tool call with a redirect hint. */
export interface HookSpecificOutputDeny {
  hookEventName: string;
  permissionDecision: string;
  permissionDecisionReason: string;
  additionalContext: string;
}

/** hookSpecificOutput produced by pre_tool_use_with_context — inject an additionalContext hint. */
export interface HookSpecificOutputContext {
  hookEventName: string;
  additionalContext: string;
}

/** hookSpecificOutput produced by pre_tool_use_with_update — rewrite tool input and inject a hint. */
export interface HookSpecificOutputUpdate {
  hookEventName: string;
  updatedInput: Record<string, unknown>;
  additionalContext: string;
}

/** Union of the three concrete hookSpecificOutput shapes plus the forward-compat escape hatch. */
export type HookSpecificOutput =
  | HookSpecificOutputDeny
  | HookSpecificOutputContext
  | HookSpecificOutputUpdate
  | Record<string, unknown>;

/** Top-level response returned by every hook handler (all fields optional, total=False). */
export interface HookResponse {
  continue?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: HookSpecificOutput;
  /** Diagnostic fields — ignored by the harness, useful for tests/logging. */
  _tg_elapsed_ms?: number;
  _tg_handler?: string;
  _tg_error?: string;
  [key: string]: unknown;
}

// ===========================================================================
// hook_registry.py — canonical tools, harness literal, hook event rows
// ===========================================================================

/** Which harness wire formats an event applies to (Literal["claude","codex","both"]). */
export type Harness = "claude" | "codex" | "both";

/** Canonical PascalCase tool names token-goat handlers recognise (frozenset CANONICAL_TOOLS). */
export type ToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "MultiEdit"
  | "Bash"
  | "Glob"
  | "WebFetch"
  | "Grep"
  | "Skill";

/** Alias mirroring the Python `CANONICAL_TOOLS` symbol name. */
export type CANONICAL_TOOLS = ToolName;

/** One row of the hook registry (frozen dataclass HookEvent). */
export interface HookEvent {
  name: string;
  typer_func: string;
  module: string;
  attr: string;
  claude_event: string | null;
  claude_matcher: string;
  claude_timeout_ms: number;
  codex_event: string | null;
  codex_matcher: string;
  codex_timeout_ms: number;
  docstring: string;
  /** Derived property: which harness wire formats this event applies to. */
  readonly harness?: Harness;
}

// ===========================================================================
// db.py — DB row shapes + stat/health records + import-graph dicts
// ===========================================================================

/** Row of the per-project `files` table. */
export interface FileRecord {
  rel_path: string;
  language: string;
  size: number;
  line_count: number | null;
  mtime: number;
  content_sha256: string;
  indexed_at: number;
}

/** Row of the per-project `symbols` table. */
export interface SymbolRecord {
  id: number;
  name: string;
  kind: string;
  file_rel: string;
  line: number;
  col: number;
  end_line: number | null;
  signature: string | null;
  parent_id: number | null;
}

/** Row of the per-project `refs` table (call-site references). */
export interface RefRecord {
  id: number;
  symbol_name: string;
  file_rel: string;
  line: number;
  col: number;
  context: string | null;
}

/** Row of the per-project `sections` table (markdown/structural headings). */
export interface SectionRecord {
  id: number;
  file_rel: string;
  heading: string;
  level: number;
  line: number;
  end_line: number | null;
}

/** Row of the per-project `imports_exports` table. */
export interface ImpExpRecord {
  id: number;
  file_rel: string;
  /** "import" | "export" | "reexport" */
  kind: string;
  target: string;
  line: number;
}

/** Row of the global / per-project `stats` table. */
export interface StatRecord {
  id: number;
  ts: number;
  kind: string;
  tokens_saved: number;
  bytes_saved: number;
  detail: string | null;
  last_access_epoch?: number;
}

/** Row of the global `projects` table. */
export interface ProjectRecord {
  hash: string;
  root: string;
  marker: string;
  first_seen: number;
  last_seen: number;
  file_count: number;
  languages: string;
}

// ===========================================================================
// cache_common.py — OutputStatDict (shared by bash/web/skill cache sidecars)
// ===========================================================================

/** Stat-derived metadata shape shared by all three output-cache modules.
 *  (Python `OutputStatDict`; also used as the CacheRecord / OutputMeta alias.) */
export interface OutputStatDict {
  output_id?: string;
  size_bytes?: number;
  mtime?: number;
}

/** Alias mirroring alternative names used in the codebase. */
export type CacheRecord = OutputStatDict;
export type OutputMeta = OutputStatDict;

// ===========================================================================
// session.py — SessionCacheShape + nested entry dataclasses
// ===========================================================================

/** Tracks reads of a single file within a session. */
export interface FileEntry {
  rel_or_abs: string;
  last_read_ts: number;
  read_count: number;
  /** [(start, end), ...] of read ranges, 1-indexed inclusive. */
  line_ranges: Array<[number, number]>;
  symbols_read: string[];
  /** unix ts of last edit; 0.0 = never edited this session. */
  last_edit_ts?: number;
  /** symbol -> unix timestamp. */
  symbols_ts?: Record<string, number>;
  /** os.stat(path).st_mtime_ns at last read; null = not recorded. */
  read_mtime_ns?: number | null;
  /** os.stat(path).st_size at last read; null = not recorded. */
  read_size?: number | null;
  /** hooks_read._call_index value when this file was last read; 0 = never recorded. */
  last_read_call_index?: number;
}

/** Tracks a Grep call (pattern + scope). */
export interface GrepEntry {
  pattern: string;
  path: string | null;
  ts: number;
  result_count?: number | null;
}

/** Tracks a Glob call (pattern + optional path scope). */
export interface GlobEntry {
  pattern: string;
  path: string | null;
  ts: number;
  result_count?: number | null;
}

/** Tracks one WebFetch invocation within a session. */
export interface WebEntry {
  url_sha: string;
  url_preview: string;
  output_id: string;
  ts: number;
  body_bytes: number;
  status_code?: number | null;
  truncated?: boolean;
  content_type?: string | null;
}

/** Tracks one execution of a Bash command within a session. */
export interface BashEntry {
  cmd_sha: string;
  cmd_preview: string;
  output_id: string;
  ts: number;
  stdout_bytes: number;
  stderr_bytes: number;
  exit_code?: number | null;
  truncated?: boolean;
  run_count?: number;
  /** Content hash of post-compression output (16 hex chars). Empty for legacy caches. */
  output_sha?: string;
}

/** Tracks one Skill tool invocation within a session. */
export interface SkillEntry {
  skill_name: string;
  output_id: string;
  content_sha: string;
  ts: number;
  body_bytes: number;
  truncated?: boolean;
  run_count?: number;
  source_path?: string;
  compact_served_count?: number;
}

/** One agent decision captured via `token-goat decision "<text>"`. */
export interface DecisionEntry {
  text: string;
  ts: number;
  tag?: string;
}

/** A cached read_symbol/read_section result, keyed elsewhere by (rel_path, item). */
export interface ResultCacheEntry {
  /** hex SHA-1 of the file contents at cache time; empty when unknown. */
  file_sha: string;
  /** "symbol" | "section" — disambiguates the two read-replacement paths. */
  kind: string;
  /** The SymbolResult/SectionResult dict (JSON-serializable). */
  result: Record<string, unknown>;
  /** unix timestamp at insertion (for FIFO ordering + observability). */
  ts: number;
}

/**
 * Full SessionCache shape. Fields are optional per schema_version (older session
 * JSON files omit newer fields; from_dict defaults them). Every field from the
 * Python `SessionCache` dataclass is represented here.
 */
export interface SessionCacheShape {
  session_id: string;
  started_ts: number;
  last_activity_ts: number;
  /** key = normalized path. */
  files?: Record<string, FileEntry>;
  greps?: GrepEntry[];
  /** result_content_hash (8 hex) -> pattern. FIFO at GREP_RESULT_HASHES_MAX. */
  grep_result_hashes?: Record<string, string>;
  /** (tool_name+input) hash -> output_id. FIFO at MCP_RESULT_HASHES_MAX. */
  mcp_result_hashes?: Record<string, string>;
  /** normalized-path -> SHA256 hex of last whole-file Read content. */
  read_content_hashes?: Record<string, string>;
  /** "{norm_path}:{size}:{mtime:.9f}" -> 16-hex SHA256 of log content. */
  log_file_cache?: Record<string, string>;
  /** "{norm_dir_path}:{cmd_fingerprint}" -> 16-hex SHA256 of listing output. */
  dir_listing_cache?: Record<string, string>;
  /** display_cmd -> sha256_hex of last stdout for that command. */
  cmd_output_hashes?: Record<string, string>;
  /** file_content_sha16 (16 hex) -> normalized path of first file seen with that content. */
  file_content_seen?: Record<string, string>;
  /** normalized_path -> edit count. */
  edited_files?: Record<string, number>;
  /** In-session cache of read_symbol/read_section results. */
  result_cache?: Record<string, ResultCacheEntry>;
  /** cmd_sha -> BashEntry. */
  bash_history?: Record<string, BashEntry>;
  /** Chronological list of GlobEntry. */
  glob_history?: GlobEntry[];
  /** url_sha -> WebEntry. */
  web_history?: Record<string, WebEntry>;
  /** skill_name -> SkillEntry. */
  skill_history?: Record<string, SkillEntry>;
  /** Append-only decision log, newest-last. */
  decisions?: DecisionEntry[];
  /** normalized file path -> SHA of on-disk snapshot bytes. */
  snapshot_shas?: Record<string, string>;
  /** hint_fingerprint -> count. */
  hints_seen?: Record<string, number>;
  /** content_hash -> [summary_text, count]. */
  hints_content_dedup?: Record<string, [string, number]>;
  /** Output ids surfaced in a bash dedup hint this session. */
  bash_dedup_emitted_ids?: string[];
  /** task_id -> output_id. */
  stored_task_outputs?: Record<string, string>;
  hints_emitted?: number;
  hints_ignored?: number;
  structured_hints_emitted?: number;
  index_only_hints_emitted?: number;
  /** Ring buffer of [normalized_path, emit_ts]. Capped at 3. */
  recent_hints?: Array<[string, number]>;
  /** category -> list of accepted/ignored flags. Capped at _HINT_CAT_HISTORY_MAX. */
  hint_category_history?: Record<string, boolean[]>;
  /** Working directory at session start (optional; None on legacy sessions). */
  cwd?: string | null;
  /** Timestamp the session was created. */
  created_ts?: number;
  /** First 16 hex chars of SHA-256 of last-emitted manifest; "" = no prior emit. */
  last_manifest_sha?: string;
  /** Epoch ts of last manifest emit; 0.0 = not yet set. */
  last_manifest_ts?: number;
  /** hint type -> emitted count. */
  hints_emitted_by_type?: Record<string, number>;
  /** hint type -> suppressed count. */
  hints_suppressed_by_type?: Record<string, number>;
  /** abs file path -> shrink() call count. */
  image_shrink_count?: Record<string, number>;
  /** normalized file path -> total Read/Grep/Glob access count. */
  file_access_counts?: Record<string, number>;
  /** "{normalized_file}::{symbol}" -> surgical-access count. */
  symbol_access_counts?: Record<string, number>;
  /** normalized file path -> Grep/rg target count. */
  grep_target_counts?: Record<string, number>;
  /** "<file>::<symbol>" spec strings, insertion-ordered. Capped at PINNED_SYMBOLS_MAX. */
  pinned_symbols?: string[];
  turns_since_last_compact?: number;
  loaded_skill_total_tokens?: number;
  /** Highest threshold (50|70) already fired; null = none yet. */
  last_context_advisory_threshold?: number | null;
  pressure_baseline_tokens?: number;
  observed_tool_tokens?: number;
  /** Epoch ts of most recent PreCompact; 0.0 = no compact this session. */
  last_compact_ts?: number;
  /** cmd_sha -> sorted list of FAILED/ERROR test ids. */
  pytest_failures?: Record<string, string[]>;
  /** Monotonic CAS version counter. */
  version?: number;
  // In-process-only flags below are not persisted but are part of the shape.
  recovery_injected?: boolean;
  unavailable?: boolean;
  [key: string]: unknown;
}

// ===========================================================================
// config.py — ConfigSchema (all ~20 sections; clamp bounds preserved in comments)
// ===========================================================================

export interface CompactAssistConfig {
  enabled?: boolean;
  /** "manual" | "auto" entries. */
  triggers?: string[];
  /** clamp [0, 1000], default 3. */
  min_events?: number;
  /** clamp [50, 10000], default 400. */
  max_manifest_tokens?: number;
  /** clamp [1.0, 10.0], default 2.0. */
  auto_trigger_multiplier?: number;
  /** clamp (0, 3600], default 300.0. */
  compact_skip_ttl_secs?: number;
  /** clamp [0, 10000], default 0. */
  noise_floor_tokens?: number;
  /** clamp [0, 100], default 3. */
  edited_dir_group_threshold?: number;
  /** clamp [0, 10000], default 0. */
  max_section_lines?: number;
  /** clamp [1, 10000], default 15. */
  wide_session_threshold?: number;
  /** clamp [1, 10000], default 5. */
  orchestrator_commit_threshold?: number;
  lazy_skill_injection?: boolean;
  /** clamp [0, 16000] (0 disables; else [400, 16000]), default 1600. */
  max_manifest_chars?: number;
  /** "auto" | "claudecode" | "codex" | "opencode" | "generic". */
  harness?: string;
}

export interface BashCompressConfig {
  enabled?: boolean;
  disabled_filters?: string[];
  /** clamp [50, 100000], default 1000. */
  max_lines?: number;
  /** clamp [1024, 16 MiB], default 65536. */
  max_bytes?: number;
  /** clamp [5, 7200], default 600. */
  timeout_seconds?: number;
  /** clamp [0, 100 MiB], default 0. */
  cache_min_bytes?: number;
  /** clamp [1, 1_000_000], default 4096. */
  cache_max_file_count?: number;
  /** clamp [1024, 4 GiB], default 16 MiB. */
  cache_max_bytes?: number;
  /** clamp [1024, 4 GiB], default 50 MiB. */
  cache_max_bytes_per_output?: number;
}

export interface BashDiffConfig {
  /** Keep only this many hunks per file; default 10. */
  max_hunks_per_file?: number;
  /** Master switch for density filtering. */
  hunk_density_cap?: boolean;
}

export interface SeverityLogConfig {
  context_lines?: number;
  /** clamp [0.0, 1.0], default 0.5. */
  score_threshold?: number;
}

export interface CodeCompressConfig {
  /** Minimum line count to trigger post-read structural compression; default 200. */
  min_lines?: number;
}

export interface SessionBriefConfig {
  enabled?: boolean;
}

export interface SkillPreservationConfig {
  enabled?: boolean;
  /** clamp [64 KiB, 512 MiB], default 5 MiB. */
  max_cache_bytes?: number;
  orphan_sweep_enabled?: boolean;
  /** clamp [1, 2_592_000], default 604800 (7 days). */
  orphan_age_secs?: number;
  /** clamp [0, 8000], default 800. */
  truncation_budget_tokens?: number;
  compress_bodies?: boolean;
  /** clamp [1024, 10 MiB], default 16384. */
  compress_min_bytes?: number;
  inline_snippets?: boolean;
  pre_skill_enabled?: boolean;
  first_load_compact?: boolean;
  post_compact_full_loads?: boolean;
}

export interface ImageShrinkConfig {
  prefer_avif?: boolean;
  /** clamp [1, 100], default 60. */
  avif_quality?: number;
  /** clamp [1, 100], default 75. */
  jpeg_quality?: number;
  /** clamp [0, 500_000_000], default 16_000_000. 0 disables. */
  max_image_pixels?: number;
  orphan_sweep_enabled?: boolean;
  /** clamp [1, 2_592_000], default 604800. */
  orphan_age_secs?: number;
  screenshot_redirect?: boolean;
}

export interface CuratorConfig {
  enabled?: boolean;
  /** clamp [1, 10_000], default 10. */
  min_samples?: number;
  /** clamp [0, 100], default 20. */
  threshold_pct?: number;
}

export interface HintBudgetConfig {
  enabled?: boolean;
  /** clamp [0, 1_000_000], default 100. 0 disables the kind. */
  max_per_session?: number;
  /** clamp [0, 1_000_000], default 30. */
  max_structured_per_session?: number;
  /** clamp [0, 1_000_000], default 30. */
  max_index_only_per_session?: number;
}

export interface RepomapConfig {
  /** clamp [0, ...], default 50. 0 disables. */
  compact_file_threshold?: number;
  exclude_tests?: boolean;
}

export interface OverflowGuardConfig {
  enabled?: boolean;
  /** default 25000. */
  max_tokens?: number;
}

export interface StatsConfig {
  record_zero_savings?: boolean;
}

export interface PromptTrigger {
  keywords: string[];
  hint: string;
}

export interface HintsConfig {
  /** default 5. 0 disables adaptive suppression. */
  suppress_after_ignored?: number;
  /** "HH:MM-HH:MM" 24h, midnight wrap supported; "" disables. */
  quiet_hours?: string;
  json_sidecar?: boolean;
  /** default 2. 0 = always verbose. */
  verbose_until_seen_count?: number;
  /** default 0 (disabled). */
  min_file_lines_for_hint?: number;
  /** clamp [0, 100000], default 200. */
  bash_dedup_min_bytes?: number;
  /** clamp [0, 100000], default 200. */
  web_dedup_min_bytes?: number;
  /** clamp [0, 100000], default 5. */
  grep_dedup_min_matches?: number;
  serve_diff_on_reread?: boolean;
  /** Sorted ascending; default [1,3,10,30]. [] disables backoff. */
  backoff_thresholds?: number[];
  /** clamp [0, 10000], default 50. 0 disables the cap. */
  git_hint_max_ms?: number;
  /** clamp [0, 1_000_000], default 512. 0 disables. */
  min_session_hint_savings_bytes?: number;
  pre_skill_advisory?: boolean;
  context_threshold_advisory?: boolean;
  /** clamp [0, 100_000], default 1000. */
  diff_hint_min_tokens_saved?: number;
  /** clamp [0, 100_000_000], default 45000. 0 disables. */
  large_read_redirect_bytes?: number;
  reread_deny?: boolean;
  /** default 2048. 0 denies all sizes. */
  reread_deny_min_bytes?: number;
  /** clamp [0, 10_000_000], default 0 (disabled). */
  baseline_budget_tokens?: number;
  stable_doc_compacts?: boolean;
  /** default 200. 0 disables. */
  truncated_read_min_lines?: number;
  /** clamp [0, 100], default 4. 0 disables. */
  protect_recent_reads?: number;
  prompt_triggers?: PromptTrigger[];
}

export interface HooksConfig {
  /** clamp [100, 30000], default 5000. */
  watchdog_ms?: number;
}

export interface WebFetchConfig {
  /** Glob patterns; non-empty = allowlist. */
  allow?: string[];
  /** Glob patterns; checked first, blocks before allow. */
  deny?: string[];
  /** default 4096. 0 disables file-count eviction. */
  max_file_count?: number;
  /** default 32 MiB. 0 disables byte-based eviction. */
  max_bytes?: number;
  compress_bodies?: boolean;
  /** clamp [1 KiB, 10 MiB], default 16 KiB. */
  compress_min_bytes?: number;
}

export interface WorkerConfig {
  watchdog_enabled?: boolean;
  /** clamp [1, 8] (WORKER_MAX_POOL_CEILING), default 4. */
  max_pool_workers?: number;
}

export interface IndexingConfig {
  /** clamp [1 KiB, 1 GiB] (in KB), default 500. */
  large_file_symbol_only_kb?: number;
  /** clamp [1 KiB, 1 GiB] (in KB); >= large_file_symbol_only_kb; default 2048. */
  large_file_skip_kb?: number;
  /** Additional directory basenames to exclude; merged with built-in SKIP_DIRS. */
  skip_dirs?: string[];
}

export interface CompressionConfig {
  /** "auto" | "aggressive" | "balanced" | "minimal". Default "auto". */
  profile?: string;
}

export interface ContextConfig {
  /** clamp [10_000, 10_000_000], default 200_000. */
  model_window_tokens?: number;
}

/** Top-level token-goat config (all ~20 sections). */
export interface ConfigSchema {
  schema_version?: number;
  compact_assist?: CompactAssistConfig;
  bash_compress?: BashCompressConfig;
  bash_diff?: BashDiffConfig;
  bash_severity_log?: SeverityLogConfig;
  post_read_code_compress?: CodeCompressConfig;
  session_brief?: SessionBriefConfig;
  skill_preservation?: SkillPreservationConfig;
  image_shrink?: ImageShrinkConfig;
  curator?: CuratorConfig;
  hint_budget?: HintBudgetConfig;
  repomap?: RepomapConfig;
  overflow_guard?: OverflowGuardConfig;
  stats?: StatsConfig;
  hints?: HintsConfig;
  hooks?: HooksConfig;
  webfetch?: WebFetchConfig;
  worker?: WorkerConfig;
  indexing?: IndexingConfig;
  compression?: CompressionConfig;
  context?: ContextConfig;
}

// ===========================================================================
// read_replacement.py — SymbolResult / SectionResult / LineRangeResult + error codes
// ===========================================================================

/** Return value of read_symbol. */
export interface SymbolResult {
  file: string;
  symbol: string;
  kind: string;
  start_line: number;
  end_line: number;
  core_start_line: number;
  core_end_line: number;
  text: string;
  signature: string | null;
  bytes_total: number;
  bytes_extracted: number;
  bytes_saved: number;
}

/** Return value of read_section. */
export interface SectionResult {
  file: string;
  heading: string;
  level: number;
  start_line: number;
  end_line: number;
  core_start_line: number;
  core_end_line: number;
  text: string;
  bytes_total: number;
  bytes_extracted: number;
  bytes_saved: number;
}

/** Return value of read_line_range. */
export interface LineRangeResult {
  file: string;
  start_line: number;
  end_line: number;
  text: string;
  bytes_total: number;
  bytes_extracted: number;
  bytes_saved: number;
}

/** Structured read-resolution failure code (Python class-attribute `code`). */
export type AmbiguousFileMatchCode =
  | "read_lookup_error"
  | "project_index_unavailable"
  | "ambiguous_file";

// ===========================================================================
// render/types.py — renderer dataclasses + PressureTier
// ===========================================================================

/** Normalised 0.0–1.0 float lists for the three KPI mini-charts. */
export interface Sparklines {
  events: number[];
  bytes: number[];
  tokens: number[];
}

/** Aggregate statistics for a reporting period (events, bytes, tokens, optional deltas). */
export interface TotalStats {
  events: number;
  bytes: number;
  tokens: number;
  /** % change vs equivalent prior period (12 means +12%). Omit if unavailable. */
  events_delta?: number | null;
  bytes_delta?: number | null;
  tokens_delta?: number | null;
  /** 8+ recent data points for mini sparklines. Omit to skip sparkline row. */
  sparklines?: Sparklines | null;
}

/** Per-event-kind breakdown row. */
export interface KindStat {
  kind: string;
  bytes: number;
  tokens: number;
  events: number;
  /** True for kinds like image_shrink where vision tokens are model-specific. Renders tokens as "—". */
  bytes_mode_only?: boolean;
}

/** Daily statistics row (date is YYYY-MM-DD). */
export interface DayParam {
  date: string;
  bytes: number;
  tokens: number;
  events: number;
}

/** Alias DayParam under its Python dataclass name. */
export type DayStat = DayParam;

/** Per-project breakdown row. */
export interface ProjectStat {
  project: string;
  /** short session/commit id shown in the tree path line. */
  hash: string;
  path: string;
  bytes: number;
  tokens: number;
  events: number;
}

/** Per-source bucket row (image / hint / read / compact / other). */
export interface SourceStat {
  source: string;
  bytes: number;
  tokens: number;
  events: number;
}

/** Per-CLI-command breakdown row. */
export interface CommandStat {
  command: string;
  bytes: number;
  tokens: number;
  events: number;
}

/** Complete stats payload for a reporting period. */
export interface StatsData {
  /** ISO date string (Python `date`; serialized as YYYY-MM-DD). */
  period_start: string;
  period_end: string;
  totals: TotalStats;
  by_kind: KindStat[];
  by_day: DayStat[];
  by_project: ProjectStat[];
  /** Sorted desc by bytes. Defaults to empty for older callers. */
  by_source?: SourceStat[];
  /** Sorted desc by bytes. Defaults to empty for older callers. */
  by_command?: CommandStat[];
  /** Loaded token-goat package version; "" when unknown. */
  version?: string;
  /** Human-readable window label, e.g. "last 30 days". */
  window_label?: string;
}

/** Context-pressure bucket used by advisory hint rendering. */
export type PressureTier = "cool" | "warm" | "hot";
