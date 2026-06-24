/**
 * indexing command implementations — the TS port of cli.py's batch H
 * (4 commands): memory, git-history, export, index (+ the `_watch_project`
 * helper the `index --watch` flag drives).
 *
 * Faithful 1:1 port of cli.py command bodies:
 *   - memory_cmd     (cli.py:2539)  — project_memory CRUD
 *   - git_history_cmd (cli.py:2586)  — git_history.find_commits_for_file
 *   - cmd_export      (cli.py:8286)  — db.openProjectReadonly SQL → json/csv/ctags
 *   - index           (cli.py:3155)  — parser.index_project + summary render
 *   - _watch_project  (cli.py:3086)  — mtime poll loop (Ctrl+C stops)
 *
 * Output seam: Python `typer.echo` / `raise typer.Exit` / `_error` route through
 * cli_common.ts (`_echo` / `CliExit` / `_error`), identical to the other cli_
 * modules. JSON dump (`export --format json`) uses `json.dumps(ensure_ascii=False,
 * indent=2)` → `JSON.stringify(data, null, 2)`.
 *
 * ASYNC gotcha: `parser.index_project` AND `parser.index_file` are async in the
 * TS port (Python sync) → `index` (for the index_project call) and
 * `_watch_project` (for index_file) are `async`. The CLI delegators in cli.ts
 * `.action(async …)` await accordingly.
 *
 * Spy-ability: every parser/db/embeddings/git_history/project_memory/paths fn
 * the tests patch is called via the `import * as` namespace.
 *
 * `_watch_project` watch seam: Python `time.sleep` + `KeyboardInterrupt`. The TS
 * port uses an injectable `_sleepFn` (restore via `_setSleep(null)`) + a local
 * `KeyboardInterrupt` class; the loop `await _sleepFn(...)` and catches
 * KeyboardInterrupt → "Stopped watching." (mirrors the compact-hint C2 pattern).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import * as db from "./db.js";
import * as embeddings_mod from "./embeddings.js";
import * as git_history from "./git_history.js";
import * as parser from "./parser.js";
import * as paths from "./paths.js";
import * as project_memory from "./project_memory.js";
import { find_project, make_project_at } from "./project.js";
import type { Project } from "./project.js";
import { CliExit, _echo, _error } from "./cli_common.js";
import { getLogger } from "./util.js";
import { registerReset } from "./reset.js";

const _LOG = getLogger("cli_index");

const _WATCH_POLL_INTERVAL = 5.0; // seconds

/** Analogue of Python's KeyboardInterrupt — caught by `_watch_project`'s loop. */
export class KeyboardInterrupt extends Error {
  constructor(message = "interrupted") {
    super(message);
    this.name = "KeyboardInterrupt";
    Object.setPrototypeOf(this, KeyboardInterrupt.prototype);
  }
}

/** Injectable sleep seam (Python `time.sleep`). Test-only override via _setSleep.
 *  Accepts sync fns (void / throwing — like Python time.sleep) or async. */
