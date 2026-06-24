/**
 * Skills + doc-compact command implementations — the TS port of cli.py's batch D
 * (8 commands): skill-body, skill-compact, compact-doc, skill-history,
 * skill-diff, skill-size, baseline, skill-list.
 *
 * Faithful 1:1 port of these cli.py command bodies + their cli.py-local helpers
 * (none of which were ported before this batch):
 *   - _compile_grep_pattern   (cli.py:3573)
 *   - _apply_smart_default    (cli.py:3631)
 *   - _apply_recall_filters   (cli.py:3587)
 *   - _run_history_listing_command (cli.py:4112) — generic; exported so batch F
 *     (bash/web/mcp history) can reuse it.
 *   - _resolve_skill_body_for_compact (cli.py:4802)
 *   - _generate_compact_for_body      (cli.py:4846)
 *
 * Output seam: Python `typer.echo` / `raise typer.Exit` / `_error` route through
 * cli_common.ts (`_echo` / `CliExit` / `_error` / `_emit_json`), identical to
 * cli_sessions.ts. `json.dumps(x, ensure_ascii=False, separators=(",", ":"))` →
 * bare `JSON.stringify(x)` (every batch-D json dump passes ensure_ascii=False).
 * The three commands that call `_emit_json` in Python (skill-size, baseline,
 * skill-list) keep calling it here — it echoes compact JSON then throws
 * CliExit(0), exactly matching the Python control flow where the human output
 * after it is only reached when not in json mode.
 *
 * Dependency naming gotcha: skill_cache is snake_case but db.recordStat,
 * baseline.collectBaseline/formatReport, paths.* are camelCase — call each by
 * its actual exported name.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import * as baseline_mod from "./baseline.js";
import * as compact from "./compact.js";
import * as db from "./db.js";
import * as doc_compact from "./doc_compact.js";
import * as hooks_skill from "./hooks_skill.js";
import * as install from "./install.js";
import * as session from "./session.js";
import * as skill_cache from "./skill_cache.js";
import { find_project } from "./project.js";
import { _splitlinesKeepends, _unifiedDiff } from "./hints.js";
import { roundHalfEven } from "./skill_cache.js";
import { CliExit, _echo, _emit_json, _error } from "./cli_common.js";
import { getLogger } from "./util.js";

import * as self from "./cli_skills.js";

const _LOG = getLogger("cli_skills");

// ---------------------------------------------------------------------------
// Smart-default recall constants (cli.py:3468-3474).
// ---------------------------------------------------------------------------
const _SMART_DEFAULT_HEAD = 30;
const _SMART_DEFAULT_TAIL = 80;
const _SMART_DEFAULT_THRESHOLD = _SMART_DEFAULT_HEAD + _SMART_DEFAULT_TAIL;

// ---------------------------------------------------------------------------
// Python-semantics parity helpers
// ---------------------------------------------------------------------------

/** Byte length of *s* as UTF-8 — Python `len(s.encode())`. */
function _byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Code-point slice — Python `s[start:end]` (counts code points, not UTF-16 units). */
function _cpSlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

