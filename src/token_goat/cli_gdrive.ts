/**
 * gdrive command implementations — the TS port of cli.py's batch E (4 commands):
 * gdrive-fetch, gdrive-sections, gdrive-list, gdrive-auth.
 *
 * Faithful 1:1 port of cli.py command bodies (cli.py:2870-3058) plus the one
 * cli.py-local helper this batch is the first to need:
 *   - _emit_path_result (cli.py:164) — shared by `gdrive-fetch` (here) and
 *     `fetch-image` (batch G). Exported so batch G reuses the SAME port instead
 *     of duplicating the three-line if/else.
 *
 * Output seam: Python `typer.echo` / `raise typer.Exit` / `_warn` / `_error`
 * route through cli_common.ts (`_echo` / `CliExit` / `_warn` / `_error` /
 * `_emit_json`), identical to cli_skills.ts / cli_sessions.ts.
 *
 * IMPORTANT — `_emit_path_result` does NOT raise (unlike `_emit_json`): the
 * Python original echoes and returns, so the bare-path/JSON branch just `_echo`s
 * and returns normally. The JSON shape is `{"path": "...", "size": N}` with
 * compact separators (matches `json.dumps(..., separators=(",", ":"))`).
 *
 * ASYNC gotcha: gdrive.fetch_file is async in the TS port (Node download is
 * async), so `gdrive_fetch` / `gdrive_sections` are async and `await` it.
 * gdrive.list_drive_files / _try_adc / _try_stored_oauth / run_oauth_oob_flow
 * stay sync. The CLI delegators in cli.ts `.action(async …)` await accordingly.
 *
 * Spy-ability gotcha: every gdrive fn the tests `vi.spyOn` (fetch_file,
 * list_drive_files) is called via the `import * as gdrive` namespace — the ESM
 * live-binding analogue of Python `patch.object(gdrive, "fetch_file", …)`. The
 * credential seams (gdrive._setGoogleAuthDefault) back the "no creds" fail-soft
 * cases; they reset between tests via gdrive's registerReset hook.
 */
import * as fs from "node:fs";

import * as gdrive from "./gdrive.js";
import { CliExit, _echo, _emit_json, _error, _warn } from "./cli_common.js";

/**
 * Echo a local file path result, either as JSON or plain text. Port of
 * cli.py `_emit_path_result` (cli.py:164). Shared with `fetch-image`
 * (batch G) — exported for reuse.
 *
 * Does NOT raise CliExit (the Python original just echoes and returns; both
 * callers return immediately after). The JSON branch emits compact
 * `{"path": "...", "size": N}` mirroring `json.dumps(..., separators=(",", ":"))`.
 */
export function _emit_path_result(filePath: string, json_output: boolean): void {
  if (json_output) {
    const size = fs.statSync(filePath).size;
    _echo(JSON.stringify({ path: filePath, size }));
  } else {
    _echo(filePath);
  }
}

/**
 * Fetch a Google Drive file (image gets auto-shrunk). Returns the local path.
 * Port of cli.py `cmd_gdrive_fetch` (cli.py:2870). Always exits 0 (fail-soft:
 * a Drive outage / auth issue never breaks Claude's session).
 */
export async function gdrive_fetch(args: {
  file_id: string;
  json_output: boolean;
}): Promise<void> {
  const { file_id, json_output } = args;
  let pathResult: string;
  try {
    pathResult = await gdrive.fetch_file(file_id);
  } catch (e) {
    if (e instanceof gdrive.GDriveCredsUnavailable) {
      _warn(String(e));
      throw new CliExit(0);
    }
    _warn(`Drive fetch failed: ${e}`);
    throw new CliExit(0);
  }
  _emit_path_result(pathResult, json_output);
}

/**
 * Download a Drive markdown/text doc and emit its section index (not the body).
 * Port of cli.py `cmd_gdrive_sections` (cli.py:2889). Always exits 0 (fail-soft)
 * so a Drive outage / auth issue never derails the agent — the worst case is it
 * falls back to `gdrive-fetch`.
 */
