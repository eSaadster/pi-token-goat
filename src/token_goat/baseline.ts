/**
 * Environmental baseline attribution — the per-session "expense report".
 *
 * TypeScript port of src/token_goat/baseline.py.
 *
 * A spawned subagent starts every task with its context window already heavily
 * pre-loaded by content it never requested and cannot see itemized: both
 * CLAUDE.md files, MEMORY.md, MCP instruction blocks, and other plugins'
 * SessionStart dumps (the worst single offender observed: a 58.8 KB Vercel
 * knowledge-graph re-injected on every session start). This module measures and
 * *attributes* that baseline so "why did that subagent overflow at hello?"
 * becomes a quick, actionable lookup instead of an invisible failure.
 *
 * It is strictly read-only — it scans the Claude Code session's persisted hook
 * output, the two CLAUDE.md files, MEMORY.md, and the configured MCP servers,
 * costs each source, and tags it by owner (you / harness / `plugin:<name>`), a
 * concrete fix, and whether the cost is fixed (recurs every session) or variable
 * (prompt-driven). Each scanner is fail-soft: a missing or unreadable source
 * adds a note and is skipped, never raising.
 *
 * Costing uses `bytes // 4` — the same convention `token-goat doctor`'s
 * "Context footprint" and compact._token_count already use — so a baseline total
 * reconciles with the doctor rather than contradicting it.
 *
 * Parity notes (Python -> TS):
 *  - pathlib.Path -> string paths throughout (node:path / node:fs sync calls).
 *  - The `paths` module is imported as `* as paths` (top-level static ESM) so a
 *    test's vi.spyOn(paths, "claudeProjectsDir") intercepts the live binding —
 *    the JS analogue of Python's monkeypatch.setattr(paths, ...).
 *  - hashlib.sha256(data).hexdigest() -> node:crypto createHash("sha256").
 *  - bytes math via Buffer (UTF-8). Python str.splitlines() drops a trailing
 *    empty element; the TS splitLines helper reproduces that exactly.
 *  - Python int floor-division `//` on non-negative ints -> Math.floor.
 *  - round(x, 4) (banker's rounding) -> roundTo(x, 4); the inputs here are
 *    fractions that do not land on .5-at-the-5th-place ties in any test, so the
 *    simpler half-away-from-zero rounding matches.
 */
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as paths from "./paths.js";
import { getLogger } from "./util.js";

// Self-import so collectBaseline calls scanTranscriptUsage through the module
// namespace — the ESM live-binding analogue of Python's
// patch.object(baseline_mod, "scan_transcript_usage", ...). A test that
// vi.spyOn(baseline, "scanTranscriptUsage") then intercepts the call.
import * as self from "./baseline.js";

const _LOG = getLogger("baseline");
void _LOG; // parity: Python binds _LOG; TS keeps it for future debug lines.

/**
 * Default context window (tokens) used as the pct-of-window denominator. This is
 * the model's actual window — the figure that matters for the subagent-overflow
 * problem this report exists to surface. It is intentionally *not*
 * compact.CONTEXT_AUTOCOMPACT_TOKENS (660,000): that is Claude Code's
 * conversation auto-compact budget, a different denominator answering a
 * different question. Override per invocation with --window.
 */
export const DEFAULT_WINDOW_TOKENS = 200_000;

/** Bytes of a persisted hook dump to sniff for owner attribution and a title. */
const _SNIFF_BYTES = 2048;

/**
 * Best-effort owner attribution from a hook dump's leading bytes. This is a
 * heuristic (the reliable signal — a transcript cross-reference — is deferred);
 * an unmatched dump is reported as `plugin:unknown` rather than guessed. First
 * match wins, so order from most to least specific if substrings ever overlap.
 */
const _PLUGIN_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ["vercel", "plugin:vercel"],
  ["supabase", "plugin:supabase"],
  ["stripe", "plugin:stripe"],
  ["atlassian", "plugin:atlassian"],
  ["firebase", "plugin:firebase"],
  ["sentry", "plugin:sentry"],
  ["goodmem", "plugin:goodmem"],
  ["=== remember ===", "plugin:remember"],
  ["remember", "plugin:remember"],
];

/**
 * Fallback per-skill-entry byte estimate for the listing injected on every
 * session start and subagent spawn. Derived from an audit of the skill listing
 * format: 71 tok/entry × 4 bytes/tok ≈ 284 bytes per entry.
 */
export const _AVG_SKILL_LISTING_ENTRY_BYTES = 284;

/** Max number of transcript .jsonl files scanned by scanTranscriptUsage. */
const _USAGE_MAX_FILES = 2000;