/** Insert thousands separators — Python `f"{n:,}"` for a non-negative integer. */
function _comma(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Python `f"{x:.0f}"` — round-half-to-even at 0 decimals, no decimal point. */
function _fixed0(x: number): string {
  return String(roundHalfEven(x, 0));
}

/**
 * Python `str.splitlines()` (NO keepends): split on newlines and drop the
 * terminators; a trailing line break does NOT yield a final empty string, and
 * the empty string yields []. Skill bodies are markdown so the common
 * `\r\n|\r|\n` set suffices (the exotic Unicode line boundaries Python also
 * recognises do not occur here).
 */
function _splitlines(s: string): string[] {
  if (s === "") return [];
  const out = s.split(/\r\n|\r|\n/);
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Compile *pattern* as a regex, falling back to a literal match on invalid
 * syntax. Port of cli.py `_compile_grep_pattern`: agents may pass a regex or a
 * plain string; invalid regex is treated as a literal rather than erroring.
 * Returned regex carries no `g` flag, so `.test()` is stateless.
 */
export function _compile_grep_pattern(pattern: string, case_sensitive: boolean): RegExp {
  const flags = case_sensitive ? "" : "i";
  try {
    return new RegExp(pattern, flags);
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  }
}

/** Return head+tail slice with an elision marker, or the original list unchanged. */
export function _apply_smart_default(lines: string[]): string[] {
  const total = lines.length;
  if (total <= _SMART_DEFAULT_THRESHOLD) return lines;
  const elided = total - _SMART_DEFAULT_HEAD - _SMART_DEFAULT_TAIL;
  const marker = `[token-goat: ${elided} lines elided; pass --full for all ${total} lines]`;
  return [...lines.slice(0, _SMART_DEFAULT_HEAD), marker, ...lines.slice(-_SMART_DEFAULT_TAIL)];
}

/**
 * Apply the standard head/tail/grep/full slicing pipeline to *lines*. Port of
 * cli.py `_apply_recall_filters`.
 */
function _apply_recall_filters(
  lines: string[],
  opts: { head: number; tail: number; grep: string | null; full: boolean; case_sensitive?: boolean },
): string[] {
  const { head, tail, grep, full } = opts;
  const case_sensitive = opts.case_sensitive ?? false;
  const slicing_requested = Boolean(grep) || head > 0 || tail > 0;
  let out = lines;
  if (grep) {
    const pat = _compile_grep_pattern(grep, case_sensitive);
    out = out.filter((ln) => pat.test(ln));
  }
  if (head > 0) {
    out = out.slice(0, head);
  }
  if (tail > 0) {
    out = out.slice(-tail);
  }
  if (!slicing_requested && !full) {
    out = _apply_smart_default(out);
  }
  return out;
}

/**
 * Shared implementation for skill-history (and, later, bash/web/mcp history).
 * Port of cli.py `_run_history_listing_command`. `cacheModule` must expose
 * `list_outputs()` and `read_sidecar(oid)`.
 */
export function _run_history_listing_command(
  cacheModule: {
    list_outputs: () => Array<{ output_id?: string; size_bytes?: number; mtime?: number }>;
    read_sidecar: (oid: string) => unknown;
  },
  opts: {
    json_output: boolean;
    limit: number;
    empty_msg: string;
    json_sidecar_fields: (sidecar: unknown) => Record<string, unknown>;
    format_entry: (oid: string, size: number, age: number, sidecar: unknown) => string;
    since_secs?: number | null;
  },
): void {
  const { json_output, limit, empty_msg, json_sidecar_fields, format_entry } = opts;
  const since_secs = opts.since_secs ?? null;

  let entries = cacheModule.list_outputs();
  if (since_secs !== null) {
    const cutoff = Date.now() / 1000 - since_secs;
    entries = entries.filter((e) => (e.mtime ?? 0) >= cutoff);
  }
  if (limit > 0) {
    entries = entries.slice(0, limit);
  }

  if (json_output) {
    const out: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      const sidecar = cacheModule.read_sidecar(String(e.output_id ?? ""));
      const row: Record<string, unknown> = { ...e };
      if (sidecar !== null && sidecar !== undefined) {
        Object.assign(row, json_sidecar_fields(sidecar));
      }
      out.push(row);
    }
    _echo(JSON.stringify(out));
    return;
  }

  if (entries.length === 0) {
    _echo(empty_msg);
    return;
  }

  const now = Date.now() / 1000;
  for (const e of entries) {
    const oid = String(e.output_id ?? "");
    const size = Math.trunc(e.size_bytes ?? 0);
    const age = Math.trunc(now - (e.mtime ?? 0));
    const sidecar = cacheModule.read_sidecar(oid);
    _echo(format_entry(oid, size, age, sidecar));
  }
}

/**
 * Resolve the skill body, meta, and source label. Port of cli.py
 * `_resolve_skill_body_for_compact` — also used by skill-body (cli.py inlines an
 * identical copy there). Returns [body, meta, source_label]; body is null when
 * the skill cannot be located.
 */
function _resolve_skill_body_for_compact(
  name: string,
): [string | null, skill_cache.SkillMeta | null, string] {
  const meta_candidates = skill_cache.lookup_all_by_name(name);
  let meta: skill_cache.SkillMeta | null = meta_candidates.length > 0 ? meta_candidates[0]! : null;
  let body: string | null = null;
  let source_label = "cache";
  for (const candidate of meta_candidates) {
    body = skill_cache.load_output(candidate.output_id);
    if (body !== null) {
      meta = candidate;
      break;
    }
    if (candidate.source_path) {
      try {
        body = fs.readFileSync(candidate.source_path, "utf8");
        source_label = `source:${candidate.source_path}`;
        meta = candidate;
        break;
      } catch {
        continue;
      }
    }
  }
  if (body === null) {
    const resolved = hooks_skill._resolve_skill_body_path(name);
    if (resolved) {
      try {
        body = fs.readFileSync(resolved, "utf8");
        source_label = `source:${resolved}`;
      } catch {
        body = null;
      }
    }
  }
  return [body, meta, source_label];
}

/**
 * Generate a compact for *body* and store it. Port of cli.py
 * `_generate_compact_for_body`. Returns [compact_display, compact_source,
 * body_sha_or_empty].
 */
function _generate_compact_for_body(
  body: string,
  name: string,
  meta: skill_cache.SkillMeta | null,
  session_id: string,
): [string, string, string] {
  const marker_compact = skill_cache.extract_compact_from_marker(body);
  const compact_text =
    marker_compact !== null ? marker_compact : skill_cache.generate_compact_summary(body);
  const compact_source = marker_compact !== null ? "marker" : "auto";
  const body_sha = meta !== null ? meta.content_sha : null;
  skill_cache.store_compact(session_id, name, compact_text, body_sha ?? null);
  const compact_tokens = Math.max(1, compact.estimate_tokens(compact_text));
  const compact_display = `--- compact form (${compact_tokens} tokens) ---\n${compact_text}`;
  return [compact_display, compact_source, body_sha ?? ""];
}

// ===========================================================================
// skill-body
// ===========================================================================

export function skill_body(args: {
  name: string;
  head: number;
  tail: number;
  grep: string | null;
  full: boolean;
  json_output: boolean;
  section: string | null;
  compact: boolean;
}): void {
  const { name, head, tail, grep, full, json_output, section } = args;
  const compactFlag = args.compact;

  const meta_candidates = skill_cache.lookup_all_by_name(name);
  let meta: skill_cache.SkillMeta | null = meta_candidates.length > 0 ? meta_candidates[0]! : null;
  let body: string | null = null;
  let source_label = "cache";
  for (const candidate of meta_candidates) {
    body = skill_cache.load_output(candidate.output_id);
    if (body !== null) {
      meta = candidate;
      break;
    }
    if (candidate.source_path) {
      try {
        body = fs.readFileSync(candidate.source_path, "utf8");
        source_label = `source:${candidate.source_path}`;
        meta = candidate;
        break;
      } catch {
        continue;
      }
    }
  }
  if (body === null) {
    const resolved = hooks_skill._resolve_skill_body_path(name);
    if (resolved) {
      try {
        body = fs.readFileSync(resolved, "utf8");
        source_label = `source:${resolved}`;
      } catch {
        body = null;
      }
    }
  }

  if (body === null) {
    _error(
      `no cached body for skill: ${name}. ` +
        "The PostToolUse(Skill) hook captures bodies automatically when skills are invoked. " +
        `To populate the cache: invoke the skill first (Skill(skill=${_pyRepr(name)})), ` +
        "or if the skill file is installed, index it with: " +
        "token-goat index --root ~/.claude/skills/",
    );
    throw new CliExit(1);
  }

  // --compact: return a compact summary instead of the full body.
  if (compactFlag) {
    const _compact_session_id = process.env["CLAUDE_SESSION_ID"] ?? "";
    let compact_text = skill_cache.get_compact(_compact_session_id, name);
    let compact_stale = false;
    if (compact_text && meta !== null && meta.content_sha) {
      const compact_sha = skill_cache.extract_compact_source_sha(compact_text);
      if (compact_sha !== null && !meta.content_sha.startsWith(compact_sha)) {
        compact_stale = true;
        _LOG.info(
          "skill-body --compact: stale compact for %s (compact sha=%s, body sha=%s…); regenerating",
          name,
          compact_sha,
          meta.content_sha.slice(0, 12),
        );
        compact_text = null;
      }
    }
    if (!compact_text) {
      compact_text = skill_cache.generate_compact_summary(body);
      const body_sha = meta !== null ? meta.content_sha : null;
      skill_cache.store_compact(_compact_session_id, name, compact_text, body_sha ?? null);
      compact_stale = false;
    }
    const compact_bare = skill_cache._strip_compact_header(compact_text);
    const compact_tokens = Math.max(1, compact.estimate_tokens(compact_bare));
    const compact_display = `--- compact form (${compact_tokens} tokens) ---\n${compact_bare}`;
    const body_bytes = _byteLen(body);
    const returned_bytes = _byteLen(compact_display);
    const saved_bytes = Math.max(0, body_bytes - returned_bytes);
    const _tokens_saved = Math.max(
      0,
      compact.estimate_tokens(body) - compact.estimate_tokens(compact_display),
    );
    db.recordStat(undefined, "skill_body_recall", {
      bytesSaved: saved_bytes,
      tokensSaved: _tokens_saved,
      detail: `${_cpSlice(name, 0, 48)}:compact`,
    });
    if (json_output) {
      const payload_c: Record<string, unknown> = {
        skill_name: name,
        compact: true,
        source: source_label,
        text: compact_display,
        body_bytes,
        compact_stale,
      };
      if (meta !== null) payload_c["output_id"] = meta.output_id;
      _echo(JSON.stringify(payload_c));
    } else {
      _echo(compact_display);
    }
    return;
  }

  // --section: extract a single named H2/H3/H4 section from the body.
  if (section) {
    const section_text = skill_cache.extract_named_section(body, section);
    if (section_text === null) {
      const all_headings = skill_cache.extract_all_headings(body, 4);
      if (all_headings.length > 0) {
        const heading_labels = all_headings.map(([level, title]) =>
          level >= 4 ? `    ${title}` : level >= 3 ? `  ${title}` : title,
        );
        _error(
          `section ${_pyRepr(section)} not found in skill ${_pyRepr(name)}. ` +
            `Available (##, ###, ####): ${heading_labels.join(", ")}`,
        );
      } else {
        _error(`section ${_pyRepr(section)} not found in skill ${_pyRepr(name)} (no headings detected)`);
      }
      throw new CliExit(1);
    }
    const sliced = section_text;
    const body_bytes = _byteLen(body);
    const returned_bytes = _byteLen(sliced);
    const saved_bytes = Math.max(0, body_bytes - returned_bytes);
    const _tokens_saved = Math.max(
      0,
      compact.estimate_tokens(body) - compact.estimate_tokens(sliced),
    );
    db.recordStat(undefined, "skill_body_recall", {
      bytesSaved: saved_bytes,
      tokensSaved: _tokens_saved,
      detail: `${_cpSlice(name, 0, 48)}::${_cpSlice(section, 0, 16)}`,
    });
    if (json_output) {
      const payload: Record<string, unknown> = {
        skill_name: name,
        section,
        source: source_label,
        text: sliced,
        body_bytes,
      };
      if (meta !== null) payload["output_id"] = meta.output_id;
      _echo(JSON.stringify(payload));
    } else {
      _echo(sliced);
    }
    return;
  }

  const lines = _apply_recall_filters(_splitlines(body), { head, tail, grep, full });
  let sliced = lines.join("\n");

  if (!json_output && !section) {
    const all_headings = skill_cache.extract_all_headings(body, 4);
    if (all_headings.length > 0) {
      const heading_labels = all_headings.map(([level, title]) =>
        level >= 4 ? `    ${title}` : level >= 3 ? `  ${title}` : title,
      );
      sliced = sliced + "\n\n**Sections available:** " + heading_labels.join(", ");
    }
  }

  const body_bytes = _byteLen(body);
  const returned_bytes = _byteLen(sliced);
  const saved_bytes = Math.max(0, body_bytes - returned_bytes);
  const _tokens_saved = Math.max(
    0,
    compact.estimate_tokens(body) - compact.estimate_tokens(sliced),
  );
  db.recordStat(undefined, "skill_body_recall", {
    bytesSaved: saved_bytes,
    tokensSaved: _tokens_saved,
    detail: _cpSlice(name, 0, 64),
  });

  if (json_output) {
    const original_lines = _splitlines(body);
    const original_index = new Map<string, number>();
    for (let i = 0; i < original_lines.length; i++) {
      const ln = original_lines[i]!;
      if (!original_index.has(ln)) original_index.set(ln, i + 1);
    }
    const numbered = lines.map((ln) => ({ lineno: original_index.get(ln) ?? 0, text: ln }));
    const payload2: Record<string, unknown> = {
      skill_name: name,
      source: source_label,
      text: sliced,
      lines: lines.length,
      numbered_lines: numbered,
      total_lines: original_lines.length,
      body_bytes,
    };
    if (meta !== null) {
      payload2["output_id"] = meta.output_id;
      payload2["content_sha"] = meta.content_sha;
      payload2["ts"] = meta.ts;
      payload2["truncated"] = meta.truncated;
      payload2["source_path"] = meta.source_path;
    }
    _echo(JSON.stringify(payload2));
    return;
  }

  _echo(sliced);
}

// ===========================================================================
// skill-compact
// ===========================================================================

export function skill_compact(args: {
  name: string | null;
  json_output: boolean;
  all_skills: boolean;
}): void {
  const { name, json_output, all_skills } = args;
  const _compact_session_id = process.env["CLAUDE_SESSION_ID"] ?? "";

  // ── --all mode: batch-regenerate stale or missing compacts ────────────────
  if (all_skills) {
    if (name !== null) {
      _error("Cannot combine a skill NAME argument with --all.");
      throw new CliExit(1);
    }

    // First pass: pre-generate compacts for all skill files on disk.
    try {
      const pregen_summary = install.pregen_skill_compacts();
      if (!json_output) _echo(`  [pre-gen: ${pregen_summary}]`);
    } catch (_pregen_exc) {
      _LOG.warning("skill-compact --all: pregen pass failed: %s", String(_pregen_exc));
      if (!json_output) _echo(`  [pre-gen: FAILED — ${String(_pregen_exc)}]`);
    }

    let skill_names_raw: string[];
    if (_compact_session_id) {
      const session_cache = session.load(_compact_session_id);
      const namesSet = new Set<string>();
      for (const entry of skill_cache.list_by_session(_compact_session_id)) {
        namesSet.add(entry.skill_name);
      }
      skill_names_raw = [...namesSet];
      const sh = session_cache.skill_history ?? {};
      for (const sname of Object.keys(sh)) {
        if (!skill_names_raw.includes(sname)) skill_names_raw.push(sname);
      }
    } else {
      const namesSet = new Set<string>();
      for (const entry of skill_cache.list_outputs()) {
        const oid = entry.output_id;
        if (!oid || oid.endsWith("-compact")) continue;
        const m = skill_cache.read_sidecar(oid);
        if (m !== null) namesSet.add(m.skill_name);
      }
      skill_names_raw = [...namesSet];
    }

    if (skill_names_raw.length === 0) {
      let msg = "No cached skills found";
      if (_compact_session_id) msg += ` for session ${_cpSlice(_compact_session_id, 0, 16)}`;
      _echo(msg + ".");
      return;
    }

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const results: Array<Record<string, unknown>> = [];

    for (const sname of skill_names_raw.slice().sort()) {
      const [body, meta] = _resolve_skill_body_for_compact(sname);
      if (body === null) {
        if (json_output) results.push({ skill_name: sname, status: "not_found" });
        else _echo(`  ${sname}: not found (skipped)`);
        failed += 1;
        continue;
      }

      const body_sha = meta !== null ? meta.content_sha : "";
      const existing_compact = skill_cache.get_compact(_compact_session_id, sname);
      if (existing_compact && body_sha) {
        const compact_sha = skill_cache.extract_compact_source_sha(existing_compact);
        if (compact_sha !== null && body_sha.startsWith(compact_sha)) {
          if (json_output) results.push({ skill_name: sname, status: "up_to_date" });
          else _echo(`  ${sname}: up-to-date (skipped)`);
          skipped += 1;
          continue;
        }
      }

      try {
        const [compact_display, compact_source] = _generate_compact_for_body(
          body,
          sname,
          meta,
          _compact_session_id,
        );
        const body_bytes = _byteLen(body);
        const returned_bytes = _byteLen(compact_display);
        const saved_bytes = Math.max(0, body_bytes - returned_bytes);
        const _tokens_saved = Math.max(
          0,
          compact.estimate_tokens(body) - compact.estimate_tokens(compact_display),
        );
        db.recordStat(undefined, "skill_body_recall", {
          bytesSaved: saved_bytes,
          tokensSaved: _tokens_saved,
          detail: `${_cpSlice(sname, 0, 48)}:compact:${compact_source}:all`,
        });
        if (json_output) {
          results.push({
            skill_name: sname,
            status: "regenerated",
            compact_source,
            body_bytes,
            saved_bytes,
            saved_tokens: _tokens_saved,
          });
        } else {
          _echo(`  ${sname}: regenerated (${compact_source}, saved ${_tokens_saved} tokens)`);
        }
        processed += 1;
      } catch (exc) {
        if (json_output) results.push({ skill_name: sname, status: "error", error: String(exc) });
        else _echo(`  ${sname}: error — ${String(exc)}`);
        failed += 1;
      }
    }

    if (json_output) {
      _echo(
        JSON.stringify({ all: true, processed, skipped, failed, skills: results }),
      );
    } else {
      _echo(`\nDone: ${processed} regenerated, ${skipped} up-to-date, ${failed} failed/not-found.`);
    }
    return;
  }

  // ── Single-skill mode ─────────────────────────────────────────────────────
  if (name === null) {
    _error("Provide a skill NAME or use --all to process every cached skill.");
    throw new CliExit(1);
  }

  const [body, meta, source_label] = _resolve_skill_body_for_compact(name);

  if (body === null) {
    _error(
      `no cached body for skill: ${name}. ` +
        "Invoke the skill first to populate the cache, " +
        "or index the skill directory: token-goat index --root ~/.claude/skills/",
    );
    throw new CliExit(1);
  }

  const [compact_display, compact_source] = _generate_compact_for_body(
    body,
    name,
    meta,
    _compact_session_id,
  );

  const body_bytes = _byteLen(body);
  const returned_bytes = _byteLen(compact_display);
  const saved_bytes = Math.max(0, body_bytes - returned_bytes);
  const _tokens_saved = Math.max(
    0,
    compact.estimate_tokens(body) - compact.estimate_tokens(compact_display),
  );
  db.recordStat(undefined, "skill_body_recall", {
    bytesSaved: saved_bytes,
    tokensSaved: _tokens_saved,
    detail: `${_cpSlice(name, 0, 48)}:compact:${compact_source}`,
  });

  if (json_output) {
    const compact_bare = skill_cache._strip_compact_header(compact_display);
    const quality = skill_cache.score_compact(compact_bare, body);
    const payload: Record<string, unknown> = {
      skill_name: name,
      compact: true,
      compact_source,
      source: source_label,
      text: compact_display,
      body_bytes,
      returned_bytes,
      saved_bytes,
      saved_tokens: _tokens_saved,
      compact_quality: quality,
    };
    if (meta !== null) payload["output_id"] = meta.output_id;
    _echo(JSON.stringify(payload));
  } else {
    _echo(compact_display);
  }
}

// ===========================================================================
// compact-doc
// ===========================================================================

export function compact_doc(args: {
  path: string;
  force: boolean;
  sentences: number;
  show: boolean;
}): void {
  const { force, sentences, show } = args;

  const abs_path = path.resolve(args.path);
  if (!fs.existsSync(abs_path)) {
    _error(`File not found: ${abs_path}`);
    throw new CliExit(1);
  }
  const suffix = path.extname(abs_path).toLowerCase();
  if (suffix !== ".md" && suffix !== ".markdown") {
    _error(`Only .md / .markdown files are supported (got ${_pyRepr(suffix)}).`);
    throw new CliExit(1);
  }

  const proj = find_project(path.dirname(abs_path));
  if (proj === null) {
    _error("Could not find a token-goat project for this path. Is token-goat installed in this repo?");
    throw new CliExit(1);
  }

  const compact_path = doc_compact.compact_path_for(abs_path, proj.hash);

  if (fs.existsSync(compact_path) && !force && doc_compact.is_compact_fresh(compact_path, abs_path)) {
    _echo(`Compact is already fresh: ${compact_path}`);
    const body = doc_compact.read_compact_body(compact_path);
    if (body) {
      const full_bytes = fs.statSync(abs_path).size;
      const compact_bytes = _byteLen(body);
      const full_tok = Math.max(1, Math.floor(full_bytes / 4));
      const compact_tok = Math.max(1, Math.floor(compact_bytes / 4));
      const pct = Math.trunc((compact_tok * 100) / full_tok);
      _echo(
        `Size: ${_comma(compact_tok)} tokens (${pct}% of original ${_comma(full_tok)} tokens) — use --force to regenerate`,
      );
    }
    throw new CliExit(0);
  }

  let source_text: string;
  try {
    source_text = fs.readFileSync(abs_path, "utf8");
  } catch (exc) {
    _error(`Cannot read ${abs_path}: ${String(exc)}`);
    throw new CliExit(1);
  }

  const body = doc_compact.build_extractive_compact(source_text, { max_sentences: sentences });

  let rel: string;
  const cwd = process.cwd();
  if (abs_path === cwd || abs_path.startsWith(cwd + path.sep)) {
    rel = path.relative(cwd, abs_path);
  } else {
    rel = abs_path;
  }

  doc_compact.write_compact(compact_path, abs_path, body, { source_rel: rel });

  const full_bytes = fs.statSync(abs_path).size;
  const compact_bytes = _byteLen(body);
  const full_tok = Math.max(1, Math.floor(full_bytes / 4));
  const compact_tok = Math.max(1, Math.floor(compact_bytes / 4));
  const pct = Math.trunc((compact_tok * 100) / full_tok);
  _echo(`Compact written: ${compact_path}`);
  _echo(`Size: ${_comma(compact_tok)} tokens (${pct}% of original ${_comma(full_tok)} tokens)`);

  if (show) {
    _echo("");
    _echo(body);
  }
}

// ===========================================================================
// skill-history
// ===========================================================================

export function skill_history(args: { json_output: boolean; limit: number }): void {
  const { json_output, limit } = args;

  const _json_fields = (s: unknown): Record<string, unknown> => {
    const m = s as skill_cache.SkillMeta;
    return {
      skill_name: m.skill_name,
      body_bytes: m.body_bytes,
      truncated: m.truncated,
      source_path: m.source_path,
    };
  };

  const _fmt = (oid: string, size: number, age: number, s: unknown): string => {
    const m = s as skill_cache.SkillMeta | null;
    const name_str = m !== null ? m.skill_name : "(no sidecar)";
    const trunc_str = m !== null && m.truncated ? " (truncated)" : "";
    return `${oid}  ${_comma(size).padStart(10)}B  ${String(age).padStart(6)}s ago  ${name_str}${trunc_str}`;
  };

  self._run_history_listing_command(skill_cache, {
    json_output,
    limit,
    empty_msg: "(no cached Skill bodies)",
    json_sidecar_fields: _json_fields,
    format_entry: _fmt,
  });
}

// ===========================================================================
// skill-diff
// ===========================================================================

export function skill_diff(args: { name: string }): void {
  const { name } = args;

  const all_entries = skill_cache.list_outputs();
  const safe_name = name.replace(/:/g, "_");

  const matching: Array<[number, string]> = [];
  for (const entry of all_entries) {
    const oid = entry.output_id ?? "";
    if (!oid) continue;
    const parts = oid.split("-");
    if (parts.length >= 3) {
      const mid = parts.slice(1, -1).join("-");
      if (mid === safe_name) {
        matching.push([entry.mtime ?? 0, oid]);
        continue;
      }
    }
    const meta = skill_cache.read_sidecar(oid);
    if (meta !== null && meta.skill_name === name) {
      matching.push([entry.mtime ?? 0, oid]);
    }
  }

  matching.sort((a, b) => b[0] - a[0]);

  if (matching.length === 0) {
    _error(`no cached versions found for skill: ${name}`);
    throw new CliExit(1);
  }

  if (matching.length === 1) {
    _echo(`Only one cached version of '${name}' found — nothing to diff.`);
    throw new CliExit(0);
  }

  const newer_oid = matching[0]![1];
  const older_oid = matching[1]![1];
  const newer_body = skill_cache.load_output(newer_oid) ?? "";
  const older_body = skill_cache.load_output(older_oid) ?? "";

  const newer_lines = _splitlinesKeepends(newer_body);
  const older_lines = _splitlinesKeepends(older_body);

  const diff = _unifiedDiff(older_lines, newer_lines, {
    fromfile: `${name} (older: ${older_oid.slice(-16)})`,
    tofile: `${name} (newer: ${newer_oid.slice(-16)})`,
    lineterm: "",
  });

  if (diff.length === 0) {
    _echo(`No differences between the two most recent cached versions of '${name}'.`);
    throw new CliExit(0);
  }

  const use_colour = process.stdout.isTTY === true;
  for (const line of diff) {
    if (use_colour) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        _echo(`\u001b[1m${line}\u001b[0m`);
      } else if (line.startsWith("+")) {
        _echo(`\u001b[32m${line}\u001b[0m`);
      } else if (line.startsWith("-")) {
        _echo(`\u001b[31m${line}\u001b[0m`);
      } else {
        _echo(line);
      }
    } else {
      _echo(line);
    }
  }
}