type SleepFn = (ms: number) => void | Promise<void>;
let _sleepFn: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Override the sleep seam (pass null to restore the real setTimeout impl). */
export function _setSleep(fn: SleepFn | null): void {
  _sleepFn = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

registerReset(() => {
  _sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
});

// ---------------------------------------------------------------------------
// memory (cli.py:2539)
// ---------------------------------------------------------------------------

/**
 * Manage persistent per-project memory facts. Port of cli.py `memory_cmd`.
 */
export function memory_cmd(args: {
  action: string;
  key: string | null;
  value: string | null;
  project_dir: string | null;
}): void {
  const { action, key, value, project_dir } = args;
  const root = project_dir ?? process.cwd();
  const proj = find_project(root);
  if (proj === null) {
    _echo("Not in an indexed project root.", { err: true });
    throw new CliExit(1);
  }

  if (action === "show") {
    const entries = project_memory.load_entries(proj.hash);
    if (Object.keys(entries).length === 0) {
      _echo("(no memory entries)");
    } else {
      for (const k of Object.keys(entries).sort()) {
        _echo(`${k}: ${entries[k]}`);
      }
    }
  } else if (action === "set") {
    if (!key || value === null) {
      _echo("Usage: memory set <key> <value>", { err: true });
      throw new CliExit(1);
    }
    project_memory.set_entry(proj.hash, key, value);
    _echo(`Set ${_pyRepr(key)}`);
  } else if (action === "unset") {
    if (!key) {
      _echo("Usage: memory unset <key>", { err: true });
      throw new CliExit(1);
    }
    project_memory.unset_entry(proj.hash, key);
    _echo(`Removed ${_pyRepr(key)}`);
  } else if (action === "clear") {
    project_memory.clear_all(proj.hash);
    _echo("Memory cleared.");
  } else {
    _echo(`Unknown action ${_pyRepr(action)}. Use: show | set | unset | clear`, {
      err: true,
    });
    throw new CliExit(1);
  }
}

// ---------------------------------------------------------------------------
// git-history (cli.py:2586)
// ---------------------------------------------------------------------------

/** Show recent git commits that touched <file>. Port of cli.py `git_history_cmd`. */
export function git_history_cmd(args: { file: string; limit: number }): void {
  const { file, limit } = args;
  const cwd = process.cwd();
  const proj = find_project(cwd);
  if (proj === null) {
    _echo("Not in an indexed project root.", { err: true });
    throw new CliExit(1);
  }

  let relPath: string;
  try {
    const absFile = path.isAbsolute(file) ? file : path.join(cwd, file);
    relPath = path.relative(proj.root, absFile).split(path.sep).join("/");
    // path.relative never throws, but mirror Python's ValueError guard for a
    // path that escapes the root (results in a rel path starting with "..").
    if (relPath.startsWith("..")) {
      throw new Error("not under project root");
    }
  } catch {
    _echo(`File is not under project root: ${proj.root}`, { err: true });
    throw new CliExit(1);
  }

  const commits = git_history.find_commits_for_file(proj.hash, relPath, { limit });
  if (commits.length === 0) {
    _echo(`No indexed commits found for ${relPath}.`);
    _echo("Tip: run 'token-goat index' to (re)index, or wait for session-start indexing.");
    return;
  }

  const now = Date.now() / 1000;
  for (const c of commits) {
    const ageDays = Math.trunc((now - c.author_ts) / 86_400);
    const ageStr = ageDays > 0 ? `${ageDays}d ago` : "today";
    _echo(`${c.commit_short.slice(0, 8)}  ${c.summary} (${ageStr})`);
  }
}

// ---------------------------------------------------------------------------
// export (cli.py:8286)
// ---------------------------------------------------------------------------

/** RFC-4180 minimal CSV field (quote when it contains delimiter/quote/newline). */
function _csvField(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Python `repr(s)` for a string — single-quoted by default (double only when
 *  the string has a single quote but no double quote). Used by the memory/export
 *  messages that interpolate `{key!r}` / `{fmt!r}`. */
function _pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  const escaped = s.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/**
 * Export the indexed symbol database. Port of cli.py `cmd_export`. Dumps all
 * symbols from the project's index in json/csv/ctags format.
 */
export function cmd_export(args: {
  fmt: string;
  output: string | null;
  project: string | null;
}): void {
  const { fmt, output, project } = args;
  const root = project ?? process.cwd();
  const proj = find_project(root);
  if (proj === null) {
    _error("no project detected — run from a project directory or pass --project");
    throw new CliExit(1);
  }

  const fmtLower = fmt.toLowerCase();
  if (!["json", "csv", "ctags"].includes(fmtLower)) {
    _error(`unknown format ${_pyRepr(fmt)} — choose json, csv, or ctags`);
    throw new CliExit(1);
  }

  type ExportRow = {
    name: string;
    kind: string;
    file_rel: string;
    line: number;
    end_line: number;
    parent_name: string | null;
  };
  let rows: ExportRow[] = [];
  try {
    rows = db.openProjectReadonly(proj.hash, (conn) =>
      conn
        .prepare(
          `SELECT s.name AS name, s.kind AS kind, s.file_rel AS file_rel,
                  s.line AS line, s.end_line AS end_line,
                  p.name AS parent_name
           FROM symbols s
           LEFT JOIN symbols p ON p.id = s.parent_id
           ORDER BY s.file_rel, s.line`,
        )
        .all() as ExportRow[],
    );
  } catch (exc) {
    if (exc instanceof Error && /ENOENT|does not exist|no such table/i.test(exc.message)) {
      rows = []; // FileNotFoundError analogue (index not built yet)
    } else {
      _error(`could not read project index: ${exc}`);
      throw new CliExit(1);
    }
  }

  const toDicts = (): Array<Record<string, unknown>> =>
    rows.map((row) => ({
      name: row.name,
      kind: row.kind,
      file: row.file_rel,
      start_line: row.line,
      end_line: row.end_line,
      parent_name: row.parent_name,
    }));

  let text: string;
  if (fmtLower === "json") {
    text = JSON.stringify(toDicts(), null, 2);
  } else if (fmtLower === "csv") {
    const fieldnames = ["name", "kind", "file", "start_line", "end_line", "parent_name"];
    const dicts = toDicts();
    const lines = [fieldnames.map(_csvField).join(",")];
    for (const d of dicts) {
      lines.push(fieldnames.map((f) => _csvField(d[f])).join(","));
    }
    text = lines.join("\n") + "\n";
  } else {
    // ctags
    const lines = [
      "!_TAG_FILE_SORTED\t1\t/0=unsorted, 1=sorted, 2=foldcase/",
      "!_TAG_FILE_FORMAT\t2\t/extended format/",
    ];
    for (const row of rows) {
      const fileRel = row.file_rel.replace(/\\/g, "/");
      const kind = String(row.kind);
      const kindChar = kind.length > 0 ? kind[0]! : "?";
      let tag = `${row.name}\t${fileRel}\t${row.line};"\t${kindChar}`;
      if (row.parent_name) {
        tag += `\tclass:${row.parent_name}`;
      }
      lines.push(tag);
    }
    text = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }

  if (output) {
    fs.writeFileSync(output, text, "utf8");
    _echo(`exported ${rows.length} symbol(s) to ${output}`, { err: true });
  } else {
    process.stdout.write(text);
  }
}

// ---------------------------------------------------------------------------
// index (cli.py:3155)
// ---------------------------------------------------------------------------

/**
 * Rebuild project/global indices. Port of cli.py `index`. ASYNC (index_project
 * is async). Handles --check (dirty queue), --root/--skills/--plugins/project
 * detection, the index_project call + summary render, --report-large,
 * --embeddings (fail-soft), and --watch.
 */
export async function index_cmd(args: {
  full: boolean;
  embeddings: boolean;
  root: string | null;
  skills: boolean;
  plugins: boolean;
  watch: boolean;
  report_large: boolean;
  verbose: boolean;
  check: boolean;
  ext: string[] | null;
}): Promise<void> {
  const { full, embeddings, skills, plugins, watch, report_large, verbose, check } = args;
  const ext = args.ext;

  // --check: read dirty queue, report pending files without indexing.
  if (check) {
    const queuePath = paths.dirtyQueuePath();
    const pending: unknown[] = [];
    if (fs.existsSync(queuePath)) {
      try {
        const data = fs.readFileSync(queuePath, "utf8");
        for (const line of data.split(/\r\n|\r|\n/)) {
          if (line.trim() === "") continue;
          try {
            const entry = JSON.parse(line);
            if (entry !== null && typeof entry === "object") pending.push(entry);
          } catch {
            // json.JSONDecodeError → skip
          }
        }
      } catch {
        // OSError → ignore
      }
    }
    const nPending = pending.length;
    if (nPending > 0) {
      _echo(`${nPending} files pending re-index. Run \`token-goat index\` to update.`);
      throw new CliExit(1);
    }
    _echo("0 files pending re-index.");
    throw new CliExit(0);
  }

  let proj: Project | null = null;
  if (args.root !== null) {
    const rootPath = path.resolve(fs.realpathSync(args.root));
    if (!fs.statSync(rootPath).isDirectory()) {
      _error(`${rootPath} is not a directory`);
      throw new CliExit(2);
    }
    proj = make_project_at(rootPath);
    _echo(`Indexing ${rootPath} ...`);
  } else if (skills) {
    const rootPath = paths.claudeSkillsDir();
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      _error(`skills directory not found: ${rootPath}`);
      throw new CliExit(1);
    }
    proj = make_project_at(rootPath);
    _echo(`Indexing skills: ${rootPath} ...`);
  } else if (plugins) {
    const rootPath = paths.claudePluginsDir();
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      _error(`plugins directory not found: ${rootPath}`);
      throw new CliExit(1);
    }
    proj = make_project_at(rootPath);
    _echo(`Indexing plugins: ${rootPath} ...`);
  } else {
    proj = find_project(process.cwd());
    if (proj === null) {
      _error("no project detected — run from a project directory");
      throw new CliExit(1);
    }
  }
  const project: Project = proj;

  const tty = Boolean(process.stderr.isTTY);

  const progress = (done: number, total: number): void => {
    if (tty) {
      process.stderr.write(`\r  ${done}/${total} files scanned...`);
    } else {
      _echo(`  ${done}/${total} files scanned...`, { err: true });
    }
  };

  // An empty (or absent) ext list means "no extension filter" — mirror Python's
  // `set(ext) if ext else None`. Guard on length so an empty array (truthy in
  // JS) never produces an empty Set that rejects every file in iter_source_files.
  const extFilter: Set<string> | null =
    ext && ext.length > 0
      ? new Set(ext.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()))
      : null;

  _LOG.info("index start: project=%s mode=%s", path.basename(project.root), full ? "full" : "incremental");
  let summary: parser.IndexProjectResult;
  try {
    summary = await parser.index_project(project, {
      full,
      progress,
      verbose,
      ext_filter: extFilter,
    });
  } catch (exc) {
    _error(`indexing failed: ${exc}`);
    throw new CliExit(1);
  }

  if (tty && summary.total_files > 0) {
    process.stderr.write("\r" + " ".repeat(40) + "\r");
  }

  const langs = summary.languages.length > 0 ? summary.languages.join(", ") : "none";
  _LOG.info(
    "index complete: project=%s files=%d indexed=%d errors=%d dur=%.2fs",
    path.basename(project.root),
    summary.total_files,
    summary.indexed,
    summary.errors,
    summary.duration_sec,
  );
  const symPart = summary.total_symbols > 0 ? `, ${summary.total_symbols} symbols` : "";
  _echo(
    `Indexed ${summary.total_files} files ` +
      `(${summary.indexed} indexed, ` +
      `${summary.skipped_unchanged} skipped unchanged, ` +
      `${summary.errors} errors${symPart}) ` +
      `— ${langs} ` +
      `— in ${summary.duration_sec}s`,
  );

  // Per-extension breakdown (only when multiple distinct extensions indexed).
  const extCounts = summary.ext_counts;
  if (extCounts && Object.keys(extCounts).length > 1) {
    const breakdown = Object.entries(extCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([extension, count]) => `${count} ${extension}`)
      .join(", ");
    _echo(`  by type: ${breakdown}`);
  }

  // Large-files notice + --report-large table.
  const largeFiles = summary.large_files;
  if (largeFiles.length > 0) {
    const nSkipped = largeFiles.filter((lf) => lf.reason === "skipped").length;
    const nSymbolOnly = largeFiles.filter((lf) => lf.reason === "symbol_only").length;
    const parts: string[] = [];
    if (nSkipped) parts.push(`${nSkipped} skipped`);
    if (nSymbolOnly) parts.push(`${nSymbolOnly} symbol-only`);
    _echo(`Large files: ${parts.join(", ")} — use --report-large for details`);
  }
  if (report_large) {
    if (largeFiles.length === 0) {
      _echo("Large files: none (all files within configured thresholds)");
    } else {
      _echo("\nLarge file report:");
      _echo(`  ${"Reason".padEnd(12)} ${"Size".padStart(10)}  Path`);
      _echo(`  ${"-".repeat(12)} ${"-".repeat(10)}  ${"-".repeat(40)}`);
      for (const lf of [...largeFiles].sort(
        (a, b) => b.size_bytes - a.size_bytes || a.rel_path.localeCompare(b.rel_path),
      )) {
        const sizeStr =
          lf.size_bytes < 1024 * 1024
            ? `${Math.round(lf.size_bytes / 1024)} KB`
            : `${(lf.size_bytes / (1024 * 1024)).toFixed(1)} MB`;
        _echo(`  ${lf.reason.padEnd(12)} ${sizeStr.padStart(10)}  ${lf.rel_path}`);
      }
    }
  }

  if (embeddings) {
    try {
      const result = embeddings_mod.index_project_embeddings(project);
      _echo(
        `Embeddings: ${result.chunks_embedded} new, ` +
          `${result.chunks_skipped_unchanged} unchanged ` +
          `in ${result.duration_sec}s (model=${result.model})`,
      );
    } catch (e) {
      if (e instanceof embeddings_mod.EmbeddingsUnavailable) {
        _echo(`Embeddings skipped: ${e}`);
      } else {
        throw e;
      }
    }
  }

  if (watch) {
    await _watch_project(project);
  }
}