/**
 * Token estimate matching `token-goat doctor` and compact._token_count.
 *
 * 1 token ≈ 4 bytes — the conservative convention used across token-goat's
 * context-budget accounting. Using it here keeps a baseline total consistent
 * with the doctor's Context footprint instead of presenting a second, larger
 * number from estimate_tokens (len // 3 + 1).
 */
export function _tokensFromBytes(nBytes: number): number {
  return Math.floor(Math.max(0, nBytes) / 4);
}

// ---------------------------------------------------------------------------
// Small helpers (Python stdlib analogues)
// ---------------------------------------------------------------------------

/**
 * Reproduce Python str.splitlines(): split on \n / \r\n / \r and drop the
 * trailing empty element a bare split would keep. (Python's splitlines also
 * splits on a few exotic separators; none appear in the inputs here.)
 */
function splitLines(s: string): string[] {
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** UTF-8 byte length of a string (Python len(s.encode("utf-8"))). */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** round(x, ndigits) — half-away-from-zero (sufficient for the fractions here). */
function roundTo(x: number, ndigits: number): number {
  const factor = 10 ** ndigits;
  return Math.round(x * factor) / factor;
}

/** Decode a Buffer as UTF-8 with replacement (Python decode(errors="replace")). */
function decodeReplace(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** statSync wrapper returning the fs.Stats or undefined (never throws). */
function statOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/**
 * One attributed contributor to the session's environmental baseline.
 *
 * Ported from the frozen Python dataclass BaselineRow. Fields are readonly to
 * mirror frozen=True.
 */
export class BaselineRow {
  readonly source: string;
  readonly n_bytes: number;
  readonly tokens: number;
  readonly owner: string;
  readonly fix: string;
  readonly kind: string;
  readonly detail: string;

  constructor(args: {
    source: string;
    n_bytes: number;
    tokens: number;
    owner: string;
    fix: string;
    kind: string;
    detail?: string;
  }) {
    this.source = args.source;
    this.n_bytes = args.n_bytes;
    this.tokens = args.tokens;
    this.owner = args.owner;
    this.fix = args.fix;
    this.kind = args.kind;
    this.detail = args.detail ?? "";
  }

  /** This row's share of windowTokens, as a fraction in [0, ...]. */
  pct_of(windowTokens: number): number {
    if (windowTokens <= 0) {
      return 0.0;
    }
    return this.tokens / windowTokens;
  }

  /** JSON-serialisable view including the derived pct-of-window. */
  as_dict(windowTokens: number): Record<string, unknown> {
    return {
      source: this.source,
      bytes: this.n_bytes,
      tokens: this.tokens,
      pct_of_window: roundTo(this.pct_of(windowTokens), 4),
      owner: this.owner,
      fix: this.fix,
      kind: this.kind,
      detail: this.detail,
    };
  }
}

/** Result of collectBaseline — rows plus session/window context. */
export class BaselineReport {
  readonly rows: BaselineRow[];
  readonly window_tokens: number;
  readonly session_id: string | null;
  readonly tool_results_available: boolean;
  readonly notes: string[];

  constructor(args: {
    rows: BaselineRow[];
    window_tokens: number;
    session_id: string | null;
    tool_results_available: boolean;
    notes?: string[];
  }) {
    this.rows = args.rows;
    this.window_tokens = args.window_tokens;
    this.session_id = args.session_id;
    this.tool_results_available = args.tool_results_available;
    this.notes = args.notes ?? [];
  }

  /** Sum of every row's token cost. */
  get total_tokens(): number {
    return this.rows.reduce((acc, r) => acc + r.tokens, 0);
  }

  /** Token cost a fresh subagent inherits — kind == "fixed" rows only. */
  get fixed_tokens(): number {
    return this.rows
      .filter((r) => r.kind === "fixed")
      .reduce((acc, r) => acc + r.tokens, 0);
  }

  /** Fraction of the window tokens represents. */
  pct(tokens: number): number {
    if (this.window_tokens <= 0) {
      return 0.0;
    }
    return tokens / this.window_tokens;
  }

  /** Full JSON-serialisable report. */
  as_dict(): Record<string, unknown> {
    return {
      session_id: this.session_id,
      window_tokens: this.window_tokens,
      tool_results_available: this.tool_results_available,
      total_tokens: this.total_tokens,
      fixed_tokens: this.fixed_tokens,
      total_pct_of_window: roundTo(this.pct(this.total_tokens), 4),
      fixed_pct_of_window: roundTo(this.pct(this.fixed_tokens), 4),
      rows: this.rows.map((r) => r.as_dict(this.window_tokens)),
      notes: [...this.notes],
    };
  }
}

// ---------------------------------------------------------------------------
// Session / tool-results resolution
// ---------------------------------------------------------------------------

/**
 * Resolve [sessionId, toolResultsDir] for the report.
 *
 * Precedence: an explicit sessionId arg, then CLAUDE_SESSION_ID (set by Claude
 * Code in hook/CLI subprocesses), then — when neither is available — the
 * most-recently-modified <session>/tool-results directory across all projects (a
 * best-effort "current session" stand-in for ad-hoc CLI runs).
 *
 * Either element may be null. Never raises.
 */
function _resolveSession(
  sessionId: string | null,
): [string | null, string | null] {
  const sid = sessionId || process.env.CLAUDE_SESSION_ID || null;
  if (sid) {
    return [sid, paths.claudeSessionToolResultsDir(sid) ?? null];
  }
  return _newestToolResultsDir();
}

/**
 * Return [sessionId, dir] for the newest tool-results dir, or [null, null].
 *
 * Scans every ~/.claude/projects/<proj>/<session>/tool-results directory and
 * picks the one with the most recent mtime. Used only when no session id is
 * supplied; the resolved id is reported back so the user can --session-id
 * override if the heuristic crossed into another project.
 */
function _newestToolResultsDir(): [string | null, string | null] {
  const root = paths.claudeProjectsDir();
  let best: [number, string, string] | null = null;
  try {
    if (!statOrUndefined(root)?.isDirectory()) {
      return [null, null];
    }
    for (const projName of fs.readdirSync(root)) {
      const projDir = path.join(root, projName);
      try {
        if (!statOrUndefined(projDir)?.isDirectory()) {
          continue;
        }
        for (const sessName of fs.readdirSync(projDir)) {
          const sessDir = path.join(projDir, sessName);
          const tr = path.join(sessDir, "tool-results");
          let mtime: number;
          try {
            const st = statOrUndefined(tr);
            if (st === undefined || !st.isDirectory()) {
              continue;
            }
            mtime = st.mtimeMs;
          } catch {
            continue;
          }
          if (best === null || mtime > best[0]) {
            best = [mtime, sessName, tr];
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [null, null];
  }
  if (best === null) {
    return [null, null];
  }
  return [best[1], best[2]];
}

// ---------------------------------------------------------------------------
// Scanners — each appends rows / notes, never raises
// ---------------------------------------------------------------------------

/**
 * Best-effort [owner, title] from a hook dump's leading text.
 *
 * Owner is matched against _PLUGIN_KEYWORDS (lowercased substring, first match
 * wins), defaulting to plugin:unknown. Title is the first markdown # H1 or,
 * failing that, the first non-empty line — capped so the table stays readable.
 */
function _sniffOwnerAndTitle(head: string): [string, string] {
  const lowered = head.toLowerCase();
  let owner = "plugin:unknown";
  for (const [needle, name] of _PLUGIN_KEYWORDS) {
    if (lowered.includes(needle)) {
      owner = name;
      break;
    }
  }
  let title = "";
  for (const line of splitLines(head)) {
    const stripped = line.trim();
    if (!stripped) {
      continue;
    }
    title = stripped.startsWith("#")
      ? stripped.replace(/^[# ]+/, "").trim()
      : stripped;
    break;
  }
  // Python str slicing/len count Unicode CODE POINTS, not UTF-16 units; operate
  // on the code-point array so astral chars (emoji in H1 headings) match.
  const titleCps = [...title];
  if (titleCps.length > 60) {
    title = titleCps.slice(0, 57).join("").replace(/\s+$/, "") + "...";
  }
  return [owner, title || "hook dump"];
}

/** Mutable accumulator for content-identical hook dumps (fire-count rollup). */
interface _DumpGroup {
  n_bytes: number;
  owner: string;
  title: string;
  fires: number;
}

/**
 * Cost the persisted SessionStart/UserPromptSubmit hook dumps.
 *
 * Globs hook-*-stdout.txt (the harness's persisted-hook-output naming),
 * deduplicating by content hash: a plugin that re-injects the same dump on every
 * session start writes one identical file per fire, but a fresh subagent pays
 * that cost only once — so the report shows the distinct dump once, with a ×N
 * fires note. A dump seen more than once is treated as fixed (a per-start
 * subscription); a single-fire dump is variable (a one-off push).
 *
 * Non-hook- files in the directory (e.g. <random>.txt persisted large tool
 * outputs) are conversation, not environmental baseline, and are skipped by the
 * glob.
 */
function _scanHookDumps(
  toolResults: string | null,
  rows: BaselineRow[],
  notes: string[],
): void {
  if (toolResults === null) {
    notes.push(
      "hook dumps: no tool-results directory for this session " +
        "(no large hook output was persisted, or the session could not be resolved).",
    );
    return;
  }
  let dumpPaths: string[];
  try {
    dumpPaths = fs
      .readdirSync(toolResults)
      .filter((n) => n.startsWith("hook-") && n.endsWith("-stdout.txt"))
      .sort()
      .map((n) => path.join(toolResults, n));
  } catch (exc) {
    const cls = (exc as { constructor?: { name?: string } })?.constructor?.name ?? "Error";
    notes.push(`hook dumps: unreadable tool-results directory (${cls}).`);
    return;
  }
  if (dumpPaths.length === 0) {
    notes.push("hook dumps: none persisted this session.");
    return;
  }

  // Group identical dumps by content hash: the first occurrence records the
  // size/owner/title; later occurrences only bump the fire count.
  const groups = new Map<string, _DumpGroup>();
  for (const p of dumpPaths) {
    let data: Buffer;
    try {
      data = fs.readFileSync(p);
    } catch {
      continue;
    }
    const digest = crypto.createHash("sha256").update(data).digest("hex");
    const g = groups.get(digest);
    if (g === undefined) {
      const head = decodeReplace(data.subarray(0, _SNIFF_BYTES));
      const [owner, title] = _sniffOwnerAndTitle(head);
      groups.set(digest, { n_bytes: data.length, owner, title, fires: 1 });
    } else {
      g.fires += 1;
    }
  }

  for (const g of groups.values()) {
    const kind = g.fires > 1 ? "fixed" : "variable";
    const detail =
      g.fires > 1 ? `x${g.fires} fires this session` : "1 fire this session";
    rows.push(
      new BaselineRow({
        source: g.title,
        n_bytes: g.n_bytes,
        tokens: _tokensFromBytes(g.n_bytes),
        owner: g.owner,
        fix: "disable-hook",
        kind,
        detail,
      }),
    );
  }
}

/** Return path's size in bytes, or null if it is absent/unreadable. */
function _costFile(p: string): number | null {
  const st = statOrUndefined(p);
  if (st !== undefined && st.isFile()) {
    return st.size;
  }
  return null;
}

/**
 * Cost the global (~/.claude/CLAUDE.md) and project (./CLAUDE.md) files.
 *
 * Both are injected verbatim on every turn and are owned by the user, so the fix
 * is slim (move detail into token-goat section-served sidecars). @import
 * expansion is deferred.
 */
function _scanClaudeMd(cwd: string, rows: BaselineRow[], notes: string[]): void {
  const candidates: ReadonlyArray<readonly [string, string]> = [
    ["CLAUDE.md (global)", path.join(paths.claudeConfigDir(), "CLAUDE.md")],
    ["CLAUDE.md (project)", path.join(cwd, "CLAUDE.md")],
  ];
  let anyFound = false;
  for (const [label, p] of candidates) {
    const size = _costFile(p);
    if (size === null) {
      continue;
    }
    anyFound = true;
    rows.push(
      new BaselineRow({
        source: label,
        n_bytes: size,
        tokens: _tokensFromBytes(size),
        owner: "you",
        fix: "slim",
        kind: "fixed",
        detail: p,
      }),
    );
  }
  if (!anyFound) {
    notes.push("CLAUDE.md: none found (global or project).");
  }
}

/**
 * True when MEMORY.md is an index over sibling *.md memory files.
 *
 * The lazy pattern keeps MEMORY.md as a short one-line-per-memory index and
 * stores each fact in its own file, served on demand — so the injected cost is
 * just the index, and fix is none. Heuristic: the memory directory holds at
 * least one *.md besides MEMORY.md.
 */
export function _memoryIsAlreadyLazy(memoryMd: string): boolean {
  try {
    const parent = path.dirname(memoryMd);
    const siblings = fs
      .readdirSync(parent)
      .filter((n) => n.toLowerCase().endsWith(".md") && n.toLowerCase() !== "memory.md");
    return siblings.length > 0;
  } catch {
    return false;
  }
}

/**
 * Cost the current project's MEMORY.md auto-memory index.
 *
 * Located via the resolved session's project directory
 * (<tool-results>/../../memory/MEMORY.md) so no path-slug scheme is
 * reimplemented. When the session/tool-results dir is unknown, MEMORY.md is
 * skipped with a note rather than summed across unrelated projects.
 */
function _scanMemoryMd(
  toolResults: string | null,
  _cwd: string,
  rows: BaselineRow[],
  notes: string[],
): void {
  if (toolResults === null) {
    notes.push(
      "MEMORY.md: skipped (no session resolved to locate the project's memory dir).",
    );
    return;
  }
  const memoryMd = path.join(
    path.dirname(path.dirname(toolResults)),
    "memory",
    "MEMORY.md",
  );
  const size = _costFile(memoryMd);
  if (size === null) {
    notes.push("MEMORY.md: not found for this project.");
    return;
  }
  const lazy = _memoryIsAlreadyLazy(memoryMd);
  rows.push(
    new BaselineRow({
      source: "MEMORY.md (auto-memory index)",
      n_bytes: size,
      tokens: _tokensFromBytes(size),
      owner: "you",
      fix: lazy ? "none" : "lazy-load",
      kind: "fixed",
      detail: lazy ? "already an index over sibling files" : memoryMd,
    }),
  );
}

/**
 * Return the mcpServers keys declared in a JSON config path.
 *
 * Handles both the project .mcp.json shape (top-level mcpServers) and the user
 * ~/.claude.json shape (top-level mcpServers plus per-project
 * projects[<dir>].mcpServers). Unreadable / malformed files yield [].
 */
export function _readMcpServerNames(p: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const names: string[] = [];
  if (isPlainObject(data)) {
    const top = data["mcpServers"];
    if (isPlainObject(top)) {
      for (const k of Object.keys(top)) {
        names.push(String(k));
      }
    }
    const projects = data["projects"];
    if (isPlainObject(projects)) {
      for (const proj of Object.values(projects)) {
        if (isPlainObject(proj) && isPlainObject(proj["mcpServers"])) {
          for (const k of Object.keys(proj["mcpServers"] as Record<string, unknown>)) {
            names.push(String(k));
          }
        }
      }
    }
  }
  return names;
}

/** True for a non-null, non-array object (Python isinstance(x, dict)). */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Return [name, descriptionFirstLine] from a SKILL.md YAML frontmatter block.
 *
 * Returns ["", ""] when the file is absent, unreadable, or has no frontmatter.
 */
export function _parseSkillMdFrontmatter(p: string): [string, string] {
  let head: string;
  try {
    const buf = fs.readFileSync(p);
    head = decodeReplace(buf.subarray(0, 512));
  } catch {
    return ["", ""];
  }
  if (!head.startsWith("---")) {
    return ["", ""];
  }
  let name = "";
  let descFirst = "";
  let inDesc = false;
  const lines = splitLines(head).slice(1);
  for (const line of lines) {
    if (line.startsWith("---")) {
      break;
    }
    if (line.startsWith("name:") && !name) {
      name = stripQuotes(line.slice(5).trim());
    } else if (line.startsWith("description:") && !descFirst) {
      const val = line.slice(12).trim();
      if (val && val !== "|") {
        // Python [:150] counts code points, not UTF-16 units.
        descFirst = [...val].slice(0, 150).join("");
        inDesc = false;
      } else {
        inDesc = true;
      }
    } else if (inDesc && line.startsWith("  ") && !descFirst) {
      descFirst = [...line.trim()].slice(0, 150).join("");
      inDesc = false;
    }
  }
  return [name, descFirst];
}

/** Python str.strip("\"'") — strip leading/trailing single + double quotes. */
function stripQuotes(s: string): string {
  return s.replace(/^["']+/, "").replace(/["']+$/, "");
}

/**
 * Estimate the listing bytes for one skill entry.
 *
 * Reads SKILL.md frontmatter for a real name + description length. Falls back to
 * _AVG_SKILL_LISTING_ENTRY_BYTES when the file is absent or has no parseable
 * description.
 */
export function _skillListingEntryBytes(skillDir: string): number {
  let [name, desc] = _parseSkillMdFrontmatter(path.join(skillDir, "SKILL.md"));
  if (!name) {
    name = path.basename(skillDir);
  }
  if (!desc) {
    return _AVG_SKILL_LISTING_ENTRY_BYTES;
  }
  const raw = byteLen(name) + 2 + byteLen(desc);
  return Math.max(4, raw + Math.floor(raw / 3));
}

/** Return enabled plugin@marketplace keys from settings.json. */
export function _readEnabledPluginNames(settingsPath: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return [];
  }
  if (!isPlainObject(data)) {
    return [];
  }
  const enabled = data["enabledPlugins"];
  if (!isPlainObject(enabled)) {
    return [];
  }
  return Object.entries(enabled)
    .filter(([, v]) => v === true)
    .map(([k]) => String(k));
}

/**
 * Return [pluginSlug, skillDir] pairs for all enabled plugins.
 *
 * Resolves via marketplacesRoot/<marketplace>/plugins/<plugin>/skills/. Silently
 * skips any entry that cannot be read.
 */
function _enumeratePluginSkillDirs(
  enabledPluginNames: string[],
  marketplacesRoot: string,
): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  for (const entry of enabledPluginNames) {
    if (!entry.includes("@")) {
      continue;
    }
    const at = entry.lastIndexOf("@");
    const pluginSlug = entry.slice(0, at);
    const marketplace = entry.slice(at + 1);
    const skillsDir = path.join(
      marketplacesRoot,
      marketplace,
      "plugins",
      pluginSlug,
      "skills",
    );
    try {
      if (statOrUndefined(skillsDir)?.isDirectory()) {
        for (const name of fs.readdirSync(skillsDir)) {
          const skillDir = path.join(skillsDir, name);
          if (statOrUndefined(skillDir)?.isDirectory()) {
            results.push([pluginSlug, skillDir]);
          }
        }
      }
    } catch {
      // suppress OSError
    }
  }
  return results;
}

/** Cost the skill listing injected on every session start and subagent spawn. */
function _scanSkillListing(
  rows: BaselineRow[],
  notes: string[],
  skillUsage: Record<string, number> | null,
): void {
  const userSkillsDir = paths.claudeSkillsDir();
  let userSkillDirs: string[] = [];
  try {
    if (statOrUndefined(userSkillsDir)?.isDirectory()) {
      userSkillDirs = fs
        .readdirSync(userSkillsDir)
        .map((n) => path.join(userSkillsDir, n))
        .filter((d) => statOrUndefined(d)?.isDirectory());
    }
  } catch {
    // suppress OSError
  }
  const settingsPath = path.join(paths.claudeConfigDir(), "settings.json");
  const enabledPlugins = _readEnabledPluginNames(settingsPath);
  const marketplacesRoot = path.join(paths.claudePluginsDir(), "marketplaces");
  const pluginSkillEntries = _enumeratePluginSkillDirs(
    enabledPlugins,
    marketplacesRoot,
  );
  const totalSkillDirs = [
    ...userSkillDirs,
    ...pluginSkillEntries.map(([, d]) => d),
  ];
  if (totalSkillDirs.length === 0) {
    notes.push(
      "Skill listing: no skill dirs found (empty skills dir and no enabled plugin skills).",
    );
    return;
  }
  const totalBytes = totalSkillDirs.reduce(
    (acc, d) => acc + _skillListingEntryBytes(d),
    0,
  );
  const totalTokens = Math.floor(totalBytes / 4);
  const nUser = userSkillDirs.length;
  const nPlugin = pluginSkillEntries.length;
  const detailParts: string[] = [
    `${nUser} user + ${nPlugin} plugin skills`,
    "re-pays on every session start and subagent spawn",
  ];
  if (skillUsage !== null) {
    const allNames = new Set(totalSkillDirs.map((d) => path.basename(d)));
    let everUsed = 0;
    for (const name of allNames) {
      if ((skillUsage[name] ?? 0) > 0) {
        everUsed += 1;
      }
    }
    const zeroUse = [...allNames]
      .filter((name) => (skillUsage[name] ?? 0) === 0)
      .sort();
    detailParts.push(`${everUsed}/${allNames.size} skills ever called`);
    if (zeroUse.length > 0) {
      const preview = zeroUse.slice(0, 5).join(", ");
      const suffix = zeroUse.length > 5 ? ` + ${zeroUse.length - 5} more` : "";
      detailParts.push(`zero-use: ${preview}${suffix}`);
    }
  }
  rows.push(
    new BaselineRow({
      source: `Skill listing (${totalSkillDirs.length} skills)`,
      n_bytes: totalBytes,
      tokens: totalTokens,
      owner: "you",
      fix: "archive-unused",
      kind: "fixed",
      detail: detailParts.join("; "),
    }),
  );
}

/**
 * Normalize an MCP server name to lowercase alphanum+underscore for fuzzy
 * matching.
 */
function _normalizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

/**
 * Exact call count for serverName matched against transcript tool-name prefixes.
 *
 * Normalizes both sides with _normalizeServerName so punctuation and casing
 * differences (e.g. "claude.ai Vercel" vs "claude_ai_Vercel") resolve to the
 * same key without the false-positive risk of substring matching.
 */
function _mcpCallCount(
  serverName: string,
  mcpCounts: Record<string, number>,
): number {
  const norm = _normalizeServerName(serverName);
  let total = 0;
  for (const [key, count] of Object.entries(mcpCounts)) {
    if (_normalizeServerName(key) === norm) {
      total += count;
    }
  }
  return total;
}

/**
 * Parse one JSONL transcript line and tally Skill and MCP tool calls in-place.
 */
export function _tallyToolCalls(
  line: string,
  skillCounts: Record<string, number>,
  mcpCounts: Record<string, number>,
): void {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!isPlainObject(obj)) {
    return;
  }
  const msgRaw = "message" in obj ? obj["message"] : obj;
  if (!isPlainObject(msgRaw)) {
    return;
  }
  const content = "content" in msgRaw ? msgRaw["content"] : [];
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!isPlainObject(block) || block["type"] !== "tool_use") {
      continue;
    }
    const name = "name" in block ? block["name"] : "";
    if (typeof name !== "string") {
      continue;
    }
    if (name === "Skill") {
      const inp = "input" in block ? block["input"] : {};
      if (isPlainObject(inp)) {
        const skill = "skill" in inp ? inp["skill"] : "";
        if (skill && typeof skill === "string") {
          skillCounts[skill] = (skillCounts[skill] ?? 0) + 1;
        }
      }
    } else if (name.startsWith("mcp__")) {
      const parts = name.split("__");
      if (parts.length >= 2) {
        const server = parts[1]!;
        mcpCounts[server] = (mcpCounts[server] ?? 0) + 1;
      }
    }
  }
}

/**
 * Stream project transcripts and tally Skill and MCP tool calls.
 *
 * Returns [{skillName: callCount}, {mcpServerPrefix: callCount}]. Reads the
 * maxFiles most-recently-modified .jsonl files under projectsRoot (defaults to
 * paths.claudeProjectsDir). Never raises.
 */
export function scanTranscriptUsage(
  projectsRoot: string | null = null,
  maxFiles: number = _USAGE_MAX_FILES,
): [Record<string, number>, Record<string, number>] {
  const root = projectsRoot !== null ? projectsRoot : paths.claudeProjectsDir();
  const skillCounts: Record<string, number> = {};
  const mcpCounts: Record<string, number> = {};
  let jsonlFiles: string[];
  try {
    const all = rglobJsonl(root);
    all.sort((a, b) => {
      const ma = statOrUndefined(a)?.mtimeMs ?? 0;
      const mb = statOrUndefined(b)?.mtimeMs ?? 0;
      return mb - ma;
    });
    jsonlFiles = all.slice(0, maxFiles);
  } catch {
    return [skillCounts, mcpCounts];
  }
  for (const jsonlPath of jsonlFiles) {
    let text: string;
    try {
      text = fs.readFileSync(jsonlPath, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"Skill"') && !line.includes('"mcp__')) {
        continue;
      }
      _tallyToolCalls(line, skillCounts, mcpCounts);
    }
  }
  return [skillCounts, mcpCounts];
}

/** Recursively collect all *.jsonl file paths under root (Python rglob). */
function rglobJsonl(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Enumerate configured MCP servers — one 0-token row per server.
 *
 * The instruction block each server injects lives on the server, not on disk, so
 * it cannot be costed from local files. We emit a visible 0-token row per server
 * so each appears as a removable line item. With --usage the row's detail also
 * reports historical call count so zero-use servers stand out as removal
 * candidates.
 */
function _scanMcp(
  cwd: string,
  rows: BaselineRow[],
  notes: string[],
  mcpUsage: Record<string, number> | null,
): void {
  const serverNames: string[] = [];
  try {
    serverNames.push(..._readMcpServerNames(path.join(cwd, ".mcp.json")));
  } catch {
    // suppress
  }
  try {
    serverNames.push(
      ..._readMcpServerNames(
        path.join(path.dirname(paths.claudeConfigDir()), ".claude.json"),
      ),
    );
  } catch {
    // suppress
  }
  try {
    serverNames.push(
      ..._readMcpServerNames(path.join(os.homedir(), ".claude.json")),
    );
  } catch {
    // suppress
  }
  // Dedupe, preserve first-seen order.
  const seen = new Map<string, null>();
  for (const n of serverNames) {
    if (!seen.has(n)) {
      seen.set(n, null);
    }
  }
  const unique = [...seen.keys()];
  if (unique.length === 0) {
    notes.push("MCP: no configured servers found in .mcp.json / ~/.claude.json.");
    return;
  }
  for (const server of unique) {
    const detailParts: string[] = [
      "schema not costed (lives on the server); re-pays on every subagent spawn",
    ];
    if (mcpUsage !== null) {
      const calls = _mcpCallCount(server, mcpUsage);
      if (calls === 0) {
        detailParts.push("0 calls ever — removal candidate");
      } else {
        detailParts.push(`${formatThousands(calls)} calls ever`);
      }
    }
    rows.push(
      new BaselineRow({
        source: `MCP: ${server}`,
        n_bytes: 0,
        tokens: 0,
        owner: "harness",
        fix: "disable-mcp",
        kind: "fixed",
        detail: detailParts.join("; "),
      }),
    );
  }
  const sortedUnique = [...unique].sort();
  notes.push(
    `MCP: ${unique.length} server(s) configured (${sortedUnique.join(", ")}) — ` +
      "not all are necessarily active this session (plugin-bundled servers are not " +
      "listed here). Each active one injects an instruction block; disable unused ones " +
      "with `claude mcp remove <name>`.",
  );
}

/** Python f"{n:,}" — thousands-separated integer. */
function formatThousands(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scan and attribute the session's environmental baseline.
 *
 * Runs every source scanner fail-soft (a broken source becomes a note, not an
 * exception), costs each contributor at bytes // 4, and returns a
 * BaselineReport with rows sorted by token cost descending.
 *
 * @param cwd The project working directory (locates the project CLAUDE.md).
 * @param sessionId Explicit session id; falls back to CLAUDE_SESSION_ID then the
 *   newest tool-results directory.
 * @param windowTokens Denominator for pct-of-window (default the 200k window).
 * @param usage When true, stream project transcripts to annotate rows with
 *   historical call counts and flag zero-use skills / MCP servers.
 */
export function collectBaseline(
  cwd: string,
  sessionId: string | null = null,
  options: { windowTokens?: number; usage?: boolean } = {},
): BaselineReport {
  const windowTokens = options.windowTokens ?? DEFAULT_WINDOW_TOKENS;
  const usage = options.usage ?? false;

  const rows: BaselineRow[] = [];
  const notes: string[] = [];
  const [sid, toolResults] = _resolveSession(sessionId);

  let skillUsage: Record<string, number> | null = null;
  let mcpUsage: Record<string, number> | null = null;
  if (usage) {
    [skillUsage, mcpUsage] = self.scanTranscriptUsage();
  }

  _scanHookDumps(toolResults, rows, notes);
  _scanClaudeMd(cwd, rows, notes);
  _scanMemoryMd(toolResults, cwd, rows, notes);
  _scanSkillListing(rows, notes, skillUsage);
  _scanMcp(cwd, rows, notes, mcpUsage);

  // Stable sort by tokens descending (Python list.sort is stable).
  rows.sort((a, b) => b.tokens - a.tokens);
  notes.push(
    "Loaded-skill body cost: run `token-goat doctor` " +
      "(skills invoked in a session load their full SKILL.md separately).",
  );
  return new BaselineReport({
    rows,
    window_tokens: windowTokens,
    session_id: sid,
    tool_results_available: toolResults !== null,
    notes,
  });
}

// ---------------------------------------------------------------------------
// Rendering (pure — testable without the CLI)
// ---------------------------------------------------------------------------

/** Render a fraction as a one-decimal percentage (e.g. 7.4%). */
function _fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Render report as plain-text lines (the default, non-JSON CLI output).
 *
 * With subagent true, shows only the fixed sources a freshly spawned agent
 * inherits and frames the total as its starting fill — the figure that answers
 * "how full is a subagent before its first action?".
 */
export function formatReport(
  report: BaselineReport,
  options: { subagent?: boolean } = {},
): string[] {
  const subagent = options.subagent ?? false;
  const selected = subagent
    ? report.rows.filter((r) => r.kind === "fixed")
    : [...report.rows];
  const shortSid = (report.session_id || "unknown").slice(0, 8);
  const win = report.window_tokens;

  const lines: string[] = [];
  if (subagent) {
    lines.push(
      `Subagent spawn baseline — fixed sources a fresh agent inherits  (session ${shortSid})`,
    );
  } else {
    lines.push(`Session baseline — ${shortSid}  (window ${formatThousands(win)} tok)`);
  }
  lines.push("");

  if (selected.length === 0) {
    lines.push("  (no baseline sources measured — see notes below)");
  } else {
    lines.push(
      `  ${rjust("TOKENS", 8)}  ${rjust("%WIN", 5)}  ${ljust("OWNER", 16)}${ljust("FIX", 14)}SOURCE`,
    );
    for (const r of selected) {
      lines.push(
        `  ${rjust(formatThousands(r.tokens), 8)}  ${rjust(_fmtPct(r.pct_of(win)), 5)}  ` +
          `${ljust(r.owner, 16)}${ljust(r.fix, 14)}${r.source}` +
          (r.detail ? `  [${r.detail}]` : ""),
      );
    }
    lines.push("  " + "-".repeat(6));
  }

  if (subagent) {
    const fixed = report.fixed_tokens;
    lines.push(
      `  A spawned agent starts at ~${formatThousands(fixed)} tok ` +
        `(${_fmtPct(report.pct(fixed))} of a ${formatThousands(win)}-tok window) before its first action.`,
    );
  } else {
    const total = report.total_tokens;
    const fixed = report.fixed_tokens;
    lines.push(
      `  ~${formatThousands(total)} tok total (${_fmtPct(report.pct(total))} of a ${formatThousands(win)}-tok window)` +
        `   fixed/recurring: ~${formatThousands(fixed)} tok`,
    );
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const n of report.notes) {
      lines.push(`  - ${n}`);
    }
  }
  return lines;
}

/** Python f"{s:>width}" — right-justify s to width with spaces. */
function rjust(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** Python f"{s:<width}" — left-justify s to width with spaces. */
function ljust(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
