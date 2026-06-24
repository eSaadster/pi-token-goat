/**
 * Single-command post-compact restoration packet (item 25) — TypeScript port of
 * src/token_goat/resume.py.
 *
 * `token-goat resume <session_id>` emits a structured context bundle that
 * replaces 5-10 individual recall round-trips the agent would otherwise need
 * after a compaction event:
 *
 *   1. Skill checklists inline (up to 3 skills, <= 400 chars each).
 *   2. Last 2 Bash outputs - first 20 + last 20 lines with a gap marker.
 *   3. Per-file diffs for the top 2 edited files (`git diff HEAD <path>`).
 *   4. Current git diff stat summary.
 *
 * Each section carries a freshness annotation (`as of HH:MM`) so the agent can
 * judge staleness without running additional commands. Total output is
 * hard-capped at _MAX_RESUME_TOKENS (~ 2000 tokens ~ 8000 chars) so one command
 * cannot balloon the context unexpectedly.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY (snake_case) for every name a test
 *    imports / asserts on: build_resume_packet + the _SKILL_MAX_CHARS_EACH /
 *    _MAX_RESUME_CHARS module constants. The internal helpers a test spies on
 *    (_load_bash_output, _inline_diff, _git_diff_stat) keep their Python names.
 *  - char-budget math uses code-point length (`.length`), matching Python
 *    `len(str)` for the BMP text the packet carries.
 *  - time.strftime("%H:%M") (LOCAL time) -> Date local getters formatted to
 *    HH:MM. time.strftime("%H:%M", time.localtime(ts)) likewise uses LOCAL
 *    getters on a Date built from ts seconds. (Python uses local time here, not
 *    UTC; the tests only assert the literal "as of" substring, never the exact
 *    clock value, so the local-vs-UTC choice is unobservable but kept faithful.)
 *  - Python's lazy `from . import bash_cache` / `from . import skill_cache`
 *    inside the helpers are mirrored as injection seams (_setSkillCacheModule /
 *    _setBashCacheModule + best-effort resolvers). Both modules are now ported, so
 *    each seam DEFAULTS to its real module; the setter is retained so tests can
 *    stub it or force the fail-soft null branch. The resolver still returns null
 *    when forced, so the helpers never throw.
 *  - The diff + stat helpers (_inline_diff, _git_diff_stat) delegate to the
 *    shipped compact module via a STATIC `import * as compact` so the Python
 *    `from .compact import _get_inline_diff_for_file` lazy import is reproduced.
 *  - Internal call sites that a test patches (resume._load_bash_output /
 *    resume._inline_diff / resume._git_diff_stat) route through `self.` (the
 *    same static `import * as self` pattern git_history.ts / bridges.ts use) so
 *    a namespace-level vi.spyOn intercepts them. Verbatim semantics.
 *  - session.load is reached via the static `import * as session` so the
 *    TestEmptySession tests can vi.spyOn(session, "load").
 *
 * verbatimModuleSyntax is on -> type-only imports use `import type`.
 * exactOptionalPropertyTypes is on -> optional fields are `T | undefined`.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import * as session from "./session.js";
import * as compact from "./compact.js";
import * as bash_cache from "./bash_cache.js";
import * as skill_cache from "./skill_cache.js";
import * as self from "./resume.js";
import { getLogger } from "./util.js";
import { registerReset } from "./reset.js";

import type { SessionCache } from "./session.js";

export const __all__ = ["build_resume_packet"] as const;

const _LOG = getLogger("resume");

const _MAX_RESUME_TOKENS = 2000;
// Approximate chars-per-token for the hard cap. Conservative (4 chars/tok) so we
// stay safely under the limit even for code-heavy content.
const _CHARS_PER_TOKEN = 4;
export const _MAX_RESUME_CHARS = _MAX_RESUME_TOKENS * _CHARS_PER_TOKEN; // 8000

// Per-section char budgets (soft limits; hard cap enforced at assembly time).
export const _SKILL_MAX_CHARS_EACH = 400;
const _SKILL_MAX_COUNT = 3;
const _BASH_HEAD_LINES = 20;
const _BASH_TAIL_LINES = 20;
const _BASH_MAX_COUNT = 2;
const _DIFF_MAX_COUNT = 2;

// ---------------------------------------------------------------------------
// skill_cache / bash_cache seams.
// ---------------------------------------------------------------------------
// The Python resume does lazy `from . import bash_cache` / `from . import
// skill_cache` inside the section helpers and wraps every call in try/except
// returning a fail-soft default. bash_cache.ts is now ported, so the bash_cache
// seam DEFAULTS to the real module (static `import * as bash_cache`); the setter
// is retained so tests can stub it, force the fail-soft null branch, or restore
// the real default (undefined), and reset.ts restores the default. skill_cache.ts
// is now ported too, so that seam ALSO defaults to the real module the same way —
// tests inject a mock (or null to force fail-soft) via _setSkillCacheModule.

interface _BashCacheModule {
  load_output(output_id: string): string | null;
}

interface _SkillCacheModule {
  load_output(output_id: string): string | null;
  extract_checklist_section(body: string): string | null;
}

// bash_cache default is the real module; `undefined` override = use default,
// explicit `null` = force fail-soft, object = test stub.
const _bashCacheDefault: _BashCacheModule = bash_cache;
let _bashCacheModuleOverride: _BashCacheModule | null | undefined;
// skill_cache default is the real module too; `undefined` override = use default,
// explicit `null` = force fail-soft, object = test stub.
const _skillCacheDefault: _SkillCacheModule = skill_cache;
let _skillCacheModuleOverride: _SkillCacheModule | null | undefined;

/**
 * Test/late-layer seam: inject a bash_cache implementation. Pass `null` to force
 * the fail-soft (no-module) path, or `undefined` to restore the real default.
 */
