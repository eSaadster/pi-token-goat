/**
 * Doctor CLI helpers — TypeScript port of src/token_goat/cli_doctor.py (2585 LOC).
 *
 * Faithful 1:1 transcription of the 6 top-level functions:
 *   - _cache_dir_stats           (py 19-64)   — sync
 *   - _render_cache_section      (py 67-110)  — sync
 *   - _compute_context_growth_trend (py 113-197) — sync
 *   - _build_context_section     (py 200-711) — sync (the big one + closures)
 *   - _iter_skill_names          (py 714-752) — sync
 *   - doctor                     (py 755-2585) — async (npm version check + Pillow probe)
 *
 * Seams (replace Python's psutil / subprocess / network / extension imports):
 *   - _subprocessRun       — subprocess.run analogue over child_process.spawnSync
 *   - _check_npm_version   — async fetch analogue of the urllib check, repointed
 *                            from PyPI to the npm registry for the node build
 *   - worker._pidExists    — psutil.pid_exists analogue (already exported)
 *   - better-sqlite3       — sqlite3 stand-in for WAL / extension / vec probes
 *   - sharp                — Pillow stand-in for codec probes (best-effort)
 *   - web-tree-sitter      — tree-sitter stand-in (best-effort)
 *
 * Spy-ability: module functions tests may patch (_subprocessRun,
 * _check_npm_version, _build_context_section, …) are called via the `self`
 * namespace so vi.spyOn(cli_doctor, "fn") is observed.
 *
 * Parity notes:
 *   - typer.echo(s) -> _echo(s) (writes s + "\n" to stdout).
 *   - time.time() -> Date.now()/1000; time.monotonic() -> Date.now()/1000.
 *   - Python str.splitlines() drops the trailing empty -> _splitlines helper.
 *   - f"{n:,}" -> _c(n) (en-US thousands separators on the integer part).
 *   - Banker's rounding for :.Nf and :.0% -> roundHalfEven.
 *   - Config fields are all optional in the TS types but config.load() fully
 *     populates them; resolve each section once as Required<...> then read.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import * as self from "./cli_doctor.js";
import * as paths from "./paths.js";
import * as db from "./db.js";
import * as project from "./project.js";
import * as install from "./install.js";
import * as worker from "./worker.js";
import * as config from "./config.js";
import * as session from "./session.js";
import * as stats from "./stats.js";
import * as skill_cache from "./skill_cache.js";
import * as compact from "./compact.js";
import * as embeddings from "./embeddings.js";
import { _humanizeBytes } from "./util.js";
import { _echo } from "./cli_common.js";
import { roundHalfEven } from "./skill_cache.js";
import type {
  CompactAssistConfig, SkillPreservationConfig, HintsConfig, BashCompressConfig,
  SessionBriefConfig, ImageShrinkConfig, CuratorConfig, HintBudgetConfig,
  RepomapConfig, StatsConfig, WebFetchConfig, WorkerConfig, IndexingConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Subprocess seam — replaces subprocess.run(...).
// ---------------------------------------------------------------------------

/** subprocess.TimeoutExpired analogue. */
export class TimeoutExpired extends Error {
  constructor(public cmd: string, public timeout: number) {
    super(`Command timed out after ${timeout}s`);
    this.name = "TimeoutExpired";
  }
}

/** subprocess.CompletedProcess analogue. */
export interface CompletedProcess {
  returncode: number;
  stdout: string;
  stderr: string;
}

/**
 * subprocess.run analogue over child_process.spawnSync. *timeout* is in SECONDS.
 *
 * A timeout maps to TimeoutExpired (mirrors subprocess.TimeoutExpired); a
 * missing executable (ENOENT) propagates as the raw error (mirrors Python's
 * FileNotFoundError); everything else propagates too.
 */