export async function gdrive_sections(args: {
  file_id: string;
  json_output: boolean;
  max_sections: number;
}): Promise<void> {
  const { file_id, json_output, max_sections } = args;

  let localPath: string;
  try {
    // Image-shrink is disabled: the agent asked for sections, so it expects text.
    // The cached binary path passes through untouched if the file is non-text.
    localPath = await gdrive.fetch_file(file_id, { shrink_if_image: false });
  } catch (e) {
    if (e instanceof gdrive.GDriveCredsUnavailable) {
      _warn(String(e));
      throw new CliExit(0);
    }
    _warn(`Drive fetch failed: ${e}`);
    throw new CliExit(0);
  }

  const index = gdrive.extract_section_index(localPath) as {
    path: string;
    size_bytes: number;
    line_count: number;
    sections: gdrive.SectionIndexEntry[];
    extractor_available: boolean;
    truncated?: boolean;
    truncated_at?: number;
  };

  // Cap the section list so an enormous doc (hundreds of headings) doesn't itself
  // become the token sink we are trying to avoid.
  let sections = index.sections;
  let truncated = false;
  if (sections.length > max_sections) {
    sections = sections.slice(0, max_sections);
    truncated = true;
    index.sections = sections;
    index.truncated = true;
    index.truncated_at = max_sections;
  }

  if (json_output) {
    _emit_json(index);
    return;
  }

  // Plain-text output: path on line 1, then a compact heading list.
  _echo(String(index.path ?? localPath));
  const sizeBytes = index.size_bytes ?? 0;
  const lineCount = index.line_count ?? 0;
  _echo(`size=${sizeBytes}B lines=${lineCount} sections=${sections.length}`);
  if (!index.extractor_available) {
    _echo(
      "(no section index available — file is not a recognised markdown/text type " +
        "or is too large to parse; use `token-goat gdrive-fetch` instead)",
    );
    return;
  }
  for (const sec of sections) {
    const prefix = "#".repeat(sec.level ?? 1);
    const heading = sec.heading ?? "";
    const line = sec.line ?? 0;
    const endLine = sec.end_line;
    const approx = sec.approx_bytes ?? 0;
    const endStr = endLine == null ? "" : `-${endLine}`;
    _echo(`L${line}${endStr} ~${approx}B ${prefix} ${heading}`);
  }
  if (truncated) {
    _echo(`(... truncated at ${max_sections} sections)`);
  }
}

/** Format a byte size as a human-readable B/KB/MB string. Port of the inline
 * logic in cli.py `cmd_gdrive_list` (cli.py:2988-2996). */
function _format_size(sizeBytes: number): string {
  if (sizeBytes === 0) return "0 B";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.floor(sizeBytes / 1024)} KB`;
  return `${Math.floor(sizeBytes / (1024 * 1024))} MB`;
}

/** Map a Drive MIME type to a short human-readable type label. Port of the
 * inline if/elif chain in cli.py `cmd_gdrive_list` (cli.py:2999-3008). */
function _mime_type_label(mime: string): string {
  if (mime.includes("google-apps.document")) return "Google Docs";
  if (mime.includes("google-apps.presentation")) return "Google Slides";
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/plain") return "Text";
  return mime;
}

/**
 * List accessible Google Drive files. Port of cli.py `cmd_gdrive_list`
 * (cli.py:2961). Exits 0 with a credential hint when no files are found.
 */
export function gdrive_list(args: {
  folder: string | null;
  max_results: number;
  json_output: boolean;
}): void {
  const { folder, max_results, json_output } = args;
  const files = gdrive.list_drive_files({ folder_id: folder, max_results });

  if (files.length === 0) {
    if (json_output) {
      _emit_json([]);
    }
    _warn("No files found. Run `token-goat gdrive-auth` to set up credentials.");
    throw new CliExit(0);
  }

  if (json_output) {
    _emit_json(files);
  }

  // Human-readable output.
  for (const f of files) {
    const fileId = f.id ?? "";
    const name = f.name ?? "";
    const mime = f.mimeType ?? "";
    const sizeBytes = f.size_bytes ?? 0;
    const sizeStr = _format_size(sizeBytes);
    const typeStr = _mime_type_label(mime);
    _echo(`${fileId}  ${name} (${typeStr}, ${sizeStr})`);
  }
}

/**
 * One-time Google Drive auth setup. Tries ADC first, then the stored OAuth
 * creds, then prints setup instructions (or runs the OAuth flow when given
 * `--client-secrets`). Port of cli.py `cmd_gdrive_auth` (cli.py:3013).
 */
export function gdrive_auth(args: { client_secrets: string | null }): void {
  const { client_secrets } = args;

  // Check ADC.
  let creds = gdrive._try_adc();
  if (creds !== null) {
    _echo("Google Application Default Credentials detected. token-goat gdrive-fetch will work.");
    throw new CliExit(0);
  }

  // Check existing stored creds.
  creds = gdrive._try_stored_oauth();
  if (creds !== null) {
    _echo("Stored OAuth credentials valid. token-goat gdrive-fetch will work.");
    throw new CliExit(0);
  }

  // Need to set up OAuth.
  if (client_secrets === null) {
    _echo("No credentials available. To set up:");
    _echo("");
    _echo("Option A (recommended if you have gcloud installed):");
    _echo("  gcloud auth application-default login --scopes https://www.googleapis.com/auth/drive.readonly");
    _echo("");
    _echo("Option B: OAuth client secrets");
    _echo("  1. Visit https://console.cloud.google.com/apis/credentials");
    _echo("  2. Create OAuth 2.0 Client ID (type: Desktop)");
    _echo("  3. Download the JSON, then run:");
    _echo("       token-goat gdrive-auth --client-secrets path/to/client_secret.json");
    _echo("");
    _echo("Option C: skip — token-goat gdrive-fetch will fall back to a clear error,");
    _echo("and Claude's existing Drive MCP will be used directly (no token-savings).");
    throw new CliExit(0);
  }

  if (!fs.existsSync(client_secrets)) {
    _error(`file not found: ${client_secrets}`);
    throw new CliExit(1);
  }

  try {
    const outPath = gdrive.run_oauth_oob_flow(client_secrets);
    _echo(`Credentials saved to ${outPath}. token-goat gdrive-fetch will work.`);
  } catch (e) {
    _error(`OAuth flow failed: ${e}`);
    throw new CliExit(1);
  }
}