export function _setBashCacheModule(mod: _BashCacheModule | null | undefined): void {
  _bashCacheModuleOverride = mod;
}

/**
 * Test/late-layer seam: inject a skill_cache implementation. Pass `null` to force
 * the fail-soft (no-module) path, or `undefined` to restore the real default.
 */
export function _setSkillCacheModule(mod: _SkillCacheModule | null | undefined): void {
  _skillCacheModuleOverride = mod;
}

registerReset(() => {
  // Restore the real-module default for both bash_cache and skill_cache.
  _bashCacheModuleOverride = undefined;
  _skillCacheModuleOverride = undefined;
});

/**
 * Resolve the bash_cache module: an explicit override (object or null) wins,
 * else the real module default. Returns null only when a test forced it.
 */
function _getBashCache(): _BashCacheModule | null {
  if (_bashCacheModuleOverride !== undefined) {
    return _bashCacheModuleOverride;
  }
  return _bashCacheDefault;
}

/**
 * Resolve the skill_cache module: an explicit override (object or null) wins,
 * else the real module default. Returns null only when a test forced it.
 */
function _getSkillCache(): _SkillCacheModule | null {
  if (_skillCacheModuleOverride !== undefined) {
    return _skillCacheModuleOverride;
  }
  return _skillCacheDefault;
}

// ---------------------------------------------------------------------------
// Time helpers.
// ---------------------------------------------------------------------------

function _pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Return the current LOCAL time as HH:MM. (Python time.strftime("%H:%M").) */
function _now_hhmm(): string {
  const d = new Date();
  return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
}

/** Return *ts* (unix timestamp, seconds) as HH:MM LOCAL time. */
function _ts_hhmm(ts: number): string {
  const d = new Date(ts * 1000);
  return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
}

/** Return head + gap + tail, or the full list when it is short enough. */
function _head_tail(lines: string[], head: number, tail: number): string {
  const n = lines.length;
  if (n <= head + tail) {
    return lines.join("\n");
  }
  const head_part = lines.slice(0, head);
  const tail_part = lines.slice(n - tail);
  const gap = `--- ${n - head - tail} lines omitted ---`;
  return head_part.join("\n") + "\n" + gap + "\n" + tail_part.join("\n");
}

/**
 * Python str.splitlines() over the output text. Splits on universal newlines
 * and never keeps a trailing empty element for a final line terminator.
 */
function _splitlines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

// ---------------------------------------------------------------------------
// Section helpers (lazy `from . import ...` analogues; fail-soft to null/"").
// ---------------------------------------------------------------------------

/** Load cached bash output text by output_id. Fail-soft. (Python _load_bash_output.) */
export function _load_bash_output(output_id: string): string | null {
  try {
    const bash_cache = _getBashCache();
    if (bash_cache === null) {
      return null;
    }
    return bash_cache.load_output(output_id);
  } catch {
    return null;
  }
}

/** Return a short git diff for *path* via compact._get_inline_diff_for_file. */
export function _inline_diff(path: string, cwd: string | null): string | null {
  if (!cwd) {
    return null;
  }
  try {
    return compact._get_inline_diff_for_file(path, cwd);
  } catch {
    return null;
  }
}