// ===========================================================================
// skill-size
// ===========================================================================

export function skill_size(args: { session_id: string | null; json_output: boolean }): void {
  const { session_id, json_output } = args;

  const skills = skill_cache.get_all_cached_skills(session_id);

  if (skills.length === 0) {
    if (session_id) _echo(`No cached skills for session: ${session_id}`);
    else _echo("No cached skills found");
    throw new CliExit(0);
  }

  const items: Array<Record<string, unknown>> = [];
  let total_overhead = 0;

  for (const skill of skills) {
    const name = String(skill["name"]);
    const body_len = Number(skill["body_len"]);
    const compact_len = Number(skill["compact_len"]);

    const body_chars = skill["body_chars"];
    const body_measure = typeof body_chars === "number" ? body_chars : body_len;

    const body_tokens = Math.max(1, Math.floor(body_measure / 3) + 1);

    const compact_chars = skill["compact_chars"];
    const compact_measure =
      typeof compact_chars === "number" && compact_chars > 0
        ? compact_chars
        : compact_len > 0
          ? compact_len
          : body_measure;
    const compact_tokens = Math.max(1, Math.floor(compact_measure / 3) + 1);
    const compact_is_estimated = compact_len === 0;

    const per_100_overhead = compact_tokens * 100;

    let flag = per_100_overhead > 50_000 ? "⚠ restructure" : "";
    if (compact_is_estimated) {
      flag = (flag + " (no compact, using body estimate)").trim();
    }

    items.push({
      name,
      body_tokens,
      compact_tokens,
      compact_is_estimated,
      per_100_overhead,
      flag,
    });

    total_overhead += per_100_overhead;
  }

  items.sort((a, b) => Number(b["per_100_overhead"]) - Number(a["per_100_overhead"]));

  if (json_output) {
    _emit_json({
      session_id,
      skills: items,
      total_overhead_at_100_turns: total_overhead,
    });
  }

  // Human-readable output.
  for (const item of items) {
    const name = String(item["name"]);
    const body_tokens = Number(item["body_tokens"]);
    const compact_tokens = Number(item["compact_tokens"]);
    const per_100_overhead = Number(item["per_100_overhead"]);
    const flag = String(item["flag"]);

    const overhead_k = per_100_overhead / 1_000.0;
    let line = `${name.padEnd(40)} body:~${String(body_tokens).padStart(6)}  compact:~${String(compact_tokens).padStart(5)}  per-100:~${_fixed0(overhead_k).padStart(6)}k`;
    if (flag) line += `  ${flag}`;
    _echo(line);
  }

  _echo("");
  const total_k = total_overhead / 1_000.0;
  _echo(`Total overhead at 100 turns: ~${_fixed0(total_k)}k tokens`);
}

