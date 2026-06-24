/**
 * Implementation of `token-goat context-stats` — TS port of cli_context_stats.py.
 *
 * Shows the estimated startup context footprint broken down by source and
 * optionally runs safe structural pruning on the project's MEMORY.md index.
 *
 * Output seam: Python `typer.echo` → `_echo` (cli_common). The JSON dump uses
 * `json.dumps(out, indent=2)` → `JSON.stringify(out, null, 2)` (NOT compact).
 *
 * Dep note: `memory_prune` (parse_index / prune_index / find_content_duplicates
 * / audit_claude_md) is ported. `DupCluster.members` is `string[]` in the TS
 * port (Python iterates `m.name`; here `m` IS the name string).
 */
import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";

import * as memory_prune from "./memory_prune.js";
import { claudeProjectsDir } from "./paths.js";
import { _echo } from "./cli_common.js";

// Known-constant overhead estimates (tokens) — see context-stats design notes.
const _SYSTEM_PROMPT_EST = 57_000; // system prompt + harness overhead
const _SKILL_AGENT_EST = 14_000; // skill listing + agent listing injected at start
const _CONTEXT_WINDOW = 200_000; // model window (conservative; Sonnet/Haiku = 200k)

/** Resolve a path (Python `Path.resolve()`). */
function _resolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** CLAUDE.md files loaded for *projectRoot*: walk up + global ~/.claude/CLAUDE.md. */
function _findClaudeMdFiles(projectRoot: string): string[] {
  const found: string[] = [];
  let current = _resolve(projectRoot);
  while (true) {
    const candidate = path.join(current, "CLAUDE.md");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      found.push(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const globalMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
  if (fs.existsSync(globalMd) && fs.statSync(globalMd).isFile() && !found.includes(globalMd)) {
    found.push(globalMd);
  }
  return found;
}

/** The MEMORY.md for *projectRoot* by scanning Claude's projects dir. */
function _findMemoryMd(projectRoot: string): string | null {
  try {
    const projectsDir = claudeProjectsDir();
    if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) {
      return null;
    }
    const rootStr = _resolve(projectRoot);
    // Claude slugifies the path (non-alphanumerics → "-").
    const expectedSlug = rootStr.replace(/[^A-Za-z0-9]/g, "-").replace(/^-+|-+$/g, "");
    const candidate = path.join(projectsDir, expectedSlug, "memory", "MEMORY.md");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    // Fallback: scan project dirs for one whose slug matches.
    for (const name of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, name);
      try {
        if (!fs.statSync(projDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const mem = path.join(projDir, "memory", "MEMORY.md");
      if (fs.existsSync(mem) && fs.statSync(mem).isFile() && name === expectedSlug) {
        return mem;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Token estimate for a file (bytes // 4). */
function _tok(filePath: string): number {
  try {
    return Math.max(0, fs.statSync(filePath).size) / 4 | 0; // integer floor
  } catch {
    return 0;
  }
}

/** `f"{tokens/_CONTEXT_WINDOW*100:.1f}%"`. */
function _pct(tokens: number): string {
  return `${((tokens / _CONTEXT_WINDOW) * 100).toFixed(1)}%`;
}

/** Whether *child* is inside *parent* (Python `Path.is_relative_to`). */
function _isRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Entry point for `token-goat context-stats`. Port of cli_context_stats.run. */
export function run(args: {
  fix: boolean;
  json_out: boolean;
  project: string | null;
}): void {
  const { fix, json_out } = args;
  const projectRoot = _resolve(args.project ?? process.cwd());

  // --- Collect CLAUDE.md files ---
  const claudeMds = _findClaudeMdFiles(projectRoot);
  const claudeMdRows: Array<Record<string, unknown>> = [];
  let claudeMdTotal = 0;
  for (const p of claudeMds) {
    const tok = _tok(p);
    claudeMdTotal += tok;
    const label =
      path.basename(path.dirname(p)) === ".claude"
        ? "~/.claude/CLAUDE.md"
        : _isRelativeTo(p, projectRoot)
          ? path.relative(projectRoot, p)
          : p;
    claudeMdRows.push({ label, tokens: tok, path: p });
  }

  // --- MEMORY.md ---
  const memoryMd = _findMemoryMd(projectRoot);
  const memoryTok = memoryMd ? _tok(memoryMd) : 0;
  const memoryDir = memoryMd ? path.dirname(memoryMd) : null;

  let entryCount = 0;
  if (memoryMd) {
    try {
      const text = fs.readFileSync(memoryMd, "utf8");
      const [, entries] = memory_prune.parse_index(text);
      entryCount = entries.length;
    } catch {
      // OSError → leave entryCount at 0
    }
  }

  // --- Prune (optional) ---
  let pruneResult: memory_prune.PruneResult | null = null;
  if (fix && memoryDir) {
    pruneResult = memory_prune.prune_index(memoryDir);
  }

  // --- Dry-run prune to show what's reclaimable ---
  let dryResult: memory_prune.PruneResult | null = null;
  if (memoryDir && !fix) {
    dryResult = memory_prune.prune_index(memoryDir, { dry_run: true });
  }

  // --- Content duplicate detection ---
  let dupClusters: memory_prune.DupCluster[] = [];
  if (memoryDir) {
    try {
      dupClusters = memory_prune.find_content_duplicates(memoryDir);
    } catch {
      // suppress
    }
  }

  // --- CLAUDE.md audit ---
  let auditReports: memory_prune.ClaudeMdReport[] = [];
  try {
    auditReports = memory_prune.audit_claude_md(claudeMds);
  } catch {
    // suppress
  }

  const userTotal = claudeMdTotal + memoryTok;
  const fixedTotal = _SYSTEM_PROMPT_EST + _SKILL_AGENT_EST;
  const grandTotal = fixedTotal + userTotal;

  if (json_out) {
    const out: Record<string, unknown> = {
      context_window: _CONTEXT_WINDOW,
      system_prompt_est: _SYSTEM_PROMPT_EST,
      skill_agent_est: _SKILL_AGENT_EST,
      claude_md_files: claudeMdRows,
      claude_md_total_tokens: claudeMdTotal,
      memory_md: memoryMd ?? null,
      memory_md_tokens: memoryTok,
      memory_entry_count: entryCount,
      user_controlled_tokens: userTotal,
      fixed_overhead_tokens: fixedTotal,
      grand_total_est: grandTotal,
      fill_fraction: Number((grandTotal / _CONTEXT_WINDOW).toFixed(3)),
    };
    if (pruneResult) {
      out["prune"] = {
        removed_dead: pruneResult.removed_dead.length,
        removed_dup: pruneResult.removed_dup.length,
        tokens_saved: pruneResult.tokens_saved,
        changed: pruneResult.changed,
      };
    }
    if (dryResult && dryResult.changed) {
      out["prune_available"] = {
        dead: dryResult.removed_dead.length,
        dup: dryResult.removed_dup.length,
        tokens_saveable: dryResult.tokens_saved,
      };
    }
    if (dupClusters.length > 0) {
      out["content_duplicates"] = dupClusters.map((c) => ({
        members: c.members,
        similarity: c.similarity,
        method: c.method,
        tokens: c.tokens,
      }));
    }
    _echo(JSON.stringify(out, null, 2));
    return;
  }

  // --- Human output ---
  _echo(`\nContext footprint — ${path.basename(projectRoot)}`);
  _echo(`  Window assumed : ${_comma(_CONTEXT_WINDOW)} tokens\n`);

  _echo("  Startup budget (injected before any work):");
  _echo(
    `    ${"System prompt (est.)".padEnd(32)} ~${String(_SYSTEM_PROMPT_EST).padStart(7)}   ${_pct(_SYSTEM_PROMPT_EST).padStart(6)}   fixed`,
  );
  _echo(
    `    ${"Skill/agent listings (est.)".padEnd(32)} ~${String(_SKILL_AGENT_EST).padStart(7)}   ${_pct(_SKILL_AGENT_EST).padStart(6)}   fixed`,
  );

  for (const row of claudeMdRows) {
    let lbl = String(row["label"]);
    if (lbl.length > 32) lbl = "…" + lbl.slice(-31);
    const tokens = Number(row["tokens"]);
    _echo(
      `    ${lbl.padEnd(32)} ~${_comma(tokens).padStart(7)}   ${_pct(tokens).padStart(6)}   you`,
    );
  }

  if (memoryMd) {
    const memLabel = `MEMORY.md (${entryCount} entries)`;
    _echo(
      `    ${memLabel.padEnd(32)} ~${_comma(memoryTok).padStart(7)}   ${_pct(memoryTok).padStart(6)}   you`,
    );
  } else {
    _echo(`    ${"MEMORY.md".padEnd(32)}     (not found)`);
  }

  _echo(`    ${"─".repeat(46)}`);
  _echo(
    `    ${"Total est. pre-consumed".padEnd(32)} ~${_comma(grandTotal).padStart(7)}   ${_pct(grandTotal).padStart(6)}`,
  );

  // --- MEMORY.md health ---
  if (memoryDir) {
    _echo(`\n  MEMORY.md health  (${memoryMd})`);
    _echo(`    ${entryCount} entries, ~${_comma(memoryTok)} tokens`);

    if (pruneResult && pruneResult.changed) {
      _echo(
        `    Pruned: ${pruneResult.removed_dead.length} dead link(s), ` +
          `${pruneResult.removed_dup.length} duplicate(s) removed ` +
          `(~${pruneResult.tokens_saved} tokens reclaimed)`,
      );
      for (const e of pruneResult.removed_dead) _echo(`      dead: ${e.target}`);
      for (const e of pruneResult.removed_dup) _echo(`      dup:  ${e.target}`);
    } else if (pruneResult) {
      _echo("    Index is clean — nothing to prune.");
    } else if (dryResult && dryResult.changed) {
      _echo(
        `    Dead links:            ${dryResult.removed_dead.length}` +
          `   → reclaimable now (--fix)   ~${dryResult.tokens_saved} tok`,
      );
      _echo(`    Exact-dup index lines: ${dryResult.removed_dup.length}`);
      for (const e of dryResult.removed_dead) _echo(`      dead: ${e.target}`);
    } else {
      _echo("    Index is clean — nothing to prune.");
    }

    if (dupClusters.length > 0) {
      _echo("\n  Content near-duplicates (review — never auto-merged)");
      for (const cl of dupClusters) {
        const simStr = `${cl.similarity.toFixed(2)} (${cl.method})`;
        _echo(`    cluster similarity=${simStr}, ~${cl.tokens} tok:`);
        for (const m of cl.members) _echo(`      ${m}`);
        _echo("      → consider consolidating");
      }
    }
  }

  // --- CLAUDE.md audit ---
  const hasIssues = auditReports.some(
    (r) => r.exact_dup_lines.length > 0 || r.dup_sections.length > 0 || r.cross_file_overlaps.length > 0,
  );
  if (hasIssues) {
    _echo("\n  CLAUDE.md audit (report only — token-goat never edits CLAUDE.md)");
    for (const r of auditReports) {
      const lbl =
        path.basename(path.dirname(r.path)) === ".claude" ? "~/.claude/CLAUDE.md" : path.basename(r.path);
      if (r.exact_dup_lines.length > 0) {
        _echo(`    ${lbl}: ${r.exact_dup_lines.length} exact-dup line(s)`);
        for (const [first, dup, text] of r.exact_dup_lines.slice(0, 3)) {
          const snippet = text.length > 50 ? `${text.slice(0, 50)}…` : text;
          _echo(`      L${first + 1} ↔ L${dup + 1}: ${JSON.stringify(snippet)}`);
        }
      }
      if (r.dup_sections.length > 0) {
        for (const [heading, lnos] of r.dup_sections) {
          _echo(`    ${lbl}: duplicate heading ${JSON.stringify(heading)} at lines ${lnos}`);
        }
      }
      if (r.cross_file_overlaps.length > 0) {
        _echo(`    ${lbl}: ${r.cross_file_overlaps.length} cross-file duplicate line(s)`);
      }
    }
  }

  // --- Summary ---
  const reclaimable = dryResult && dryResult.changed ? dryResult.tokens_saved : 0;
  const dupTok = dupClusters.reduce((sum, c) => sum + c.tokens, 0);
  if (reclaimable || dupTok) {
    _echo("\n  Summary");
    if (reclaimable) _echo(`    Reclaimable now (safe, --fix): ~${reclaimable} tok`);
    if (dupTok) _echo(`    Needs your review (clusters):  ~${dupTok} tok`);
  }
  _echo("");
}

/** Insert thousands separators — Python `f"{n:,}"`. */
function _comma(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