/** Return the git diff stat summary via compact._get_git_diff_stat_summary. */
export function _git_diff_stat(cwd: string | null): string {
  if (!cwd) {
    return "";
  }
  try {
    return compact._get_git_diff_stat_summary(cwd);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Small getattr-style accessors for the spy-friendly `unknown` cache surface.
// ---------------------------------------------------------------------------

function _attr(obj: unknown, name: string): unknown {
  if (obj !== null && typeof obj === "object" && name in obj) {
    return (obj as Record<string, unknown>)[name];
  }
  return undefined;
}

function _strAttr(obj: unknown, name: string, fallback: string): string {
  const v = _attr(obj, name);
  if (v === null || v === undefined) {
    return fallback;
  }
  return typeof v === "string" ? v : String(v);
}

function _numAttr(obj: unknown, name: string, fallback: number): number {
  const v = _attr(obj, name);
  return typeof v === "number" ? v : fallback;
}

function _isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// build_resume_packet
// ---------------------------------------------------------------------------

/**
 * Build and return the full resume packet for *session_id*.
 *
 * Assembles up to four sections:
 *
 *   1. Skills - checklist excerpts (<= 400 chars each, up to 3 skills).
 *   2. Bash   - head+tail views of the last 2 cached bash outputs.
 *   3. Diffs  - `git diff HEAD` for the top 2 edited files.
 *   4. Stat   - whole-repo `git diff --stat HEAD` summary.
 *
 * Total output is hard-capped at _MAX_RESUME_CHARS so one command cannot balloon
 * the context window. Returns an empty string when the session cache is
 * unavailable or empty.
 */
export function build_resume_packet(session_id: string): string {
  let cache: SessionCache;
  try {
    cache = session.load(session_id);
  } catch {
    // Python catches (OSError, ValueError); validate_session_id raises ValueError
    // and a disk failure raises OSError. Any failure short-circuits to "".
    return "";
  }
  if (cache.unavailable) {
    return "";
  }

  const now_str = _now_hhmm();
  const header = `## Resume — session ${session_id.slice(0, 8)} (as of ${now_str})`;
  const parts: string[] = [header];
  let char_budget = _MAX_RESUME_CHARS - header.length;

  // -----------------------------------------------------------------------
  // Section 1: Skill checklists
  // -----------------------------------------------------------------------
  const skill_hist = (_attr(cache, "skill_history") as Record<string, unknown> | null | undefined) ?? {};
  if (_isDict(skill_hist) && Object.keys(skill_hist).length > 0) {
    try {
      const _skill_cache = _getSkillCache();

      const skill_entries = Object.values(skill_hist)
        .slice()
        .sort((a, b) => _numAttr(b, "ts", 0.0) - _numAttr(a, "ts", 0.0))
        .slice(0, _SKILL_MAX_COUNT);

      const skill_lines: string[] = ["### Skills"];
      for (const se of skill_entries) {
        const name = _strAttr(se, "skill_name", "?");
        const output_id = _attr(se, "output_id");
        const output_id_str = typeof output_id === "string" ? output_id : null;
        const ts = _numAttr(se, "ts", 0.0);
        const ts_str = ts ? _ts_hhmm(ts) : now_str;
        let checklist: string | null = null;
        if (output_id_str && _skill_cache !== null) {
          const body = _skill_cache.load_output(output_id_str);
          if (body) {
            checklist = _skill_cache.extract_checklist_section(body);
          }
        }
        if (checklist) {
          // Trim to per-skill budget.
          if (checklist.length > _SKILL_MAX_CHARS_EACH) {
            checklist = _rstrip(checklist.slice(0, _SKILL_MAX_CHARS_EACH)) + "…";
          }
          skill_lines.push(`**${name}** (as of ${ts_str}):`);
          skill_lines.push(checklist);
        } else {
          skill_lines.push(
            `**${name}** (as of ${ts_str}) — ` +
              `\`token-goat skill-body ${name} --section DoD\``,
          );
        }
      }
      const skill_block = skill_lines.join("\n");
      if (skill_block.length <= char_budget) {
        parts.push(skill_block);
        char_budget -= skill_block.length;
      }
    } catch {
      // fail-soft
    }
  }

  // -----------------------------------------------------------------------
  // Section 2: Recent Bash outputs (head + tail)
  // -----------------------------------------------------------------------
  const bash_hist = (_attr(cache, "bash_history") as Record<string, unknown> | null | undefined) ?? {};
  if (_isDict(bash_hist) && Object.keys(bash_hist).length > 0 && char_budget > 200) {
    try {
      const bash_entries = Object.values(bash_hist)
        .slice()
        .sort((a, b) => _numAttr(b, "ts", 0.0) - _numAttr(a, "ts", 0.0))
        .slice(0, _BASH_MAX_COUNT);

      const bash_lines: string[] = ["### Bash outputs"];
      for (const be of bash_entries) {
        const cmd = _strAttr(be, "cmd_preview", "?");
        const output_id = _attr(be, "output_id");
        const output_id_str = typeof output_id === "string" ? output_id : null;
        const ts = _numAttr(be, "ts", 0.0);
        const ts_str = ts ? _ts_hhmm(ts) : now_str;
        const exit_code_raw = _attr(be, "exit_code");
        const exit_str =
          exit_code_raw !== null && exit_code_raw !== undefined ? ` exit=${String(exit_code_raw)}` : "";
        bash_lines.push(`**\`${cmd}\`** (${ts_str}${exit_str}):`);
        if (output_id_str) {
          const text = self._load_bash_output(output_id_str);
          if (text) {
            const raw_lines = _splitlines(text);
            bash_lines.push(_head_tail(raw_lines, _BASH_HEAD_LINES, _BASH_TAIL_LINES));
          } else {
            bash_lines.push(`\`token-goat bash-output ${output_id_str.slice(0, 16)}\` (body evicted)`);
          }
        } else {
          bash_lines.push("(no output_id)");
        }
      }
      const bash_block = bash_lines.join("\n");
      // Trim to remaining budget (leave at least 400 chars for diff + stat).
      if (bash_block.length <= char_budget - 400) {
        parts.push(bash_block);
        char_budget -= bash_block.length;
      } else if (char_budget > 400) {
        // Partial: emit truncated bash block up to budget.
        const trimmed = bash_block.slice(0, char_budget - 400);
        parts.push(trimmed + "\n--- bash section truncated ---");
        char_budget = 400;
      }
    } catch {
      // fail-soft
    }
  }

  // -----------------------------------------------------------------------
  // Section 3: Per-file diffs for top edited files
  // -----------------------------------------------------------------------
  const cwd = (_attr(cache, "cwd") as string | null | undefined) ?? null;
  const edited = (_attr(cache, "edited_files") as Record<string, unknown> | null | undefined) ?? {};
  if (_isDict(edited) && Object.keys(edited).length > 0 && cwd && char_budget > 100) {
    try {
      // Sort by edit count descending, take top DIFF_MAX_COUNT.
      const top_edited = Object.entries(edited)
        .map(([k, v]) => [k, typeof v === "number" ? v : Number(v) || 0] as [string, number])
        .sort((a, b) => b[1] - a[1]);
      const diff_lines: string[] = ["### Diffs (top edited files)"];
      let shown = 0;
      for (const [path, count] of top_edited) {
        if (shown >= _DIFF_MAX_COUNT) {
          break;
        }
        if (char_budget <= 100) {
          break;
        }
        const diff_text = self._inline_diff(path, cwd);
        if (diff_text) {
          const entry = `**${path}** (edited ×${count}, as of ${now_str}):\n\`\`\`diff\n${diff_text}\n\`\`\``;
          if (entry.length <= char_budget - 50) {
            diff_lines.push(entry);
            char_budget -= entry.length;
            shown += 1;
          }
        }
      }
      if (diff_lines.length > 1) {
        // more than just the header
        parts.push(diff_lines.join("\n"));
      }
    } catch {
      // fail-soft
    }
  }

  // -----------------------------------------------------------------------
  // Section 4: Git diff stat summary
  // -----------------------------------------------------------------------
  if (cwd && char_budget > 50) {
    try {
      const stat = self._git_diff_stat(cwd);
      if (stat) {
        const stat_block = `### Git stat (as of ${now_str})\n${stat}`;
        if (stat_block.length <= char_budget) {
          parts.push(stat_block);
        }
      }
    } catch {
      // fail-soft
    }
  }

  if (parts.length <= 1) {
    return "";
  }

  return parts.join("\n\n");
}

// Reference the logger so the unused-binding lint does not fire; _LOG is kept
// for parity with the sibling modules' getLogger("<module>") convention and is
// available for future debug statements.
void _LOG;