// ===========================================================================
// baseline
// ===========================================================================

export function baseline(args: {
  session_id: string | null;
  json_output: boolean;
  subagent: boolean;
  window: number;
  usage: boolean;
}): void {
  const { session_id, json_output, subagent, window, usage } = args;

  const report = baseline_mod.collectBaseline(process.cwd(), session_id, {
    windowTokens: window,
    usage,
  });
  if (json_output) {
    _emit_json(report.as_dict());
  }
  for (const line of baseline_mod.formatReport(report, { subagent })) {
    _echo(line);
  }
}

// ===========================================================================
// skill-list
// ===========================================================================

export function skill_list(args: { session_id: string | null; json_output: boolean }): void {
  const { session_id, json_output } = args;

  let resolved_session = session_id;
  if (resolved_session === null) {
    const outputs = skill_cache.list_outputs();
    if (outputs.length === 0) {
      _echo("No cached skills found (no skills have been loaded in any session).");
      throw new CliExit(0);
    }
    const first_oid = outputs[0]!.output_id ?? "";
    resolved_session = first_oid.length >= 16 ? first_oid.slice(0, 16) : first_oid;
  }

  if (!resolved_session) {
    _echo("No cached skills found.");
    throw new CliExit(0);
  }

  const entries = skill_cache.list_by_session(resolved_session);
  if (entries.length === 0) {
    _echo(`No cached skills for session: ${resolved_session}`);
    throw new CliExit(0);
  }

  const mtime_by_oid = new Map<string, number>();
  for (const entry of skill_cache.list_outputs()) {
    const oid = entry.output_id;
    if (oid) mtime_by_oid.set(oid, entry.mtime ?? 0);
  }

  const now = Date.now() / 1000;
  const rows: Array<Record<string, unknown>> = [];

  const _compact_hit_by_name = new Map<string, number>();
  try {
    const _skill_entries = session.get_skill_history(resolved_session);
    for (const [_sk_name, _sk_entry] of Object.entries(_skill_entries ?? {})) {
      _compact_hit_by_name.set(_sk_name, _sk_entry.compact_served_count ?? 0);
    }
  } catch {
    _LOG.debug("skill list: failed to load compact-hit counts for session %s", resolved_session);
  }

  for (const meta of entries) {
    const mtime = mtime_by_oid.get(meta.output_id) ?? meta.ts;
    const age_secs = mtime > 0 ? Math.max(0.0, now - mtime) : -1.0;

    const body = skill_cache.load_output(meta.output_id);
    const body_text = body ?? "";
    const body_tokens = body_text ? compact.estimate_tokens(body_text) : 0;

    let compact_text = skill_cache.get_compact(resolved_session, meta.skill_name);
    if (compact_text === null) {
      const alt_name = meta.skill_name.replace(/_/g, ":");
      compact_text = skill_cache.get_compact(resolved_session, alt_name);
    }
    const has_compact = compact_text !== null;

    const compact_body = compact_text ? skill_cache._strip_compact_header(compact_text) : "";
    const compact_tokens = compact_body ? compact.estimate_tokens(compact_body) : 0;

    let compact_mtime = skill_cache.get_compact_mtime(resolved_session, meta.skill_name);
    if (compact_mtime === null && has_compact) {
      const alt_name_compact = meta.skill_name.replace(/_/g, ":");
      compact_mtime = skill_cache.get_compact_mtime(resolved_session, alt_name_compact);
    }
    const compact_age_secs: number | null =
      compact_mtime !== null ? roundHalfEven(now - compact_mtime, 0) : null;

    const compact_served_count = _compact_hit_by_name.get(meta.skill_name) ?? 0;

    let compact_stale: boolean | null = null;
    if (has_compact && compact_text) {
      const compact_src_sha = skill_cache.extract_compact_source_sha(compact_text) ?? "";
      const body_sha = meta.content_sha ?? "";
      if (compact_src_sha && body_sha) {
        const frag_len = compact_src_sha.length;
        compact_stale = body_sha.slice(0, frag_len) !== compact_src_sha;
      }
    }

    let compact_quality: Record<string, unknown> | null = null;
    let compact_quality_score: number | null = null;
    let compact_quality_issues: string[] | null = null;
    if (has_compact && compact_body && body_text) {
      compact_quality = skill_cache.score_compact(compact_body, body_text);
      compact_quality_score = Number(compact_quality["score"]);
      compact_quality_issues = [...((compact_quality["issues"] as string[] | undefined) ?? [])];
    }

    const _coverage_base = has_compact ? 50 : 0;
    const _coverage_fresh = has_compact && compact_stale !== true ? 30 : 0;
    const _coverage_quality = has_compact ? Math.floor(((compact_quality_score ?? 0) * 20) / 100) : 0;
    const compact_coverage_score = _coverage_base + _coverage_fresh + _coverage_quality;

    rows.push({
      name: meta.skill_name,
      body_tokens,
      has_compact,
      compact_tokens,
      compact_stale,
      compact_age_secs,
      age_secs: roundHalfEven(age_secs, 0),
      compact_served_count,
      compact_quality,
      compact_quality_score,
      compact_quality_issues,
      compact_coverage_score,
    });
  }

  if (json_output) {
    let _total_cov = 0;
    for (const r of rows) _total_cov += Number(r["compact_coverage_score"] ?? 0);
    const compact_coverage_pct = rows.length > 0 ? roundHalfEven(_total_cov / rows.length, 0) : 0;
    _emit_json({
      session_id: resolved_session,
      compact_coverage_pct,
      skills: rows,
    });
  }

  if (rows.length === 0) {
    _echo(`No cached skills for session: ${resolved_session}`);
    throw new CliExit(0);
  }

  _echo(`Session: ${resolved_session}`);
  _echo("");
  const header = `${"Skill".padEnd(40)}  ${"Body".padStart(6)}  ${"Compact".padStart(14)}  ${"Hits".padStart(5)}  ${"Cached"}`;
  _echo(header);
  _echo("-".repeat(header.length));
  for (const row of rows) {
    const name = String(row["name"]);
    const body_tokens = Number(row["body_tokens"]);
    const has_compact = Boolean(row["has_compact"]);
    const compact_tokens = Number(row["compact_tokens"]);
    const age_secs = Number(row["age_secs"]);
    const compact_served = Number(row["compact_served_count"] ?? 0);
    const compact_stale = row["compact_stale"] as boolean | null;
    const _raw_compact_age = row["compact_age_secs"];
    const compact_age_secs = _raw_compact_age !== null && _raw_compact_age !== undefined ? Number(_raw_compact_age) : null;
    const _raw_quality_score = row["compact_quality_score"];
    const compact_quality_score = _raw_quality_score !== null && _raw_quality_score !== undefined ? Number(_raw_quality_score) : null;

    const _QUALITY_POOR_THRESHOLD = 40;
    const _QUALITY_FAIR_THRESHOLD = 60;

    let compact_col: string;
    if (!has_compact) {
      compact_col = "no";
    } else if (compact_stale === true) {
      compact_col = `~${compact_tokens} tok [stale]`;
    } else if (compact_quality_score !== null && compact_quality_score < _QUALITY_POOR_THRESHOLD) {
      compact_col = `~${compact_tokens} tok [poor]`;
    } else if (compact_quality_score !== null && compact_quality_score < _QUALITY_FAIR_THRESHOLD) {
      compact_col = `~${compact_tokens} tok [fair]`;
    } else if (compact_age_secs !== null && compact_age_secs > 86400) {
      const compact_age_days = Math.floor(compact_age_secs / 86400);
      compact_col = `~${compact_tokens} tok [${compact_age_days}d old]`;
    } else {
      compact_col = `~${compact_tokens} tok`;
    }

    const hits_col = !has_compact ? "-" : String(compact_served);

    let age_str: string;
    if (age_secs < 0) {
      age_str = "unknown";
    } else if (age_secs < 60) {
      age_str = `${age_secs}s ago`;
    } else if (age_secs < 3600) {
      age_str = `${Math.floor(age_secs / 60)}m ago`;
    } else {
      age_str = `${Math.floor(age_secs / 3600)}h ${Math.floor((age_secs % 3600) / 60)}m ago`;
    }

    _echo(
      `${name.padEnd(40)}  ~${String(body_tokens).padStart(5)}  ${compact_col.padStart(14)}  ${hits_col.padStart(5)}  ${age_str}`,
    );
  }

  _echo("");
  _echo(`${rows.length} skill(s) cached in this session.`);
}

// ---------------------------------------------------------------------------
// Python repr() of a string for error messages (mirrors cli_sessions._pyRepr).
// ---------------------------------------------------------------------------
function _pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  let quote = "'";
  if (hasSingle && !hasDouble) quote = '"';
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}