export function _subprocessRun(
  cmd: string[],
  opts: { timeout?: number } = {},
): CompletedProcess {
  const res = childProcess.spawnSync(cmd[0]!, cmd.slice(1), {
    encoding: "utf8",
    timeout: opts.timeout != null ? opts.timeout * 1000 : undefined,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new TimeoutExpired(cmd.join(" "), opts.timeout ?? 0);
    throw res.error; // ENOENT etc. propagate (mirrors FileNotFoundError).
  }
  return { returncode: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * npm registry version check seam — async fetch analogue of the urllib check
 * (py 866-890), repointed from PyPI to the npm registry for the node build.
 *
 * Returns a human-readable status string for the ok path; a thrown Error whose
 * message contains "available — run" must PROPAGATE so _check_step flags it
 * (mirrors the Python `raise ValueError(...)`). Network / abort errors degrade
 * to "npm registry unreachable (offline?)" (mirrors `except OSError`).
 */
export async function _check_npm_version(ccVer: string): Promise<string> {
  if (ccVer === "unknown") return "installed version unknown — skipping";
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    try {
      // The registry's per-package `/latest` endpoint returns just the latest
      // dist-tag's manifest ({ version, … }) — far smaller than the full packument.
      const resp = await fetch("https://registry.npmjs.org/token-goat/latest", {
        headers: { "User-Agent": "token-goat-doctor/1.0" }, signal: ac.signal,
      });
      if (!resp.ok) {
        // 404 = the package is not published on npm yet; anything else = a
        // registry hiccup. Either way, degrade gracefully (no false "update").
        return resp.status === 404
          ? `${ccVer} (not published on npm yet)`
          : "npm registry unreachable (offline?)";
      }
      const data = (await resp.json()) as { version?: string };
      const latest = data.version;
      if (typeof latest !== "string") return `${ccVer} (latest version unavailable)`;
      if (latest === ccVer) return `${ccVer} (latest)`;
      const vtup = (v: string): number[] => {
        try {
          return v.split(".").map((x) => {
            const n = parseInt(x, 10);
            if (Number.isNaN(n)) throw new Error();
            return n;
          });
        } catch {
          return [0];
        }
      };
      const gt = (a: number[], b: number[]): boolean => {
        const n = Math.max(a.length, b.length);
        for (let i = 0; i < n; i++) {
          const x = a[i] ?? 0;
          const y = b[i] ?? 0;
          if (x !== y) return x > y;
        }
        return false;
      };
      if (gt(vtup(latest), vtup(ccVer))) {
        throw new Error(
          `${ccVer} installed, ${latest} available — run \`npm install -g token-goat@latest\``,
        );
      }
      return `${ccVer} (npm has ${latest})`;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("available — run")) throw e;
    return "npm registry unreachable (offline?)";
  }
}

/** importlib.metadata.version("token-goat") analogue (py 857-863). */
function _packageVersion(): string {
  try {
    const here = nodePath.dirname(fileURLToPath(import.meta.url));
    const pkgPath = nodePath.join(here, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Small parity helpers.
// ---------------------------------------------------------------------------

/** Python str.splitlines() — splits on universal newlines, drops trailing empty. */
function _splitlines(s: string): string[] {
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Python f"{n:,}" for an integer — en-US thousands separators on the int part. */
function _c(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/** Python f"{x:g}" — strips trailing zeros (2.0 -> "2", 1.5 -> "1.5"). */
function _g(n: number): string {
  return String(parseFloat(n.toPrecision(6)));
}

/** True when p is an existing directory (guards ENOENT). */
function _isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when p is an existing regular file (guards ENOENT). */
function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when p exists (any type). */
function _exists(p: string): boolean {
  return fs.existsSync(p);
}

// ---------------------------------------------------------------------------
// _cache_dir_stats (py 19-64).
// ---------------------------------------------------------------------------

/**
 * Return ``[total_bytes, file_count, oldest_age_seconds_or_null]`` for *d*.
 *
 * Walks a single directory level — descends one level for session_snapshots/.
 * Symlinks are skipped. Raises only when the directory itself cannot be
 * enumerated; per-file errors are silently skipped.
 */
export function _cache_dir_stats(d: string): [number, number, number | null] {
  let total_bytes = 0;
  let file_count = 0;
  let oldest_mtime: number | null = null;
  const now = Date.now() / 1000;
  for (const name of fs.readdirSync(d)) {
    const entry = nodePath.join(d, name);
    try {
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(entry);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        continue;
      }
      if (lst.isDirectory()) {
        // One-level descent for session_snapshots/<session_id>/...
        for (const childName of fs.readdirSync(entry)) {
          const child = nodePath.join(entry, childName);
          let clst: fs.Stats;
          try {
            clst = fs.lstatSync(child);
          } catch {
            continue;
          }
          if (clst.isSymbolicLink() || !clst.isFile()) {
            continue;
          }
          let st: fs.Stats;
          try {
            st = fs.statSync(child);
          } catch {
            continue;
          }
          total_bytes += st.size;
          file_count += 1;
          const m = st.mtimeMs / 1000;
          if (oldest_mtime === null || m < oldest_mtime) {
            oldest_mtime = m;
          }
        }
        continue;
      }
      if (!lst.isFile()) {
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(entry);
      } catch {
        continue;
      }
      total_bytes += st.size;
      file_count += 1;
      const m = st.mtimeMs / 1000;
      if (oldest_mtime === null || m < oldest_mtime) {
        oldest_mtime = m;
      }
    } catch {
      continue;
    }
  }
  const oldest_age = oldest_mtime !== null ? Math.trunc(now - oldest_mtime) : null;
  return [total_bytes, file_count, oldest_age];
}

// ---------------------------------------------------------------------------
// _render_cache_section (py 67-110).
// ---------------------------------------------------------------------------

/**
 * Render a single cache section for the doctor output.
 *
 * Emits an ok/flag line based on cache directory size and file count. Caps are
 * optional (null means no cap applies).
 */
export function _render_cache_section(
  label: string,
  dir_name: string,
  cap_bytes: number | null,
  cap_file_count: number | null,
  ok: (label: string, value: string) => void,
  flag: (label: string, value: string, opts?: { warn?: boolean }) => void,
): void {
  const d = nodePath.join(paths.dataDir(), dir_name);
  if (!_exists(d)) {
    ok(label, "(not yet created)");
    return;
  }
  let total_bytes: number;
  let file_count: number;
  let oldest_age: number | null;
  try {
    [total_bytes, file_count, oldest_age] = self._cache_dir_stats(d);
  } catch (e) {
    flag(label, `unreadable — ${(e as Error).message ?? e}`, { warn: true });
    return;
  }
  if (file_count === 0) {
    ok(label, "0 files (empty)");
    return;
  }
  const age_str =
    oldest_age !== null ? `, oldest ${Math.trunc(oldest_age / 3600)}h ago` : "";
  const size_str = _humanizeBytes(total_bytes);
  const bytes_over = cap_bytes !== null && total_bytes > Math.trunc(cap_bytes * 1.1);
  const count_over =
    cap_file_count !== null && file_count > cap_file_count * 2 * 1.1;
  if (bytes_over || count_over) {
    flag(label, `${file_count} files, ${size_str}${age_str} (over cap)`, { warn: true });
  } else {
    ok(label, `${file_count} files, ${size_str}${age_str}`);
  }
}

// ---------------------------------------------------------------------------
// _compute_context_growth_trend (py 113-197).
// ---------------------------------------------------------------------------

/**
 * Return a human-readable context growth trend line from precompact sentinels,
 * or null when fewer than 2 sentinels exist.
 */
export function _compute_context_growth_trend(
  sentinels_dir: string,
  current_tokens = 0,
  context_cap: number | null = null,
): string | null {
  if (!_isDir(sentinels_dir)) {
    return null;
  }

  const samples: Array<[number, number]> = [];
  try {
    for (const name of fs.readdirSync(sentinels_dir)) {
      if (!(name.startsWith("precompact_estimate_") && name.endsWith(".json"))) continue;
      const p = nodePath.join(sentinels_dir, name);
      try {
        const mtime = fs.statSync(p).mtimeMs / 1000;
        const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        const tok = Math.trunc(Math.max(0, Math.trunc(Number(data["bytes_estimate"] ?? 0))) / 4);
        samples.push([mtime, tok]);
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  if (samples.length < 2) {
    return null;
  }

  samples.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0])); // oldest first
  const kept = samples.slice(-5); // keep at most 5 most-recent

  const deltas: number[] = [];
  for (let i = 0; i < kept.length - 1; i++) {
    deltas.push(kept[i + 1]![1] - kept[i]![1]);
  }
  const avg_delta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const n_sessions = deltas.length;

  const abs_avg = Math.abs(Math.trunc(avg_delta));
  const stable_threshold = 5000; // tokens

  let arrow: string;
  let direction: string;
  let sign: string;
  let trend_suffix: string;

  if (avg_delta > stable_threshold) {
    arrow = "↗"; // ↗
    direction = "growing";
    sign = "+";
    const _effective_cap =
      context_cap !== null ? context_cap : compact.CONTEXT_AUTOCOMPACT_TOKENS;
    const urgent_threshold = Math.trunc(_effective_cap * 0.85);
    let sessions_eta_suffix = "";
    if (current_tokens > 0 && avg_delta > 0) {
      const headroom = Math.max(0, urgent_threshold - current_tokens);
      const sessions_to_urgent = headroom / avg_delta;
      if (sessions_to_urgent <= 10) {
        const sessions_int = Math.max(1, Math.trunc(sessions_to_urgent));
        sessions_eta_suffix = `  [~${sessions_int} session${sessions_int !== 1 ? "s" : ""} to URGENT]`;
      }
    }
    trend_suffix = sessions_eta_suffix;
  } else if (avg_delta < -stable_threshold) {
    arrow = "↘"; // ↘
    direction = "shrinking";
    sign = "−"; // −
    trend_suffix = "";
  } else {
    arrow = "→"; // →
    direction = "stable";
    sign = "±"; // ±
    trend_suffix = "";
  }

  return (
    `  ${arrow} ${direction} ${sign}${_c(abs_avg)} tok/session avg` +
    `  (last ${n_sessions} session${n_sessions !== 1 ? "s" : ""})` +
    `${trend_suffix}`
  );
}

// ---------------------------------------------------------------------------
// _build_context_section (py 200-711).
// ---------------------------------------------------------------------------

/**
 * Build lines for the Context footprint doctor section.
 *
 * Returns ``[lines, should_auto_show]`` where *should_auto_show* is True when
 * estimated context fill > 40 % or any loaded skill > 2 K tokens lacks a compact.
 */
export function _build_context_section(): [string[], boolean] {
  const lines: string[] = [];
  let should_auto_show = false;

  // ----------------------------------------------------------------- //
  // 1. Skills catalog — scan actual file sizes (same logic as pregen)  //
  // ----------------------------------------------------------------- //
  const skills_root = paths.claudeSkillsDir();
  const plugins_root = paths.claudePluginsDir();
  const plugins_cache = nodePath.join(plugins_root, "cache");

  let catalog_count = 0;
  let catalog_bytes = 0;

  const _scan_skills_dir = (root: string): void => {
    if (!_isDir(root)) {
      return;
    }
    try {
      for (const name of fs.readdirSync(root)) {
        const entry = nodePath.join(root, name);
        if (!_isDir(entry)) {
          continue;
        }
        for (const candidate of [
          nodePath.join(entry, "SKILL.md"),
          nodePath.join(entry, `${name}.md`),
          nodePath.join(entry, name, "SKILL.md"),
        ]) {
          if (_isFile(candidate)) {
            try {
              catalog_bytes += fs.statSync(candidate).size;
            } catch {
              // contextlib.suppress(OSError)
            }
            catalog_count += 1;
            break;
          }
        }
      }
    } catch {
      // pass
    }
  };

  _scan_skills_dir(skills_root);

  if (_isDir(plugins_cache)) {
    try {
      for (const mktName of fs.readdirSync(plugins_cache)) {
        const mkt = nodePath.join(plugins_cache, mktName);
        if (!_isDir(mkt)) {
          continue;
        }
        for (const pluginName of fs.readdirSync(mkt)) {
          const plugin_dir = nodePath.join(mkt, pluginName);
          if (!_isDir(plugin_dir)) {
            continue;
          }
          let versions: string[];
          try {
            versions = fs
              .readdirSync(plugin_dir)
              .map((v) => nodePath.join(plugin_dir, v))
              .filter((v) => _isDir(v))
              .sort()
              .reverse();
          } catch {
            continue;
          }
          for (const ver of versions) {
            _scan_skills_dir(nodePath.join(ver, "skills"));
            break;
          }
        }
      }
    } catch {
      // pass
    }
  }

  let catalog_tokens: number;
  let catalog_size_note: string;
  if (catalog_count > 0 && catalog_bytes === 0) {
    catalog_tokens = catalog_count * 130;
    catalog_size_note = "  [no byte sizes — using 130 tok/skill fallback]";
  } else {
    catalog_tokens = Math.max(Math.trunc(catalog_bytes / 4), catalog_count * 130);
    catalog_size_note = "";
  }

  // ----------------------------------------------------------------- //
  // 2. Compact coverage — one glob pass over the cache dir             //
  // ----------------------------------------------------------------- //
  const compact_names = new Set<string>();
  try {
    const out_dir = skill_cache._skill_outputs_dir();
    if (_isDir(out_dir)) {
      for (const name of fs.readdirSync(out_dir)) {
        if (name.endsWith("-compact")) {
          // Strip "-compact" (8 chars), keep full stem.
          compact_names.add(name.slice(0, -8));
        }
      }
    }
  } catch {
    // pass
  }

  const _has_compact = (skill_name: string): boolean => {
    try {
      const safe = skill_cache._safe_skill_name(skill_name);
      if (safe === null) {
        return false;
      }
      let safe_n = safe.replace(/:/g, "_");
      if (safe.includes(":")) {
        safe_n += "n";
      }
      const suffix = `-${safe_n}`;
      for (const s of compact_names) {
        if (s.endsWith(suffix)) return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  // ----------------------------------------------------------------- //
  // 3. New skills since last pre-generation                            //
  // ----------------------------------------------------------------- //
  let new_since_pregen: number | null = null; // null = never run
  try {
    const pregen_sentinel = paths.skillPregenSentinelPath();
    if (_isFile(pregen_sentinel)) {
      const pregen_data = JSON.parse(fs.readFileSync(pregen_sentinel, "utf8")) as Record<
        string,
        unknown
      >;
      const pregen_count = Math.trunc(Number(pregen_data["skill_count"] ?? 0));
      new_since_pregen = Math.max(0, catalog_count - pregen_count);
    }
  } catch {
    // pass
  }

  // ----------------------------------------------------------------- //
  // 4. Loaded skills — most-recently-modified session file             //
  // ----------------------------------------------------------------- //
  const loaded_skill_entries: Array<[string, number, boolean]> = []; // (name, tokens, has_compact)
  let session_turns = 0;
  let cache: session.SessionCache | null = null;

  const sessions_dir_path = paths.sessionsDir();
  if (_isDir(sessions_dir_path)) {
    try {
      let best_mtime = 0.0;
      let best_file: string | null = null;
      for (const name of fs.readdirSync(sessions_dir_path)) {
        if (!name.endsWith(".json")) continue;
        const f = nodePath.join(sessions_dir_path, name);
        try {
          const mtime = fs.statSync(f).mtimeMs / 1000;
          if (mtime > best_mtime) {
            best_mtime = mtime;
            best_file = f;
          }
        } catch {
          continue;
        }
      }
      if (best_file !== null) {
        const stem = nodePath.basename(best_file, ".json");
        cache = session.load(stem);
        session_turns = cache.turns_since_last_compact ?? 0;
        for (const [skill_name, entry] of Object.entries(cache.skill_history ?? {})) {
          const body_bytes = entry.body_bytes ?? 0;
          const body_tokens = Math.trunc(body_bytes / 4);
          const hc = _has_compact(skill_name);
          loaded_skill_entries.push([skill_name, body_tokens, hc]);
          if (body_tokens > 2000 && !hc) {
            should_auto_show = true;
          }
        }
      }
    } catch {
      // pass
    }
  }

  const loaded_skill_tokens = loaded_skill_entries.reduce((acc, [, bt]) => acc + bt, 0);

  // ----------------------------------------------------------------- //
  // 5. CLAUDE.md + MEMORY.md sizes                                     //
  // ----------------------------------------------------------------- //
  const claude_dir = nodePath.join(os.homedir(), ".claude");
  let meta_bytes = 0;
  try {
    const claude_md = nodePath.join(claude_dir, "CLAUDE.md");
    if (_isFile(claude_md)) {
      meta_bytes += fs.statSync(claude_md).size;
    }
  } catch {
    // pass
  }
  try {
    const projects_root = nodePath.join(claude_dir, "projects");
    if (_isDir(projects_root)) {
      for (const name of fs.readdirSync(projects_root)) {
        const proj_dir = nodePath.join(projects_root, name);
        if (!_isDir(proj_dir)) {
          continue;
        }
        const memory_md = nodePath.join(proj_dir, "memory", "MEMORY.md");
        if (_isFile(memory_md)) {
          try {
            meta_bytes += fs.statSync(memory_md).size;
          } catch {
            // contextlib.suppress(OSError)
          }
        }
      }
    }
  } catch {
    // pass
  }
  const meta_tokens = Math.trunc(meta_bytes / 4);

  // ----------------------------------------------------------------- //
  // 6. Conversation estimate (iter 8: tool-output-aware)               //
  // ----------------------------------------------------------------- //
  const _TOOL_OUTPUT_CAP = 32768; // bytes per entry
  let tool_output_bytes = 0;
  try {
    if (cache !== null) {
      const bash_hist = cache.bash_history ?? {};
      for (const be of Object.values(bash_hist)) {
        tool_output_bytes += Math.min(
          (be.stdout_bytes ?? 0) + (be.stderr_bytes ?? 0),
          _TOOL_OUTPUT_CAP,
        );
      }
      const web_hist = cache.web_history ?? {};
      for (const we of Object.values(web_hist)) {
        tool_output_bytes += Math.min(we.body_bytes ?? 0, _TOOL_OUTPUT_CAP);
      }
    }
  } catch {
    tool_output_bytes = 0;
  }

  const tool_output_tokens = Math.trunc(tool_output_bytes / 4);
  const dialogue_tokens = session_turns * 800; // model text per turn
  const conversation_tokens = dialogue_tokens + tool_output_tokens;

  // ----------------------------------------------------------------- //
  // 7. Precompact baseline — read without consuming the sentinel        //
  // ----------------------------------------------------------------- //
  let precompact_tokens = 0;
  let has_precompact = false;
  let precompact_age_seconds: number | null = null;
  let sentinel_error: string | null = null;
  try {
    const sentinels_dir_path = paths.sentinelsDir();
    if (_isDir(sentinels_dir_path)) {
      const now = Date.now() / 1000;
      const candidates: Array<[number, string]> = [];
      for (const name of fs.readdirSync(sentinels_dir_path)) {
        if (!(name.startsWith("precompact_estimate_") && name.endsWith(".json"))) continue;
        const p = nodePath.join(sentinels_dir_path, name);
        try {
          const mtime = fs.statSync(p).mtimeMs / 1000;
          candidates.push([mtime, p]);
        } catch {
          continue;
        }
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] - b[0]));
        candidates.reverse();
        const best = candidates[0]!;
        const best_mtime = best[0];
        const best_sentinel = best[1];
        let raw_text: string | null;
        try {
          raw_text = fs.readFileSync(best_sentinel, "utf8");
        } catch (exc) {
          sentinel_error = `unreadable (${(exc as { constructor?: { name?: string } }).constructor?.name ?? "Error"})`;
          raw_text = null;
        }
        if (raw_text !== null) {
          let raw_bytes = 0;
          try {
            const sentinel_data = JSON.parse(raw_text) as Record<string, unknown>;
            raw_bytes = Math.trunc(Number(sentinel_data["bytes_estimate"] ?? 0));
            if (Number.isNaN(raw_bytes)) {
              throw new Error("not a number");
            }
          } catch {
            sentinel_error = "malformed JSON in sentinel";
            raw_bytes = 0;
          }
          if (raw_bytes > 0) {
            precompact_tokens = Math.trunc(raw_bytes / 4);
            has_precompact = true;
            precompact_age_seconds = Math.trunc(now - best_mtime);
          }
        }
      }
    }
  } catch {
    sentinel_error = "unexpected error reading sentinels";
  }

  // ----------------------------------------------------------------- //
  // 8. Totals, fill %, ETA                                             //
  // ----------------------------------------------------------------- //
  const CONTEXT_CAP = compact.CONTEXT_AUTOCOMPACT_TOKENS;

  const additional_tokens =
    catalog_tokens + loaded_skill_tokens + meta_tokens + conversation_tokens;
  const current_estimate = has_precompact
    ? precompact_tokens + additional_tokens
    : additional_tokens;
  const fill_pct = current_estimate / CONTEXT_CAP;

  if (fill_pct > 0.4) {
    should_auto_show = true;
  }

  const tokens_per_turn =
    session_turns >= 3 ? Math.max(1, Math.trunc(conversation_tokens / session_turns)) : 2000;
  const remaining = Math.max(0, CONTEXT_CAP - current_estimate);
  const eta_turns = remaining / tokens_per_turn;

  // ----------------------------------------------------------------- //
  // 9. Assemble output lines                                           //
  // ----------------------------------------------------------------- //
  lines.push("\nContext footprint");
  const catalog_size_label = !catalog_size_note ? "[actual file sizes]" : "[fallback estimate]";
  lines.push(
    `  Skills catalog: ${catalog_count} skills ≈ ${_c(catalog_tokens)} tokens/turn  ${catalog_size_label}`,
  );
  if (catalog_size_note) {
    lines.push(catalog_size_note);
  }

  let compact_count = 0;
  for (const sname of _iter_skill_names(skills_root, plugins_cache)) {
    if (_has_compact(sname)) compact_count += 1;
  }
  if (catalog_count > 0) {
    lines.push(
      `  Skill compacts: ${compact_count} of ${catalog_count} skills have fresh compacts`,
    );
  }

  if (new_since_pregen === null) {
    lines.push("  Skills pre-gen: never run — run: token-goat skill-compact --all");
  } else if (new_since_pregen > 0) {
    lines.push(`  Skills installed since last pre-gen: ${new_since_pregen}`);
  }

  if (loaded_skill_entries.length > 0) {
    lines.push(
      `  Loaded skills this session: ${loaded_skill_entries.length}` +
        ` (~${_c(loaded_skill_tokens)} tokens in system-reminder)`,
    );
    for (const [skill_name, body_tokens, hc] of loaded_skill_entries) {
      if (hc) {
        let compact_text = "";
        try {
          compact_text = skill_cache.get_compact_any_session(skill_name) ?? "";
        } catch {
          compact_text = "";
        }
        const compact_tok = Math.trunc(compact_text.length / 4);
        const saves = Math.max(0, body_tokens - compact_tok);
        lines.push(
          `    ${skill_name.padEnd(24)}~${_c(body_tokens)} tok` +
            `   compact: ${_c(compact_tok)} tok` +
            `   saves ~${_c(saves)} tok at next /compact`,
        );
      } else {
        lines.push(
          `    ${skill_name.padEnd(24)}~${_c(body_tokens)} tok` +
            `   no compact` +
            `          run: token-goat skill-compact ${skill_name}`,
        );
      }
    }
  } else {
    lines.push("  Loaded skills this session: none");
  }

  lines.push(`  CLAUDE.md + MEMORY.md: ~${_c(meta_tokens)} tokens/turn`);

  if (session_turns > 0) {
    const per_turn_est = Math.trunc(conversation_tokens / session_turns);
    if (tool_output_tokens > 0) {
      lines.push(
        `  Conversation (~${session_turns} turns): ~${_c(conversation_tokens)} tokens` +
          `  (~${_c(per_turn_est)}/turn)` +
          `  [dialogue ~${_c(dialogue_tokens)} + tool outputs ~${_c(tool_output_tokens)}]`,
      );
    } else {
      lines.push(
        `  Conversation (~${session_turns} turns): ~${_c(conversation_tokens)} tokens` +
          `  (~${_c(per_turn_est)}/turn)`,
      );
    }
  } else {
    lines.push("  Conversation: no active session found");
  }

  lines.push("  " + "─".repeat(54));
  lines.push(`  Estimated additional: ~${_c(additional_tokens)} tokens`);

  if (has_precompact) {
    let age_note = "";
    if (precompact_age_seconds !== null && precompact_age_seconds > 3600) {
      const age_hrs = Math.trunc(precompact_age_seconds / 3600);
      age_note = `  [${age_hrs}h old — may not reflect current session]`;
    } else if (precompact_age_seconds !== null && precompact_age_seconds > 300) {
      const age_min = Math.trunc(precompact_age_seconds / 60);
      age_note = `  [${age_min}m old]`;
    } else {
      age_note = "";
    }
    lines.push(`  Context at last compact: ~${_c(precompact_tokens)}${age_note}`);
    lines.push(
      `  Current estimate: ~${_c(current_estimate)} / ${_c(CONTEXT_CAP)}` +
        `  (${Math.trunc(fill_pct * 100)}%)`,
    );
  } else {
    lines.push("  Context at last compact: < no compact baseline yet >");
    if (sentinel_error) {
      lines.push(`    (sentinel error: ${sentinel_error})`);
    }
    lines.push(
      `  Current estimate: ~${_c(current_estimate)} / ${_c(CONTEXT_CAP)}` +
        `  (${Math.trunc(fill_pct * 100)}%)`,
    );
  }

  // Fill bar + per-component breakdown (iter 2).
  const BAR_WIDTH = 40;
  const filled = Math.min(BAR_WIDTH, Math.trunc(fill_pct * BAR_WIDTH));
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const fill_label = `${Math.trunc(fill_pct * 100)}%`;
  let severity: string;
  if (fill_pct >= 0.85) {
    severity = "CRIT";
  } else if (fill_pct >= 0.7) {
    severity = "HIGH";
  } else if (fill_pct >= 0.4) {
    severity = "WARN";
  } else {
    severity = "ok";
  }
  lines.push(`  [${bar}] ${fill_label} (${severity})`);

  // Per-component percentages — only show components that are >2% of total.
  const components: Array<[string, number]> = [
    ["precompact", has_precompact ? precompact_tokens : 0],
    ["catalog", catalog_tokens],
    ["loaded skills", loaded_skill_tokens],
    ["meta (CLAUDE.md)", meta_tokens],
    ["conversation", conversation_tokens],
  ];
  if (current_estimate > 0) {
    const breakdown_parts: string[] = [];
    for (const [cname, ctok] of components) {
      const pct = (ctok / current_estimate) * 100;
      if (pct >= 2.0) {
        breakdown_parts.push(`${cname} ${roundHalfEven(pct, 0)}%`);
      }
    }
    if (breakdown_parts.length > 0) {
      lines.push(`  Breakdown: ${breakdown_parts.join(", ")}`);
    }
  }

  if (session_turns >= 3) {
    if (eta_turns > 20) {
      lines.push("  ETA: > 20 turns at current rate");
    } else {
      lines.push(`  ETA: ~${Math.max(1, Math.trunc(eta_turns))} turns at current rate`);
    }
  } else if (session_turns > 0) {
    const lo = Math.max(1, Math.trunc(eta_turns) - 3);
    const hi = Math.trunc(eta_turns) + 3;
    lines.push(`  ETA: ~${lo}–${hi} turns  (estimated, < 3 turns of history)`);
  } else {
    lines.push("  ETA: unknown  (no active session found)");
  }

  // 10. Session-to-session growth trend (iter 3).
  try {
    const sentinels_dir_for_trend = paths.sentinelsDir();
    const trend_line = self._compute_context_growth_trend(
      sentinels_dir_for_trend,
      current_estimate,
      CONTEXT_CAP,
    );
    if (trend_line !== null) {
      lines.push(trend_line);
    }
  } catch {
    // pass
  }

  // 11. Recommendations (iter 4).
  const recommendations: string[] = [];

  const uncompacted_large_skills = loaded_skill_entries
    .filter(([, btok, hc]) => !hc && btok > 2000)
    .map(([name]) => name);

  // Tier 0: over-capacity.
  if (fill_pct >= 1.0) {
    recommendations.push(
      "    [OVER CAPACITY] Estimated context exceeds 100% — responses may degrade." +
        " Run /compact immediately.",
    );
  } else if (fill_pct >= 0.85) {
    // Tier 1: immediate compaction recommended.
    if (uncompacted_large_skills.length > 0) {
      const skill_list = uncompacted_large_skills.slice(0, 3).join(", ");
      const more =
        uncompacted_large_skills.length > 3
          ? ` (+${uncompacted_large_skills.length - 3} more)`
          : "";
      recommendations.push(
        `    [URGENT] Run skill-compact first (${skill_list}${more}),` +
          ` then /compact — uncompacted skills re-inflate context every turn.`,
      );
    } else {
      recommendations.push("    [URGENT] Run /compact now — context is >= 85% full.");
    }
  } else if (fill_pct >= 0.7) {
    recommendations.push("    Run /compact soon — context is >= 70% full.");
  } else if (fill_pct >= 0.4 && session_turns >= 10) {
    recommendations.push(
      `    Consider /compact — context at ${Math.trunc(fill_pct * 100)}% with` +
        ` ${session_turns} turns; compact to reset baseline.`,
    );
  }

  // Tier 2: skill compact opportunities (uncompacted loaded skills).
  for (const [skill_name, body_tokens, hc] of loaded_skill_entries) {
    if (!hc && body_tokens > 2000) {
      const savings_note = `  # ~${_c(body_tokens - Math.trunc(body_tokens / 5))} tok saved`;
      recommendations.push(`    token-goat skill-compact ${skill_name}${savings_note}`);
    }
  }

  // Tier 3: catalog-wide pregen gap.
  if (
    compact_count < catalog_count ||
    new_since_pregen === null ||
    (new_since_pregen ?? 0) > 0
  ) {
    recommendations.push("    token-goat skill-compact --all  # update compact catalog");
  }

  // Tier 4: early session with heavy context.
  if (session_turns < 5 && fill_pct >= 0.3) {
    const component_costs: Array<[string, number]> = [
      ["loaded skills", loaded_skill_tokens],
      ["meta (CLAUDE.md)", meta_tokens],
      ["catalog", catalog_tokens],
    ];
    let dominant = component_costs[0]!;
    for (const cc of component_costs) {
      if (cc[1] > dominant[1]) dominant = cc;
    }
    if (dominant[1] > 0) {
      recommendations.push(
        `    Context is ${Math.trunc(fill_pct * 100)}% after only ${session_turns} turn(s)` +
          ` — dominant cost: ${dominant[0]} (${_c(dominant[1])} tok).` +
          ` Skill compacts will help most.`,
      );
    } else {
      recommendations.push(
        `    Context at ${Math.trunc(fill_pct * 100)}% with only ${session_turns} turn(s)` +
          ` — run: token-goat skill-compact --all`,
      );
    }
  }

  if (recommendations.length > 0) {
    lines.push("");
    lines.push("  Recommendations:");
    for (const r of recommendations) lines.push(r);
  }

  return [lines, should_auto_show];
}

// ---------------------------------------------------------------------------
// _iter_skill_names (py 714-752).
// ---------------------------------------------------------------------------

/** Return all skill names discovered on disk (same traversal as pregen). */
export function _iter_skill_names(skills_root: string, plugins_cache: string): string[] {
  const names: string[] = [];
  if (_isDir(skills_root)) {
    try {
      for (const name of fs.readdirSync(skills_root)) {
        const entry = nodePath.join(skills_root, name);
        if (_isDir(entry)) {
          names.push(name);
        }
      }
    } catch {
      // pass
    }
  }
  if (_isDir(plugins_cache)) {
    try {
      for (const mktName of fs.readdirSync(plugins_cache)) {
        const mkt = nodePath.join(plugins_cache, mktName);
        if (!_isDir(mkt)) {
          continue;
        }
        for (const pluginName of fs.readdirSync(mkt)) {
          const plugin_dir = nodePath.join(mkt, pluginName);
          if (!_isDir(plugin_dir)) {
            continue;
          }
          let versions: string[];
          try {
            versions = fs
              .readdirSync(plugin_dir)
              .map((v) => nodePath.join(plugin_dir, v))
              .filter((v) => _isDir(v))
              .sort()
              .reverse();
          } catch {
            continue;
          }
          for (const ver of versions) {
            const ver_skills = nodePath.join(ver, "skills");
            if (!_isDir(ver_skills)) {
              continue;
            }
            try {
              for (const skillName of fs.readdirSync(ver_skills)) {
                const skill_entry = nodePath.join(ver_skills, skillName);
                if (_isDir(skill_entry)) {
                  names.push(`${pluginName}:${skillName}`);
                }
              }
            } catch {
              // pass
            }
            break;
          }
        }
      }
    } catch {
      // pass
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// doctor (py 755-2585).
// ---------------------------------------------------------------------------

/** Recursively collect all *.onnx file paths under root (Python rglob). */
function _rglobOnnx(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = nodePath.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile() && name.endsWith(".onnx")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/** Open an in-memory better-sqlite3 connection (sqlite3.connect(":memory:")). */
async function _openMemoryDb(): Promise<{
  prepare(sql: string): { get(...p: unknown[]): unknown };
  loadExtension(file: string, entrypoint?: string): void;
  pragma(s: string, opts?: { simple?: boolean }): unknown;
  close(): void;
}> {
  const Database = (await import("better-sqlite3")).default;
  return new Database(":memory:") as unknown as {
    prepare(sql: string): { get(...p: unknown[]): unknown };
    loadExtension(file: string, entrypoint?: string): void;
    pragma(s: string, opts?: { simple?: boolean }): unknown;
    close(): void;
  };
}

/**
 * Diagnose indexing health (py 755).
 *
 * Pass ``fix`` to clear stale ``.indexing`` spawn markers; ``crashes`` to tail
 * the last 5 hooks-stderr.log crash entries; ``context`` to always show the
 * Context footprint section.
 */
export async function doctor(args: {
  fix: boolean;
  crashes: boolean;
  context: boolean;
}): Promise<void> {
  const { fix, crashes, context } = args;

  const ok = (label: string, value: string): void => {
    _echo(`  ${label}: ${value}`);
  };

  const flag = (label: string, value: string, opts: { warn?: boolean } = {}): void => {
    const prefix = opts.warn ? "WARN" : "FAIL";
    _echo(`  [${prefix}] ${label}: ${value}`);
  };

  const _check_step = async (
    label: string,
    fn: () => unknown | Promise<unknown>,
    opts: { warn?: boolean; time_ms?: boolean } = {},
  ): Promise<void> => {
    try {
      const t0 = opts.time_ms ? Date.now() / 1000 : 0.0;
      const result = await fn();
      if (opts.time_ms) {
        const elapsed_ms = (Date.now() / 1000 - t0) * 1000;
        const base = result != null ? String(result) : "";
        ok(label, base ? `${base} (${elapsed_ms.toFixed(0)} ms)` : `${elapsed_ms.toFixed(0)} ms`);
      } else {
        ok(label, result != null ? String(result) : "");
      }
    } catch (e) {
      flag(label, String((e as Error).message ?? e), { warn: opts.warn ?? false });
    }
  };

  _echo("\ntoken-goat doctor\n");

  // ------------------------------------------------------------------
  // 0. Platform
  // ------------------------------------------------------------------
  _echo("Platform");
  if (process.platform === "win32") {
    ok("OS", `Windows (sys.platform=${process.platform})`);
  } else if (process.platform === "darwin") {
    ok("OS", `macOS (sys.platform=${process.platform})`);
  } else {
    ok("OS", `Linux/POSIX (sys.platform=${process.platform})`);
  }
  ok("WSL", paths.isWsl() ? "yes" : "no");

  // ------------------------------------------------------------------
  // 1. Versions
  // ------------------------------------------------------------------
  _echo("\nVersions");
  // Node's process.versions.node stands in for the Python interpreter version.
  // The 3.11 minimum check has no Node analogue; report the runtime version.
  const py_ver = process.versions.node;
  ok("Python", py_ver);
  const cc_ver = _packageVersion();
  ok("token-goat", cc_ver);

  // npm registry version check — non-blocking, 2 s timeout, skip gracefully if offline.
  await _check_step("token-goat (npm)", () => self._check_npm_version(cc_ver), { warn: true });

  await _check_step(
    "npm",
    () => {
      const npm_out = self._subprocessRun(["npm", "--version"], { timeout: 5 });
      return npm_out.stdout.trim() || "installed";
    },
    { warn: true },
  );

  // ------------------------------------------------------------------
  // 1b. Detected harnesses
  // ------------------------------------------------------------------
  await _check_step(
    "harnesses detected",
    () => {
      const harnesses_dict = install.detect_installed_harnesses();
      let found = Object.entries(harnesses_dict)
        .filter(([, installed]) => installed)
        .map(([name]) => name);
      if (found.includes("claude")) {
        found = found.filter((n) => n !== "claude");
      }
      found = ["claude", ...found.sort()];
      return found.length > 0 ? found.join(", ") : "none";
    },
    { warn: true },
  );

  // ------------------------------------------------------------------
  // 2. Paths
  // ------------------------------------------------------------------
  _echo("\nPaths");
  const path_checks: Array<[string, string]> = [
    ["data_dir", paths.dataDir()],
    ["global.db", paths.globalDbPath()],
    ["models_dir", paths.modelsDir()],
    ["logs_dir", paths.logsDir()],
  ];
  for (const [label, p] of path_checks) {
    if (_exists(p)) {
      ok(label, p);
    } else {
      flag(label, `${p}  (missing)`, { warn: true });
    }
  }

  // Fastembed ONNX model file presence.
  try {
    const models_dir = paths.modelsDir();
    if (_exists(models_dir)) {
      const onnx_files = _rglobOnnx(models_dir);
      if (onnx_files.length > 0) {
        let total_size = 0;
        for (const f of onnx_files) {
          if (_isFile(f)) total_size += fs.statSync(f).size;
        }
        ok("fastembed model", `${onnx_files.length} onnx file(s), ${_humanizeBytes(total_size)}`);
      } else {
        flag(
          "fastembed model",
          "no .onnx file found in models_dir — semantic search will be unavailable until first download",
          { warn: true },
        );
      }
    }
  } catch (e) {
    flag("fastembed model", `could not enumerate models_dir — ${(e as Error).message ?? e}`, {
      warn: true,
    });
  }

  // ------------------------------------------------------------------
  // 2a. Disk space
  // ------------------------------------------------------------------
  _echo("\nDisk space");
  try {
    const _data = paths.dataDir();
    const _check_path = _exists(_data)
      ? _data
      : _exists(nodePath.dirname(_data))
        ? nodePath.dirname(_data)
        : process.cwd();
    const su = fs.statfsSync(_check_path);
    const _total = su.blocks * su.bsize;
    const _free = su.bavail * su.bsize;
    const _free_mb = Math.trunc(_free / (1024 * 1024));
    const _total_gb = _total / 1024 ** 3;
    const _pct_free = _total > 0 ? (_free / _total) * 100 : 0;
    const _free_str = `${_c(_free_mb)} MB free of ${roundHalfEven(_total_gb, 1).toFixed(1)} GB (${roundHalfEven(_pct_free, 0)}% free) on ${_check_path}`;
    const _WARN_MB = 500;
    if (_free_mb < _WARN_MB) {
      flag(
        "data dir partition",
        `${_free_str} — below ${_WARN_MB} MB; run \`token-goat clean\` to reclaim cache space`,
      );
    } else if (_free_mb < 2048) {
      flag("data dir partition", `${_free_str} — getting low; consider \`token-goat clean\``, {
        warn: true,
      });
    } else {
      ok("data dir partition", _free_str);
    }
  } catch (e) {
    flag("data dir partition", `disk_usage failed — ${(e as Error).message ?? e}`, { warn: true });
  }

  // ------------------------------------------------------------------
  // 2b. Installation status
  // ------------------------------------------------------------------
  _echo("\nInstallation");
  try {
    const installation_checks: Array<[string, string]> = [
      ["settings.json", install._check_settings_json()],
      ["CLAUDE.md", install._check_claude_md()],
      ["skill", install._check_skill()],
    ];
    let harnesses_dict: Record<string, boolean>;
    try {
      harnesses_dict = install.detect_installed_harnesses();
    } catch {
      harnesses_dict = {};
    }
    if (harnesses_dict["codex"]) {
      installation_checks.push(["codex config.toml", install._check_codex_config()]);
    }
    if (process.platform === "win32") {
      installation_checks.push(["worker autostart", install._check_worker_task()]);
    }
    for (const [label, status] of installation_checks) {
      if (status.startsWith("installed")) {
        ok(label, status);
      } else if (status.startsWith("not installed")) {
        flag(label, status + " — run `token-goat install`", { warn: true });
      } else {
        flag(label, status, { warn: true });
      }
    }
  } catch (e) {
    flag("installation", `check failed — ${(e as Error).message ?? e}`, { warn: true });
  }

  // ------------------------------------------------------------------
  // 2c. Third-party AI tool compatibility hints
  // ------------------------------------------------------------------
  _echo("\nThird-party AI tools");
  try {
    if (install.detect_aider()) {
      flag(
        "aider",
        "detected — aider does not support hook-based auto-integration; " +
          "add `--read <file>` in your .aider.conf.yml to pass context manually",
        { warn: true },
      );
    } else {
      ok("aider", "not detected");
    }

    const gemini_dir = nodePath.join(os.homedir(), ".gemini");
    if (_exists(gemini_dir)) {
      const gemini_status = install._check_gemini_settings();
      if (gemini_status.includes("installed")) {
        ok("gemini", `detected, hooks ${gemini_status}`);
      } else {
        flag(
          "gemini",
          `detected — hooks ${gemini_status}; run \`token-goat install --target gemini\` to install`,
          { warn: true },
        );
      }
    } else {
      ok("gemini", "not detected");
    }

    if (install.detect_cline()) {
      ok("cline", "detected — bash output compression active for `cline` commands");
    } else {
      ok("cline", "not detected");
    }

    if (install.detect_windsurf()) {
      ok("windsurf", "detected — bash output compression active for `windsurf` commands");
    } else {
      ok("windsurf", "not detected");
    }

    if (install.detect_copilot_cli()) {
      ok("copilot-cli", "detected — bash output compression active for `copilot` commands");
    } else {
      ok("copilot-cli", "not detected");
    }
  } catch (e) {
    flag("third-party tools", `check failed — ${(e as Error).message ?? e}`, { warn: true });
  }

  // ------------------------------------------------------------------
  // 3. SQLite
  // ------------------------------------------------------------------
  _echo("\nSQLite");
  try {
    const conn = await _openMemoryDb();
    try {
      const row = conn.prepare("SELECT sqlite_version() AS v").get() as { v: string };
      ok("version", String(row.v));
    } finally {
      conn.close();
    }
  } catch (e) {
    flag("version", String((e as Error).message ?? e), { warn: true });
  }

  // WAL check requires a real file — :memory: always returns "memory" mode.
  const _wal_supported = async (): Promise<boolean> => {
    const tmp_dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tgdoctor-"));
    const tmp_db_path = nodePath.join(tmp_dir, "wal.db");
    let wal_conn: Awaited<ReturnType<typeof _openMemoryDb>> | null = null;
    try {
      const Database = (await import("better-sqlite3")).default;
      wal_conn = new Database(tmp_db_path) as unknown as Awaited<ReturnType<typeof _openMemoryDb>>;
      const mode = wal_conn.pragma("journal_mode = WAL", { simple: true });
      return mode === "wal";
    } catch {
      return false;
    } finally {
      try {
        if (wal_conn !== null) wal_conn.close();
      } catch {
        // suppress
      }
      try {
        fs.rmSync(tmp_dir, { recursive: true, force: true });
      } catch {
        // missing_ok equivalent
      }
    }
  };

  if (await _wal_supported()) {
    ok("WAL", "yes");
  } else {
    flag("WAL", "not supported or errored");
  }

  // extensions probe — better-sqlite3 supports loadExtension.
  let ext_ok = false;
  try {
    const conn = await _openMemoryDb();
    try {
      if (typeof conn.loadExtension === "function") {
        ok("extensions", "yes");
        ext_ok = true;
      } else {
        flag("extensions", "no — loadExtension unavailable");
        ext_ok = false;
      }
    } finally {
      conn.close();
    }
  } catch (e) {
    flag("extensions", `no — ${(e as Error).message ?? e}`);
    ext_ok = false;
  }

  // ------------------------------------------------------------------
  // 4. sqlite-vec
  // ------------------------------------------------------------------
  const _check_sqlite_vec = async (): Promise<unknown> => {
    const conn = await _openMemoryDb();
    try {
      const sqliteVec = (await import("sqlite-vec")) as { load: (db: unknown) => void };
      sqliteVec.load(conn);
      const row = conn.prepare("SELECT vec_version() AS v").get() as Record<string, unknown>;
      return String((row as { v: unknown }).v);
    } finally {
      conn.close();
    }
  };

  if (ext_ok) {
    await _check_step("sqlite-vec", () => _check_sqlite_vec(), { time_ms: true });
  } else {
    flag("sqlite-vec", "skipped (no extension support)", { warn: true });
  }

  // ------------------------------------------------------------------
  // 5. fastembed
  // ------------------------------------------------------------------
  // No Node fastembed backend — surface the gap via EmbeddingsUnavailable.
  await _check_step(
    "fastembed",
    () => {
      throw new embeddings.EmbeddingsUnavailable(
        "fastembed not importable: no bundled Node backend",
      );
    },
    { time_ms: true },
  );

  // ------------------------------------------------------------------
  // 6. Pillow (sharp stand-in) — probe codec availability, not just import.
  // ------------------------------------------------------------------
  try {
    const sharp = (await import("sharp")).default as unknown as {
      versions?: { sharp?: string };
      format?: Record<string, { output?: { buffer?: boolean } } | undefined>;
      (opts: unknown): {
        webp(o: { quality: number }): { toBuffer(): Promise<Buffer> };
      };
    };
    ok("Pillow", sharp.versions?.sharp ?? "installed");
    const codec_status: string[] = [];
    const fmt = sharp.format ?? {};
    for (const [codec, label] of [
      ["webp", "WebP"],
      ["jpeg", "JPEG"],
      ["png", "PNG"],
    ]) {
      if (fmt[codec!]?.output?.buffer) {
        codec_status.push(`${label}=ok`);
      } else {
        codec_status.push(`${label}=MISSING`);
      }
    }
    try {
      await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 100, b: 50 } },
      } as unknown)
        .webp({ quality: 80 })
        .toBuffer();
      codec_status.push("WebP-encode=ok");
    } catch (exc) {
      codec_status.push(`WebP-encode=FAIL (${(exc as { constructor?: { name?: string } }).constructor?.name ?? "Error"})`);
    }
    const joined = codec_status.join(", ");
    if (joined.includes("MISSING") || joined.includes("FAIL")) {
      flag("Pillow codecs", `${joined} — see README 'Image support' for platform install hints`, {
        warn: true,
      });
    } else {
      ok("Pillow codecs", joined);
    }
  } catch (e) {
    flag("Pillow", `not importable — ${(e as Error).message ?? e}`);
  }

  // ------------------------------------------------------------------
  // 7. tree-sitter (web-tree-sitter stand-in).
  // ------------------------------------------------------------------
  try {
    await import("web-tree-sitter");
    ok("tree-sitter", "installed — language-pack importable");
  } catch (e) {
    flag("tree-sitter", `not importable — ${(e as Error).message ?? e}`, { warn: true });
  }

  // ------------------------------------------------------------------
  // 8. Project
  // ------------------------------------------------------------------
  _echo("\nProject");
  const cwd = process.cwd();
  ok("cwd", cwd);
  const proj = project.find_project(cwd);
  if (proj !== null) {
    ok("detected", `yes (marker: ${proj.marker})`);
    ok("hash", `${proj.hash.slice(0, 8)}...`);
    ok("canonical_root", proj.root);
    try {
      const [sv, fc] = db.openProject(proj.hash, (conn) => {
        const row = conn
          .prepare("SELECT value FROM meta WHERE key='schema_version'")
          .get() as { value: unknown } | undefined;
        const sv_local: unknown = row ? row.value : "?";
        const fc_row = conn.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number } | undefined;
        const fc_local = fc_row ? fc_row.c : 0;
        return [sv_local, fc_local] as [unknown, number];
      });
      ok("schema_version", String(sv));
      ok("file_count", fc === 0 ? `${fc} (not yet indexed)` : String(fc));
    } catch (e) {
      flag("project db", String((e as Error).message ?? e));
    }
  } else {
    flag("detected", "no project marker found in cwd or parents", { warn: true });
  }

  // ------------------------------------------------------------------
  // 8a. All-projects index health
  // ------------------------------------------------------------------
  _echo("\nIndexed projects");
  try {
    const _all_projs = db.openGlobalReadonly((conn) =>
      conn.prepare("SELECT hash, root FROM projects").all() as Array<{
        hash: string;
        root: string;
      }>,
    );
    if (_all_projs.length === 0) {
      ok("(none)", "no projects indexed yet — run `token-goat index` inside a project");
    } else {
      let _total_files_all = 0;
      const _inaccessible: string[] = [];
      const _proj_rows_out: string[] = [];
      for (const _pr of _all_projs) {
        const _ph = _pr.hash;
        const _pr_root = _pr.root;
        const _proj_db_path = paths.projectDbPath(_ph);
        if (!_exists(_proj_db_path)) {
          _inaccessible.push(`${_pr_root} (DB missing: ${_proj_db_path})`);
          continue;
        }
        try {
          const _pfc = db.openProjectReadonly(_ph, (pc) => {
            const r = pc.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number };
            return r.c;
          });
          _total_files_all += _pfc;
          _proj_rows_out.push(`${_pr_root} (${_pfc} files)`);
        } catch (pe) {
          _inaccessible.push(`${_pr_root} (${(pe as Error).message ?? pe})`);
        }
      }
      ok("total projects", String(_all_projs.length));
      ok("total indexed files", String(_total_files_all));
      for (const _pline of _proj_rows_out.slice(0, 5)) {
        ok("project", _pline);
      }
      if (_proj_rows_out.length > 5) {
        ok(
          "...",
          `(${_proj_rows_out.length - 5} more — run \`token-goat stats --by-project\` for full list)`,
        );
      }
      for (const _bad of _inaccessible) {
        flag("inaccessible", _bad, { warn: true });
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      ok("(none)", "no global.db yet — nothing indexed");
    } else {
      flag("index health", String((e as Error).message ?? e), { warn: true });
    }
  }

  // ------------------------------------------------------------------
  // 8a-large. Large file summary across all indexed projects
  // ------------------------------------------------------------------
  _echo("\nLarge files (current thresholds)");
  try {
    const _lf_cfg = (config.load().indexing ?? {}) as Required<IndexingConfig>;
    const _lf_skip_bytes = _lf_cfg.large_file_skip_kb * 1024;
    const _lf_symbol_only_bytes = _lf_cfg.large_file_symbol_only_kb * 1024;
    let _lf_total_skipped = 0;
    let _lf_total_symbol_only = 0;
    let _lf_project_count = 0;
    try {
      const _lf_all_projs = db.openGlobalReadonly((gconn) =>
        gconn.prepare("SELECT hash, root FROM projects").all() as Array<{
          hash: string;
          root: string;
        }>,
      );
      for (const _lf_pr of _lf_all_projs) {
        const _lf_ph = _lf_pr.hash;
        const _lf_db_path = paths.projectDbPath(_lf_ph);
        if (!_exists(_lf_db_path)) {
          continue;
        }
        try {
          db.openProjectReadonly(_lf_ph, (_lf_pc) => {
            const _s = _lf_pc
              .prepare("SELECT COUNT(*) AS c FROM files WHERE size > ?")
              .get(_lf_skip_bytes) as { c: number } | undefined;
            _lf_total_skipped += Math.trunc(_s ? _s.c : 0);
            const _so = _lf_pc
              .prepare("SELECT COUNT(*) AS c FROM files WHERE size > ? AND size <= ?")
              .get(_lf_symbol_only_bytes, _lf_skip_bytes) as { c: number } | undefined;
            _lf_total_symbol_only += Math.trunc(_so ? _so.c : 0);
          });
          _lf_project_count += 1;
        } catch {
          continue;
        }
      }
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("not found"))) {
        throw e;
      }
      // no global.db yet
    }
    if (_lf_project_count === 0) {
      ok("summary", "no projects indexed yet");
    } else {
      ok(
        "symbol-only files",
        `${_lf_total_symbol_only} (>${_lf_cfg.large_file_symbol_only_kb} KB, ` +
          `≤${_lf_cfg.large_file_skip_kb} KB, symbols indexed but not embedded)`,
      );
      if (_lf_total_skipped > 0) {
        flag(
          "oversized files in index",
          `${_lf_total_skipped} files >${_lf_cfg.large_file_skip_kb} KB found in DB ` +
            `(indexed before threshold was applied; re-run \`token-goat index --full\` to enforce)`,
          { warn: true },
        );
      } else {
        ok("oversized files in index", "0 (none exceed the skip threshold)");
      }
    }
  } catch (e) {
    flag("large files", `check failed — ${(e as Error).message ?? e}`, { warn: true });
  }

  // ------------------------------------------------------------------
  // 8b. Hook wrapper
  // ------------------------------------------------------------------
  _echo("\nHook wrapper");
  const wrapper_path = paths.hookWrapperPath();
  if (!_exists(wrapper_path)) {
    flag("exists", `NOT FOUND at ${wrapper_path} — run \`token-goat install\` to create it`);
  } else {
    ok("exists", wrapper_path);

    // Drift detection.
    try {
      const on_disk = fs.readFileSync(wrapper_path).toString("utf8");
      const expected = paths.hookWrapperContent();
      if (on_disk === expected) {
        ok("content", "up to date");
      } else {
        flag("content", "differs from expected — run `token-goat install` to refresh", {
          warn: true,
        });
      }
    } catch (e) {
      flag("content", `could not read — ${(e as Error).message ?? e}`, { warn: true });
    }

    // Functional check: invoke the wrapper with --version.
    try {
      const _wrap_result = self._subprocessRun([String(wrapper_path), "--version"], {
        timeout: 10,
      });
      if (_wrap_result.returncode === 0 && _wrap_result.stdout.trim()) {
        ok("invoke", `ok — ${Array.from(_wrap_result.stdout.trim()).slice(0, 80).join("")}`);
      } else {
        flag(
          "invoke",
          `exit ${_wrap_result.returncode} — ${Array.from((_wrap_result.stderr || _wrap_result.stdout).trim()).slice(0, 120).join("")}`,
          { warn: true },
        );
      }
    } catch (e) {
      if (e instanceof TimeoutExpired) {
        flag("invoke", "timed out after 10s", { warn: true });
      } else if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        flag("invoke", "wrapper not executable or not found by shell", { warn: true });
      } else {
        flag("invoke", `error — ${(e as Error).message ?? e}`, { warn: true });
      }
    }
  }

  // ------------------------------------------------------------------
  // 9. Worker
  // ------------------------------------------------------------------
  _echo("\nWorker");
  const pid_path = paths.workerPidPath();
  const hb_path = paths.workerHeartbeatPath();
  if (_exists(pid_path)) {
    try {
      const [pid_val, pid_interpreter] = worker._read_pid_info(
        fs.readFileSync(pid_path, "utf8"),
      );
      if (worker._pidExists(pid_val)) {
        let _pid_label = `PID ${pid_val}`;
        if (pid_interpreter) {
          _pid_label += `, interpreter ${pid_interpreter}`;
        }
        ok("pid file", `present (${_pid_label})`);
        if (_exists(hb_path)) {
          const hb_age = Date.now() / 1000 - fs.statSync(hb_path).mtimeMs / 1000;
          const stale_after = worker.heartbeat_stale_threshold();
          if (hb_age <= stale_after) {
            ok("heartbeat", `${Math.trunc(hb_age)}s ago — fresh`);
          } else {
            flag(
              "heartbeat",
              `${Math.trunc(hb_age)}s ago — stale (threshold ${Math.trunc(stale_after)}s)`,
              { warn: true },
            );
          }
        } else {
          flag("heartbeat", "missing", { warn: true });
        }
      } else {
        let _dead_label = `present but PID ${pid_val} not alive`;
        if (pid_interpreter) {
          _dead_label += ` (interpreter ${pid_interpreter})`;
        }
        flag("pid file", _dead_label, { warn: true });
        if (_exists(hb_path)) {
          try {
            const hb_age = Date.now() / 1000 - fs.statSync(hb_path).mtimeMs / 1000;
            const _ZOMBIE_THRESHOLD = 300;
            if (hb_age > _ZOMBIE_THRESHOLD) {
              flag(
                "heartbeat",
                `${Math.trunc(hb_age)}s ago — zombie worker (pid gone, heartbeat stale)`,
                { warn: true },
              );
            } else {
              ok("heartbeat", `${Math.trunc(hb_age)}s ago — process recently exited`);
            }
          } catch {
            // heartbeat file disappeared between exists() and stat()
          }
        }
      }
    } catch (e) {
      flag("pid file", `unreadable — ${(e as Error).message ?? e}`, { warn: true });
    }
  } else {
    ok("pid file", "not present");
    flag(
      "status",
      "not running — run `token-goat worker --start` to enable incremental indexing",
      { warn: true },
    );
  }

  // Worker claim file.
  const claim_path = worker._worker_claim_path();
  if (!_exists(claim_path)) {
    ok("claim file", "not present");
  } else if (worker._worker_claim_is_stale(claim_path)) {
    flag("claim file", "stale (owner gone) — auto-reclaimed on next spawn", { warn: true });
  } else {
    try {
      const claim_pid = parseInt(fs.readFileSync(claim_path, "utf8").split("\n", 1)[0]!, 10);
      if (Number.isNaN(claim_pid)) {
        throw new Error("not a number");
      }
      ok("claim file", `held by live PID ${claim_pid}`);
    } catch {
      ok("claim file", "held (owner mid-startup)");
    }
  }

  // Worker pool size.
  try {
    const _wk_cfg = (config.load().worker ?? {}) as Required<WorkerConfig>;
    const _ceil = config.WORKER_MAX_POOL_CEILING;
    ok("pool workers", `max_pool_workers=${_wk_cfg.max_pool_workers} (ceiling=${_ceil})`);
  } catch (e) {
    flag("pool workers", `config unavailable — ${(e as Error).message ?? e}`, { warn: true });
  }

  // Index-spawn markers.
  const locks_dir = paths.locksDir();
  if (fix) {
    const reaped = worker.reap_stale_index_markers();
    ok("index markers", `reaped ${reaped} stale marker(s)`);
  }
  let markers: string[] = [];
  if (_exists(locks_dir)) {
    markers = fs
      .readdirSync(locks_dir)
      .filter((n) => n.endsWith(".indexing"))
      .map((n) => nodePath.join(locks_dir, n))
      .sort();
  }
  if (markers.length === 0) {
    ok("index markers", "none");
  } else {
    for (const m of markers) {
      const stem = nodePath.basename(m, ".indexing");
      if (worker._index_spawn_active(m)) {
        ok("index marker", `${stem.slice(0, 8)} — index spawn active`);
      } else {
        flag("index marker", `${stem.slice(0, 8)} — stale, safe to delete`, { warn: true });
      }
    }
  }

  // ------------------------------------------------------------------
  // 10. Dirty queue
  // ------------------------------------------------------------------
  _echo("\nDirty queue");
  const queue_path = paths.dirtyQueuePath();
  if (!_exists(queue_path)) {
    ok("depth", "0 (no queue file)");
  } else {
    let depth: number | null = null;
    try {
      depth = _splitlines(fs.readFileSync(queue_path, "utf8")).filter((ln) => ln.trim()).length;
    } catch (e) {
      flag("depth", `unreadable — ${(e as Error).message ?? e}`, { warn: true });
    }
    if (depth !== null) {
      if (depth === 0) {
        ok("depth", "0 (empty)");
      } else if (depth < 200) {
        ok("depth", `${depth} pending (worker drains on next poll)`);
      } else {
        flag("depth", `${depth} pending — worker may be down or behind`, { warn: true });
      }
    }
  }

  // ------------------------------------------------------------------
  // 11. Scheduled tasks / autostart
  // ------------------------------------------------------------------
  _echo("\nScheduled tasks");
  if (process.platform === "win32") {
    // No winreg analogue in Node; report not-installed unless the worker task
    // check reports otherwise (mirrors install._check_worker_task best-effort).
    try {
      const status = install._check_worker_task();
      if (status.startsWith("installed")) {
        ok("token-goat-worker", status);
      } else {
        flag("token-goat-worker", "NOT INSTALLED (run `token-goat install`)", { warn: true });
      }
    } catch (e) {
      flag("token-goat-worker", `registry error: ${(e as Error).message ?? e}`, { warn: true });
    }
  } else if (process.platform === "darwin") {
    const _plist = install._launchd_plist_path();
    if (_exists(_plist)) {
      ok("token-goat-worker", `LaunchAgent: ${_plist}`);
    } else {
      flag("token-goat-worker", "LaunchAgent NOT INSTALLED (run `token-goat install`)", {
        warn: true,
      });
    }
  } else {
    const _systemd = install._systemd_service_path();
    const _xdg = install._xdg_autostart_path();
    if (_exists(_systemd)) {
      ok("token-goat-worker", `systemd user service: ${_systemd}`);
    } else if (_exists(_xdg)) {
      ok("token-goat-worker", `XDG autostart: ${_xdg}`);
    } else {
      flag("token-goat-worker", "autostart NOT INSTALLED (run `token-goat install`)", {
        warn: true,
      });
    }
  }

  // ------------------------------------------------------------------
  // 12. Recent log
  // ------------------------------------------------------------------
  _echo("\nRecent log");
  const _now_date = new Date();
  const today = `${_now_date.getFullYear()}-${String(_now_date.getMonth() + 1).padStart(2, "0")}-${String(_now_date.getDate()).padStart(2, "0")}`;
  const log_file = nodePath.join(paths.logsDir(), `${today}.log`);
  if (_exists(log_file)) {
    try {
      const log_lines = _splitlines(fs.readFileSync(log_file).toString("utf8"));
      for (const line of log_lines.slice(-5)) {
        _echo(`  ${line}`);
      }
    } catch (e) {
      flag("log", String((e as Error).message ?? e), { warn: true });
    }
  } else {
    ok("(none)", "no log for today");
  }

  // ------------------------------------------------------------------
  // 12a. Session health
  // ------------------------------------------------------------------
  _echo("\nSession health");
  try {
    const sessions_dir = paths.sessionsDir();
    if (!_exists(sessions_dir)) {
      ok("session files", "0 (directory not yet created)");
    } else {
      const session_files = fs
        .readdirSync(sessions_dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => nodePath.join(sessions_dir, n));
      if (session_files.length === 0) {
        ok("session files", "0 (empty)");
      } else {
        const now = Date.now() / 1000;
        let total_size = 0;
        let oldest_mtime: number | null = null;
        for (const sf of session_files) {
          try {
            const st = fs.statSync(sf);
            total_size += st.size;
            const m = st.mtimeMs / 1000;
            if (oldest_mtime === null || m < oldest_mtime) {
              oldest_mtime = m;
            }
          } catch {
            continue;
          }
        }
        const oldest_age_sec = oldest_mtime !== null ? Math.trunc(now - oldest_mtime) : null;
        ok("session files", `${session_files.length} file(s)`);
        if (oldest_age_sec !== null) {
          const oldest_age_days = oldest_age_sec / 86400;
          if (oldest_age_days > 7) {
            flag(
              "oldest session",
              `${roundHalfEven(oldest_age_days, 1).toFixed(1)}d ago (7+ days; consider \`token-goat clean --sessions\`)`,
              { warn: true },
            );
          } else {
            ok("oldest session", `${Math.trunc(oldest_age_sec / 3600)}h ago`);
          }
        }
        ok("sessions/ size", _humanizeBytes(total_size));
      }
    }
  } catch (e) {
    flag("session health", String((e as Error).message ?? e), { warn: true });
  }

  // ------------------------------------------------------------------
  // 13. Cache sizes
  // ------------------------------------------------------------------
  _echo("\nCache sizes");
  const cache_dirs: Array<[string, string]> = [
    ["bash_outputs", "bash_outputs"],
    ["web_outputs", "web_outputs"],
    ["images", "images"],
    ["skills", "skills"],
  ];
  let cache_total_bytes = 0;
  const cache_details: Array<[string, number, number]> = [];
  for (const [label, dir_name] of cache_dirs) {
    const d = nodePath.join(paths.dataDir(), dir_name);
    if (!_exists(d)) {
      continue;
    }
    try {
      const [total_bytes, file_count] = self._cache_dir_stats(d);
      cache_total_bytes += total_bytes;
      cache_details.push([label, total_bytes, file_count]);
    } catch {
      continue;
    }
  }
  if (cache_details.length > 0) {
    for (const [label, total_bytes, file_count] of cache_details) {
      ok(`${label}`, `${file_count} files, ${_humanizeBytes(total_bytes)}`);
    }
    ok("total cache size", _humanizeBytes(cache_total_bytes));
  } else {
    ok("(none)", "cache directories not yet created");
  }

  // ------------------------------------------------------------------
  // 13-skill. Skill cache health
  // ------------------------------------------------------------------
  _echo("\nSkill cache health");
  try {
    const all_outputs = skill_cache.list_outputs();
    const body_entries = all_outputs.filter(
      (e) => !String(e.output_id ?? "").endsWith("-compact"),
    );
    if (body_entries.length === 0) {
      ok("(none)", "no skill bodies cached yet");
    } else {
      const skill_names = new Set<string>();
      let total_body_bytes = 0;
      let oldest_ts: number | null = null;
      let newest_ts: number | null = null;
      let stale_count = 0;
      for (const entry of body_entries) {
        const oid = entry.output_id;
        if (!oid) {
          continue;
        }
        const meta = skill_cache.read_sidecar(oid);
        let entry_ts: number;
        if (meta !== null) {
          skill_names.add(meta.skill_name);
          total_body_bytes += meta.body_bytes;
          entry_ts = meta.ts;
        } else {
          const parts = String(oid).split("-");
          if (parts.length >= 3) {
            skill_names.add(parts.slice(1, -1).join("-"));
          }
          const disk_bytes = Math.trunc(entry.size_bytes ?? 0);
          total_body_bytes += disk_bytes;
          entry_ts = Number(entry.mtime ?? 0.0);
        }

        if (entry_ts) {
          if (oldest_ts === null || entry_ts < oldest_ts) {
            oldest_ts = entry_ts;
          }
          if (newest_ts === null || entry_ts > newest_ts) {
            newest_ts = entry_ts;
          }
        }

        if (meta !== null && meta.source_path) {
          try {
            const src_path = meta.source_path;
            if (_isFile(src_path)) {
              const src_mtime = fs.statSync(src_path).mtimeMs / 1000;
              if (src_mtime > meta.ts) {
                stale_count += 1;
              }
            }
          } catch {
            // pass
          }
        }
      }

      ok("distinct skills", String(skill_names.size));
      ok("cached entries", String(body_entries.length));
      ok("total body bytes", _humanizeBytes(total_body_bytes));
      if (oldest_ts !== null) {
        const oldest_age_days = (Date.now() / 1000 - oldest_ts) / 86400;
        ok("oldest entry", `${roundHalfEven(oldest_age_days, 1).toFixed(1)}d ago`);
      }
      if (newest_ts !== null) {
        const newest_age_h = (Date.now() / 1000 - newest_ts) / 3600;
        ok("newest entry", `${roundHalfEven(newest_age_h, 1).toFixed(1)}h ago`);
      }
      if (stale_count > 0) {
        flag(
          "stale entries",
          `${stale_count} (source file changed after caching; ` +
            "use `token-goat skill-body <name>` to check currency)",
          { warn: true },
        );
      } else {
        ok("stale entries", "0");
      }

      // Compact-to-body ratio guard.
      try {
        const compact_entries = all_outputs.filter((e) =>
          String(e.output_id ?? "").endsWith("-compact"),
        );
        const _COMPACT_RATIO_WARN = 0.2;
        const low_ratio_skills: string[] = [];
        for (const ce of compact_entries) {
          const coid = ce.output_id ?? "";
          let name_candidate = String(coid);
          if (name_candidate.endsWith("-compact")) {
            name_candidate = name_candidate.slice(0, -"-compact".length);
          }
          const parts = name_candidate.split("-");
          const skill_label = parts.length >= 2 ? parts.slice(1).join("-") : name_candidate;

          const compact_size = Math.trunc(ce.size_bytes ?? 0);
          if (compact_size === 0) {
            continue;
          }

          let body_size: number | null = null;
          for (const be of body_entries) {
            const boid = be.output_id ?? "";
            const bm = skill_cache.read_sidecar(boid);
            if (
              bm !== null &&
              bm.skill_name &&
              bm.skill_name.toLowerCase() === skill_label.toLowerCase()
            ) {
              body_size = bm.body_bytes;
              break;
            }
          }

          if (body_size === null || body_size === 0) {
            continue;
          }

          const ratio = compact_size / body_size;
          if (ratio < _COMPACT_RATIO_WARN) {
            low_ratio_skills.push(
              `${skill_label} (${roundHalfEven(ratio * 100, 0)}% of body — ` +
                `run \`token-goat skill-compact ${skill_label}\` to refresh)`,
            );
          }
        }

        if (low_ratio_skills.length > 0) {
          flag(
            "compact coverage",
            `${low_ratio_skills.length} skill(s) with compact < 20% of body: ` +
              low_ratio_skills.join(", "),
            { warn: true },
          );
        } else {
          ok("compact coverage", "ok (all compacts ≥ 20% of body, or no compacts yet)");
        }

        // Compact SHA-staleness check.
        const sha_stale_skills: string[] = [];
        try {
          const cache_dir_p = skill_cache._skill_outputs_dir();
          for (const ce2 of compact_entries) {
            const coid2 = String(ce2.output_id ?? "");
            if (!coid2) {
              continue;
            }
            const compact_path = nodePath.join(cache_dir_p, coid2);
            if (!_isFile(compact_path)) {
              continue;
            }
            let compact_text: string;
            try {
              compact_text = fs.readFileSync(compact_path).toString("utf8");
            } catch {
              continue;
            }
            const embedded_sha = skill_cache.extract_compact_source_sha(compact_text);
            if (!embedded_sha) {
              continue;
            }

            let name_c = coid2;
            if (name_c.endsWith("-compact")) {
              name_c = name_c.slice(0, -"-compact".length);
            }
            const parts_c = name_c.split("-");
            const label_c = parts_c.length >= 2 ? parts_c.slice(1).join("-") : name_c;

            let body_sha: string | null = null;
            for (const be2 of body_entries) {
              const boid2 = be2.output_id ?? "";
              const bm2 = skill_cache.read_sidecar(boid2);
              if (
                bm2 !== null &&
                bm2.skill_name &&
                bm2.skill_name.toLowerCase() === label_c.toLowerCase()
              ) {
                body_sha = bm2.content_sha;
                break;
              }
            }

            if (body_sha === null) {
              continue;
            }
            if (!body_sha.startsWith(embedded_sha)) {
              sha_stale_skills.push(
                `${label_c} (compact sha=${embedded_sha.slice(0, 8)} ≠ body sha=${body_sha.slice(0, 8)};` +
                  ` run \`token-goat skill-compact ${label_c}\` to refresh)`,
              );
            }
          }
        } catch {
          // pass
        }

        if (sha_stale_skills.length > 0) {
          flag(
            "sha-stale compacts",
            `${sha_stale_skills.length} compact(s) built from a superseded body version: ` +
              sha_stale_skills.join(", "),
            { warn: true },
          );
        } else {
          ok(
            "sha-stale compacts",
            "0 (all compacts match their body SHA, or no SHA recorded)",
          );
        }
      } catch {
        // compact ratio check is best-effort
      }
    }
  } catch (e) {
    flag("skill cache health", String((e as Error).message ?? e), { warn: true });
  }

  // ------------------------------------------------------------------
  // 13a. Index health per project
  // ------------------------------------------------------------------
  _echo("\nIndex health per project");
  try {
    const all_projs = db.openGlobalReadonly((gconn) =>
      gconn.prepare("SELECT hash, root FROM projects").all() as Array<{
        hash: string;
        root: string;
      }>,
    );
    if (all_projs.length === 0) {
      ok("(none)", "no projects indexed yet");
    } else {
      for (const projRow of all_projs) {
        const proj_hash = projRow.hash;
        const proj_root = projRow.root;
        const proj_db_path = paths.projectDbPath(proj_hash);
        if (!_exists(proj_db_path)) {
          flag(`project ${proj_root.slice(0, 40)}`, `DB missing (${proj_db_path})`, {
            warn: true,
          });
          continue;
        }
        try {
          const [file_count, symbol_count, last_mtime] = db.openProjectReadonly(
            proj_hash,
            (pconn) => {
              const fc_row = pconn.prepare("SELECT COUNT(*) AS c FROM files").get() as {
                c: number;
              };
              const fc = fc_row ? fc_row.c : 0;
              const sym_row = pconn.prepare("SELECT COUNT(*) AS c FROM symbols").get() as {
                c: number;
              };
              const sc = sym_row ? sym_row.c : 0;
              const ts_row = pconn.prepare("SELECT MAX(mtime) AS m FROM files").get() as {
                m: number | null;
              };
              const lm = ts_row && ts_row.m ? ts_row.m : null;
              return [fc, sc, lm] as [number, number, number | null];
            },
          );
          const now = Date.now() / 1000;
          let timestamp_str = "never";
          if (last_mtime !== null) {
            const age_sec = Math.trunc(now - last_mtime);
            if (age_sec < 3600) {
              timestamp_str = `${Math.trunc(age_sec / 60)}m ago`;
            } else if (age_sec < 86400) {
              timestamp_str = `${Math.trunc(age_sec / 3600)}h ago`;
            } else {
              timestamp_str = `${Math.trunc(age_sec / 86400)}d ago`;
            }
          }
          ok(
            `project ${proj_root.slice(0, 40)}`,
            `${file_count} files, ${symbol_count} symbols, last indexed ${timestamp_str}`,
          );
        } catch (pe) {
          flag(`project ${proj_root.slice(0, 40)}`, String((pe as Error).message ?? pe), {
            warn: true,
          });
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      ok("(none)", "no global.db yet");
    } else {
      flag("index health per project", String((e as Error).message ?? e), { warn: true });
    }
  }

  // ------------------------------------------------------------------
  // 14. New-cache stores
  // ------------------------------------------------------------------
  _echo("\nCache details");
  for (const [label, dir_name, cap_bytes, cap_file_count] of [
    ["bash outputs", "bash_outputs", 16 * 1024 * 1024, 4096],
    ["web outputs", "web_outputs", 32 * 1024 * 1024, 4096],
    ["session snapshots", "session_snapshots", null, null],
  ] as Array<[string, string, number | null, number | null]>) {
    self._render_cache_section(label, dir_name, cap_bytes, cap_file_count, ok, flag);
  }

  // ------------------------------------------------------------------
  // 13a. Cache hit-rate telemetry (30 d)
  // ------------------------------------------------------------------
  _echo("\nCache hit rates (30 d)");
  try {
    const _cache_cutoff = Math.trunc(Date.now() / 1000) - 30 * 86400;
    let _miss_telemetry_on = false;
    try {
      _miss_telemetry_on =
        ((config.load().stats ?? {}) as Required<StatsConfig>).record_zero_savings;
    } catch {
      // pass
    }
    db.openGlobalReadonly((conn) => {
      for (const [cache_label, hit_kind, miss_kind] of [
        ["image shrink", "image_shrink_cache_hit", "image_shrink"],
        ["bash recall", "bash_output_recall", "bash_output_recall_miss"],
        ["web recall", "web_output_recall", "web_output_recall_miss"],
      ]) {
        const _hit_row = conn
          .prepare("SELECT COUNT(*) AS c FROM stats WHERE kind = ? AND ts >= ?")
          .get(hit_kind, _cache_cutoff) as { c: number } | undefined;
        const _miss_row = conn
          .prepare("SELECT COUNT(*) AS c FROM stats WHERE kind = ? AND ts >= ?")
          .get(miss_kind, _cache_cutoff) as { c: number } | undefined;
        const _hits = Math.trunc(_hit_row ? _hit_row.c : 0);
        const _misses = Math.trunc(_miss_row ? _miss_row.c : 0);
        const _total = _hits + _misses;
        if (_total === 0) {
          ok(cache_label!, "no events");
          continue;
        }
        const _rate = _hits / _total;
        if (hit_kind === "image_shrink_cache_hit") {
          ok(
            cache_label!,
            `${roundHalfEven(_rate * 100, 0)}% (${_hits} hits / ${_total} shrinks; ` +
              `misses are fresh shrinks, also productive)`,
          );
        } else if (_miss_telemetry_on) {
          if (_rate < 0.5 && _total >= 10) {
            flag(
              cache_label!,
              `${roundHalfEven(_rate * 100, 0)}% (${_hits} hits / ${_misses} misses) ` +
                "— low; cap may be too small or eviction too aggressive",
              { warn: true },
            );
          } else {
            ok(cache_label!, `${roundHalfEven(_rate * 100, 0)}% (${_hits} hits / ${_misses} misses)`);
          }
        } else {
          ok(
            cache_label!,
            `${_hits} hits (misses not tracked — set stats.record_zero_savings=true)`,
          );
        }
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      ok("(none)", "no global.db yet");
    } else {
      flag("cache hit rates", String((e as Error).message ?? e), { warn: true });
    }
  }

  // ------------------------------------------------------------------
  // 13b. Configuration
  // ------------------------------------------------------------------
  _echo("\nConfiguration");
  try {
    const cfg = config.load();
    const ca = (cfg.compact_assist ?? {}) as Required<CompactAssistConfig>;
    const sp = (cfg.skill_preservation ?? {}) as Required<SkillPreservationConfig>;
    const hi = (cfg.hints ?? {}) as Required<HintsConfig>;
    const bc = (cfg.bash_compress ?? {}) as Required<BashCompressConfig>;
    const sb = (cfg.session_brief ?? {}) as Required<SessionBriefConfig>;
    const ish = (cfg.image_shrink ?? {}) as Required<ImageShrinkConfig>;
    const cu = (cfg.curator ?? {}) as Required<CuratorConfig>;
    const hb = (cfg.hint_budget ?? {}) as Required<HintBudgetConfig>;
    const rm = (cfg.repomap ?? {}) as Required<RepomapConfig>;
    const st = (cfg.stats ?? {}) as Required<StatsConfig>;
    const wf = (cfg.webfetch ?? {}) as Required<WebFetchConfig>;
    const ix = (cfg.indexing ?? {}) as Required<IndexingConfig>;

    const _config_path = paths.configPath();
    if (_exists(_config_path)) {
      ok("config file", _config_path);
    } else {
      ok(
        "config file",
        `${_config_path} (not present — all defaults active; create this file to customise)`,
      );
    }
    ok("compact_assist.enabled", String(ca.enabled));
    ok("compact_assist.auto_trigger_multiplier", _g(ca.auto_trigger_multiplier));
    ok("compact_assist.max_manifest_tokens", String(ca.max_manifest_tokens));
    ok("compact_assist.lazy_skill_injection", String(ca.lazy_skill_injection));
    ok("skill_preservation.enabled", String(sp.enabled));
    ok("skill_preservation.max_cache_bytes", String(sp.max_cache_bytes));
    ok("skill_preservation.truncation_budget_tokens", String(sp.truncation_budget_tokens));
    ok("skill_preservation.compress_bodies", String(sp.compress_bodies));
    ok("skill_preservation.compress_min_bytes", String(sp.compress_min_bytes));
    ok("hints.json_sidecar", String(hi.json_sidecar));
    if (hi.quiet_hours) {
      ok("hints.quiet_hours", hi.quiet_hours);
    }
    ok("hints.suppress_after_ignored", String(hi.suppress_after_ignored));
    ok("hints.serve_diff_on_reread", String(hi.serve_diff_on_reread));
    ok("bash_compress.enabled", String(bc.enabled));
    ok("bash_compress.max_lines", String(bc.max_lines));
    ok("session_brief.enabled", String(sb.enabled));
    ok("image_shrink.prefer_avif", String(ish.prefer_avif));
    ok("image_shrink.avif_quality", String(ish.avif_quality));
    ok("image_shrink.jpeg_quality", String(ish.jpeg_quality));
    ok("image_shrink.max_image_pixels", String(ish.max_image_pixels));
    ok("curator.enabled", String(cu.enabled));
    ok("curator.min_samples", String(cu.min_samples));
    ok("curator.threshold_pct", String(cu.threshold_pct));
    ok("hint_budget.enabled", String(hb.enabled));
    ok("hint_budget.max_per_session", String(hb.max_per_session));
    ok("hint_budget.max_structured_per_session", String(hb.max_structured_per_session));
    ok("hint_budget.max_index_only_per_session", String(hb.max_index_only_per_session));
    ok("repomap.compact_file_threshold", String(rm.compact_file_threshold));
    ok("repomap.exclude_tests", String(rm.exclude_tests));
    ok("stats.record_zero_savings", String(st.record_zero_savings));
    ok("webfetch.allow", `${wf.allow.length} pattern(s)`);
    ok("webfetch.deny", `${wf.deny.length} pattern(s)`);
    ok(
      "indexing.large_file_symbol_only_kb",
      `${ix.large_file_symbol_only_kb} KB ` +
        `(files larger than this get symbol-only indexing, no embeddings)`,
    );
    ok(
      "indexing.large_file_skip_kb",
      `${ix.large_file_skip_kb} KB ` + `(files larger than this are skipped entirely)`,
    );
    try {
      ok("decision_log.max_per_session", String(session.DECISION_HISTORY_MAX));
    } catch (exc) {
      flag("decision_log.max_per_session", String((exc as Error).message ?? exc), { warn: true });
    }
  } catch (e) {
    flag("config load", String((e as Error).message ?? e), { warn: true });
  }

  // ------------------------------------------------------------------
  // 13c. Compaction budget utilization (30 d)
  // ------------------------------------------------------------------
  _echo("\nCompaction utilization (30 d)");
  try {
    const _compact_cutoff = Math.trunc(Date.now() / 1000) - 30 * 86400;
    const _compact_rows: Array<[number, number, string]> = [];
    db.openGlobalReadonly((conn) => {
      const rows = conn
        .prepare("SELECT detail FROM stats WHERE kind = ? AND ts >= ?")
        .all("compact_manifest", _compact_cutoff) as Array<{ detail: unknown }>;
      for (const _detail_row of rows) {
        const _detail = _detail_row.detail;
        if (!_detail || typeof _detail !== "string") {
          continue;
        }
        const _kv: Record<string, string> = {};
        for (const _part of _detail.split(",")) {
          if (_part.includes("=")) {
            const idx = _part.indexOf("=");
            const _k = _part.slice(0, idx);
            const _v = _part.slice(idx + 1);
            _kv[_k.trim()] = _v.trim();
          }
        }
        const _budget = parseInt(_kv["budget"] ?? "0", 10);
        const _actual = parseInt(_kv["actual"] ?? "0", 10);
        if (Number.isNaN(_budget) || Number.isNaN(_actual)) {
          continue;
        }
        if (_budget <= 0 || _actual < 0) {
          continue;
        }
        const _trigger = _kv["trigger"] ?? "unknown";
        _compact_rows.push([_budget, _actual, _trigger]);
      }
    });

    if (_compact_rows.length === 0) {
      ok("(none)", "no manifest emits in last 30 d");
    } else {
      const _utils = _compact_rows.map(([_b, _a]) => _a / _b).sort((x, y) => x - y);
      const _n = _utils.length;
      const _p50 = _utils[Math.max(0, Math.floor((_n * 50 + 99) / 100) - 1)]!;
      const _p95 = _utils[Math.max(0, Math.floor((_n * 95 + 99) / 100) - 1)]!;
      const _u_max = _utils[_utils.length - 1]!;
      ok(
        "emits",
        `${_n} (p50=${roundHalfEven(_p50 * 100, 0)}%, p95=${roundHalfEven(_p95 * 100, 0)}%, max=${roundHalfEven(_u_max * 100, 0)}%)`,
      );

      const _by_trigger: Record<string, number[]> = {};
      for (const [_b, _a, _t] of _compact_rows) {
        (_by_trigger[_t] ??= []).push(_a / _b);
      }
      for (const _t of ["manual", "auto"]) {
        const _vals = _by_trigger[_t];
        if (_vals && _vals.length > 0) {
          const _avg = _vals.reduce((s, v) => s + v, 0) / _vals.length;
          ok(`${_t} trigger`, `${_vals.length} emits, avg=${roundHalfEven(_avg * 100, 0)}% utilization`);
        }
      }

      const _tiers: Array<[string, number, number]> = [
        ["≤300", 0, 300],
        ["301-500", 301, 500],
        ["501-1500", 501, 1500],
        [">1500", 1501, 10 ** 9],
      ];
      for (const [_label, _lo, _hi] of _tiers) {
        const _bucket = _compact_rows
          .filter(([_b]) => _lo <= _b && _b <= _hi)
          .map(([_b, _a]) => _a / _b);
        if (_bucket.length > 0) {
          const _bucket_avg = _bucket.reduce((s, v) => s + v, 0) / _bucket.length;
          ok(`tier ${_label}`, `${_bucket.length} emits, avg=${roundHalfEven(_bucket_avg * 100, 0)}% utilization`);
        }
      }

      if (_p95 > 0.95) {
        flag(
          "utilization",
          `p95=${roundHalfEven(_p95 * 100, 0)}% — manifests routinely hit the budget cap; ` +
            "consider raising compact_assist.max_manifest_tokens",
          { warn: true },
        );
      } else if (_p95 < 0.3 && _n >= 5) {
        flag(
          "utilization",
          `p95=${roundHalfEven(_p95 * 100, 0)}% — manifests rarely fill the budget; ` +
            "consider lowering compact_assist.max_manifest_tokens to free context",
          { warn: true },
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      ok("(none)", "no global.db yet");
    } else {
      flag("compaction utilization", String((e as Error).message ?? e), { warn: true });
    }
  }

  // ------------------------------------------------------------------
  // 14. Stats summary + 14b. Cumulative-savings projection
  // ------------------------------------------------------------------
  _echo("\nStats");
  let _row: [number, number | null, number | null] | null = null;
  let _cache_row: [number] | null = null;
  let _proj_row: [number | null, number | null, number | null] | null = null;
  let _top_kinds: Array<[string, number]> = [];
  let _unknown_kinds: Array<[string, number]> = [];
  let _last_write_ts: number | null = null;
  try {
    db.openGlobalReadonly((conn) => {
      const r = conn
        .prepare("SELECT COUNT(*) AS c, SUM(tokens_saved) AS ts, SUM(bytes_saved) AS bs FROM stats")
        .get() as { c: number; ts: number | null; bs: number | null };
      _row = [r.c, r.ts, r.bs];
      const cr = conn
        .prepare("SELECT COUNT(*) AS c FROM stats WHERE kind = ? AND ts >= ?")
        .get("session_cache_unavailable", Math.trunc(Date.now() / 1000) - 3600) as { c: number };
      _cache_row = [cr.c];
      const pr = conn
        .prepare("SELECT SUM(tokens_saved) AS s, MIN(ts) AS mn, MAX(ts) AS mx FROM stats")
        .get() as { s: number | null; mn: number | null; mx: number | null };
      _proj_row = [pr.s, pr.mn, pr.mx];

      const _cutoff = Math.trunc(Date.now() / 1000) - 30 * 86400;
      _top_kinds = (
        conn
          .prepare(
            "SELECT kind, SUM(tokens_saved) AS s FROM stats WHERE ts >= ? GROUP BY kind ORDER BY s DESC LIMIT 3",
          )
          .all(_cutoff) as Array<{ kind: string; s: number | null }>
      ).map((row) => [row.kind, Math.trunc(row.s ?? 0)] as [string, number]);

      const _all_kinds = (
        conn.prepare("SELECT DISTINCT kind FROM stats").all() as Array<{ kind: string }>
      ).map((row) => row.kind);
      const _unknown_kind_names = _all_kinds.filter(
        (k) => stats.kind_to_source(k) === stats.SOURCE_OTHER,
      );
      if (_unknown_kind_names.length > 0) {
        const placeholders = _unknown_kind_names.map(() => "?").join(",");
        _unknown_kinds = (
          conn
            .prepare(
              `SELECT kind, COUNT(*) AS c FROM stats WHERE kind IN (${placeholders}) GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 3`,
            )
            .all(..._unknown_kind_names) as Array<{ kind: string; c: number }>
        ).map((row) => [row.kind, Math.trunc(row.c)] as [string, number]);
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      ok("(none)", "no recorded savings yet");
    } else {
      flag("stats", String((e as Error).message ?? e), { warn: true });
    }
  }

  if (_row && (_row as [number, number | null, number | null])[0]) {
    const rr = _row as [number, number | null, number | null];
    ok("events", String(rr[0]));
    ok("tokens saved", String(rr[1] ?? 0));
    ok("bytes saved", String(rr[2] ?? 0));
  } else if (_row !== null) {
    ok("(none)", "no recorded savings yet");
  }

  if (_proj_row && (_proj_row as [number | null, number | null, number | null])[2]) {
    _last_write_ts = Number((_proj_row as [number | null, number | null, number | null])[2]);
    const _age_s = Math.max(0.0, Date.now() / 1000 - _last_write_ts);
    if (_age_s < 3600) {
      ok("last write", `${roundHalfEven(_age_s / 60, 0)}m ago`);
    } else if (_age_s < 86400) {
      ok("last write", `${roundHalfEven(_age_s / 3600, 1).toFixed(1)}h ago`);
    } else if (_age_s < 7 * 86400) {
      flag("last write", `${roundHalfEven(_age_s / 86400, 1).toFixed(1)}d ago (no recent activity)`, {
        warn: true,
      });
    } else {
      flag("last write", `${roundHalfEven(_age_s / 86400, 0)}d ago (stats DB looks stale)`, {
        warn: true,
      });
    }
  }

  if (_top_kinds.length > 0) {
    for (const [kind_name, tokens] of _top_kinds) {
      ok(`top kind: ${kind_name}`, `${tokens} tokens (30d)`);
    }
  }

  if (_unknown_kinds.length > 0) {
    const names = _unknown_kinds.map(([k, c]) => `${k} (${c})`).join(", ");
    flag(
      "unmapped kinds",
      `${names} (add the base kind to _KIND_TO_SOURCE or a family to _KIND_PREFIX_TO_SOURCE; ` +
        "`_overhead` suffix routes via the parent kind automatically)",
      { warn: true },
    );
  } else if (_row && (_row as [number, number | null, number | null])[0]) {
    ok("kind coverage", "all kinds mapped to a source bucket");
  }

  if (_cache_row && (_cache_row as [number])[0]) {
    flag("session-cache", `${(_cache_row as [number])[0]} contention event(s) in the last hour`, {
      warn: true,
    });
  } else if (_cache_row !== null) {
    ok("session-cache", "no contention events in the last hour");
  }

  // 14b. Cumulative-savings projection.
  const _COST_PER_1M_TOKENS = 3.0;
  if (
    _proj_row &&
    (_proj_row as [number | null, number | null, number | null])[0] &&
    (_proj_row as [number | null, number | null, number | null])[1] &&
    (_proj_row as [number | null, number | null, number | null])[2]
  ) {
    const pr = _proj_row as [number | null, number | null, number | null];
    const _total_tokens = Math.trunc(Number(pr[0]));
    const _oldest_ts = Number(pr[1]);
    const _newest_ts = Number(pr[2]);
    const _elapsed_days = (_newest_ts - _oldest_ts) / 86400.0;
    if (_elapsed_days >= 1.0) {
      const _tokens_per_day = _total_tokens / _elapsed_days;
      const _tokens_per_month = _tokens_per_day * 30;
      const _usd_per_month = (_tokens_per_month / 1_000_000) * _COST_PER_1M_TOKENS;
      ok(
        "projected savings",
        `$${roundHalfEven(_usd_per_month, 2).toFixed(2)}/month at current rate ` +
          `(${roundHalfEven(_tokens_per_month, 0).toLocaleString("en-US")} tokens/month, $${_COST_PER_1M_TOKENS}/1M)`,
      );
    } else {
      ok("projected savings", "< 1 day of data — check back tomorrow");
    }
  }

  // ------------------------------------------------------------------
  // 15b. DB contention metric (worker-stderr.log slow-session warnings)
  // ------------------------------------------------------------------
  _echo("\nDB contention");
  const _worker_stderr = nodePath.join(paths.logsDir(), "worker-stderr.log");
  try {
    if (!_exists(_worker_stderr)) {
      ok("slow sessions (24 h)", "0 (no worker-stderr.log)");
    } else {
      const _SLOW_RE = /session slow: ([\d.]+)ms/i;
      const _cutoff_dc = Date.now() / 1000 - 86400;
      let _slow_count = 0;
      let _slow_max_ms = 0.0;
      const _TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
      for (const _line of _splitlines(fs.readFileSync(_worker_stderr).toString("utf8"))) {
        const _m_slow = _SLOW_RE.exec(_line);
        if (!_m_slow) {
          continue;
        }
        const _m_ts = _TS_RE.exec(_line);
        if (_m_ts) {
          const _ts = new Date(_m_ts[1]!.replace(" ", "T") + "Z").getTime() / 1000;
          if (!Number.isNaN(_ts)) {
            if (_ts < _cutoff_dc) {
              continue;
            }
          }
          // unparseable timestamp — include the line anyway
        }
        _slow_count += 1;
        const _ms = parseFloat(_m_slow[1]!);
        if (!Number.isNaN(_ms) && _ms > _slow_max_ms) {
          _slow_max_ms = _ms;
        }
      }
      if (_slow_count === 0) {
        ok("slow sessions (24 h)", "0 — no contention detected");
      } else if (_slow_count < 10) {
        ok("slow sessions (24 h)", `${_slow_count} (max ${roundHalfEven(_slow_max_ms, 0)}ms) — low`);
      } else if (_slow_count < 50) {
        flag(
          "slow sessions (24 h)",
          `${_slow_count} (max ${roundHalfEven(_slow_max_ms, 0)}ms) — moderate; large reindexes hold DB open`,
          { warn: true },
        );
      } else {
        flag(
          "slow sessions (24 h)",
          `${_slow_count} (max ${roundHalfEven(_slow_max_ms, 0)}ms) — HIGH; hooks may stall during reindex`,
          { warn: true },
        );
      }
    }
  } catch (e) {
    flag("slow sessions (24 h)", `unreadable — ${(e as Error).message ?? e}`, { warn: true });
  }

  // ------------------------------------------------------------------
  // 15. Recent hook crashes — only shown with --crashes
  // ------------------------------------------------------------------
  if (crashes) {
    _echo("\nRecent hook crashes");
    try {
      const crash_log = paths.hooksStderrLogPath();
      if (!_exists(crash_log)) {
        ok("(none)", "hooks-stderr.log not found");
      } else {
        const raw_text = fs.readFileSync(crash_log).toString("utf8");
        const blocks = raw_text
          .split("\ntoken-goat hook")
          .map((b) => b.trim())
          .filter((b) => b);
        let display_blocks: string[];
        if (raw_text.startsWith("token-goat hook")) {
          display_blocks = blocks.map((b, i) => (i > 0 ? "token-goat hook " + b : b));
        } else {
          display_blocks = blocks.map((b) => "token-goat hook " + b);
        }
        const last_5 = display_blocks.length > 5 ? display_blocks.slice(-5) : display_blocks;
        if (last_5.length === 0) {
          ok("(none)", "log exists but contains no crash entries");
        } else {
          _echo(`  (showing last ${last_5.length} of ${display_blocks.length} crash block(s))`);
          for (const block of last_5) {
            for (const line of _splitlines(block).slice(0, 6)) {
              _echo(`  ${line}`);
            }
            _echo("  ---");
          }
        }
      }
    } catch (e) {
      flag("crashes", String((e as Error).message ?? e), { warn: true });
    }
  }

  // ------------------------------------------------------------------
  // Context footprint
  // ------------------------------------------------------------------
  try {
    const [ctx_lines, ctx_auto_show] = self._build_context_section();
    if (context || ctx_auto_show) {
      for (const line of ctx_lines) {
        _echo(line);
      }
    }
  } catch (e) {
    if (context) {
      flag("context footprint", String((e as Error).message ?? e), { warn: true });
    }
  }

  _echo("");
}