// ---------------------------------------------------------------------------
// _watch_project (cli.py:3086) — mtime poll loop
// ---------------------------------------------------------------------------

/** Scan the project tree for rel-path → mtime (Python `_scan_mtimes`). */
function _scanMtimes(rootDir: string): Map<string, number> {
  const result = new Map<string, number>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const fp = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(fp);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (parser.SKIP_DIRS.has(name)) continue; // prune
        walk(fp);
      } else if (st.isFile()) {
        if (parser._is_generated_filename(name)) continue;
        const rel = path.relative(rootDir, fp).split(path.sep).join("/");
        result.set(rel, st.mtimeMs / 1000);
      }
    }
  };
  walk(rootDir);
  return result;
}

/**
 * Poll the project directory for changed files and reindex them. Port of
 * cli.py `_watch_project`. Runs until interrupted (Ctrl+C / the `_sleep` seam
 * throwing `KeyboardInterrupt`).
 */
export async function _watch_project(proj: Project): Promise<void> {
  _echo(`Watching ${proj.root} — press Ctrl+C to stop`);

  // Initial snapshot (no print — index already ran).
  let mtimes = _scanMtimes(proj.root);

  try {
    while (true) {
      await _sleepFn(_WATCH_POLL_INTERVAL * 1000);
      const newMtimes = _scanMtimes(proj.root);

      const changed: string[] = [];
      for (const [rel, mtime] of newMtimes) {
        if (mtimes.get(rel) !== mtime) changed.push(rel);
      }

      for (const rel of changed) {
        const fp = path.join(proj.root, ...rel.split("/"));
        const fi = await parser.index_file(proj, fp);
        if (fi === null) {
          _LOG.debug("watch: index_file returned None for %s", rel);
          continue;
        }
        try {
          db.projectWriterLock(
            proj.hash,
            () => {
              db.openProject(proj.hash, (conn) => {
                parser.write_file_index(conn, fi);
              });
            },
            { timeoutSec: 10 },
          );
        } catch (exc) {
          _LOG.warning("watch: failed to write index for %s: %s", rel, exc);
          continue;
        }
        const nSym = fi.symbols.length;
        const symWord = nSym === 1 ? "symbol" : "symbols";
        _echo(`reindexed: ${rel} (${nSym} ${symWord})`);
      }

      mtimes = newMtimes;
    }
  } catch (e) {
    if (e instanceof KeyboardInterrupt) {
      _echo("Stopped watching.");
    } else {
      throw e;
    }
  }
}
