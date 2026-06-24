/**
 * bash_compress CLI-UTILITY FILTERS — TypeScript port of the
 * Curl / Rsync / Ffmpeg / Dotenv Filter subclasses from
 * src/token_goat/bash_compress.py (Run 8).
 *
 * Four filters subclass the concrete Filter base from ./framework.js:
 *   - CurlFilter   — `curl` / `wget` HTTP-client output. Verbose `*` / `>` /
 *                    `<` prefixes, progress-bar tables, wget connection noise.
 *                    Dispatches per-binary on Path(argv[0]).stem.lower().
 *   - RsyncFilter  — `rsync` file-sync output. Drops per-file transfer lines and
 *                    inline progress bars; keeps errors + the stats summary.
 *   - FfmpegFilter — `ffmpeg` / `ffprobe` / `ffplay`. Drops build-info block,
 *                    metadata key-values, collapses frame= progress to the last.
 *   - DotenvFilter — `dotenv`. Collapses ≥2 loading / Exported N / Skipped N
 *                    banners into a single `[dotenv] loaded N vars` summary.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (name, binaries, compress); snake_case module-private regex
 *    constants (_CURL_*, _WGET_*, _RSYNC_*, _FFMPEG_*, _DOTENV_*); the helper
 *    `_is_dotenv_banner` (exported).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored; emulated via _reMatch
 *    (non-global clone + index===0). .search() -> _reSearch / _reSearchObj
 *    (non-global clone, .exec anywhere); capture groups read off the match.
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel export* chain.
 *  - Path(argv[0]).stem.lower() -> local _pathStemLower (final component after
 *    backslash-norm, last suffix stripped, lowercased) — matching framework
 *    _pathStem.
 *  - _maybe_note is framework-PUBLIC and imported. _combine_output is an INSTANCE
 *    method; _finalize / _emit_notes are STATIC methods on Filter.
 *  - Python str.strip()/str.rstrip() (whitespace) -> _strip / _rstrip locals.
 *    line[2:].strip() -> line.slice(2) then _strip.
 *  - Module-global mutable state: NONE. Every counter/list/set is a local inside
 *    compress(); no registerReset seam is needed.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import { Filter, _maybe_note } from "./framework.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(line) — anchored at the START (NOT end-anchored). JS
 * has no anchored-match primitive; emulate via a non-global clone and an
 * index===0 check.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * Python re.Pattern.search(line) returning the match object (or null) for the
 * callers that read capture groups. Non-global clone so lastIndex never leaks.
 */
function _reSearchObj(re: RegExp, line: string): RegExpExecArray | null {
  return _nonGlobal(re).exec(line);
}

/**
 * Python Path(p).stem.lower() — the final path component (after normalising
 * backslashes to forward slashes) with its LAST suffix removed, lowercased.
 */
function _pathStemLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name.toLowerCase();
  }
  return name.slice(0, dot).toLowerCase();
}

/** Python str.strip() — strip leading/trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/, "").replace(/\s+$/, "");
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/** Python str.lstrip() — strip leading whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/, "");
}

// ===========================================================================
// Module-private framework regex re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// curl / wget (HTTP clients) regexes (Python ~12159-12201).
// ===========================================================================

// curl -v prefix characters: '*' = metadata, '>' = request, '<' = response headers.
// The trailing bare '>' (empty separator after request headers) has no trailing
// space, so we match '>' or '*' followed by optional whitespace or end-of-line.
const _CURL_VERBOSE_META_RE: RegExp = /^[*>](\s|$)/;
// The response status line: "< HTTP/1.1 200 OK" or "< HTTP/2 404"
const _CURL_STATUS_RE: RegExp = /^<\s+HTTP\/[\d.]+\s+(\d{3})/;
// Response headers we care about (content-type, location, content-length).
const _CURL_USEFUL_HEADER_RE: RegExp =
  /^<\s+(content-type|location|content-length|www-authenticate|x-ratelimit):/i;
// curl progress bars emitted to stderr when not redirected.
const _CURL_PROGRESS_RE: RegExp =
  /^\s+%\s+Total|^\s+Dload\s+Upload\s|^\d{1,3}\s+\d+\s+\d+\s+\d+\s|^\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/;
// wget log lines: "--YYYY-MM-DD HH:MM:SS--" / "Resolving ..." / "Connecting ..."
const _WGET_NOISE_RE: RegExp =
  /^--\d{4}-\d{2}-\d{2}|^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} URL:|^(Resolving|Connecting to|Reusing|Sending|Saving to|HTTP request sent|Length:|Location:)/;
// wget response status line embedded in the verbose output, e.g. "HTTP/1.1 200 OK"
const _WGET_HTTP_STATUS_RE: RegExp = /^HTTP\/[\d.]+\s+(\d{3})/;
// wget "YYYY-MM-DD HH:MM:SS (N MB/s) - 'file' saved [N/N]" lines: keep these.
const _WGET_SAVED_RE: RegExp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(/;

// ===========================================================================
// CurlFilter
// ===========================================================================

export class CurlFilter extends Filter {
  override name = "curl";
  override binaries: ReadonlySet<string> = new Set(["curl", "wget"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const binary = argv.length > 0 ? _pathStemLower(argv[0]!) : "curl";
    // curl writes body to stdout and verbose/progress to stderr by default.
    // wget writes progress to stderr and body to stdout (or file).
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_meta = 0;
    let dropped_req_headers = 0;
    let dropped_resp_headers = 0;
    let dropped_progress = 0;

    if (binary === "wget") {
      for (const line of lines) {
        // Keep the "saved" completion line and HTTP status lines.
        if (_reMatch(_WGET_SAVED_RE, line) || _reMatch(_WGET_HTTP_STATUS_RE, line)) {
          kept.push(line);
          continue;
        }
        if (_reMatch(_WGET_NOISE_RE, line)) {
          dropped_meta += 1;
          continue;
        }
        kept.push(line);
      }
    } else {
      // curl
      for (const line of lines) {
        if (_reMatch(_CURL_PROGRESS_RE, line)) {
          dropped_progress += 1;
          continue;
        }
        if (_reMatch(_CURL_STATUS_RE, line)) {
          // Keep response status verbatim (strip leading "< ").
          kept.push(line.startsWith("< ") ? _strip(line.slice(2)) : line);
          continue;
        }
        if (_reMatch(_CURL_USEFUL_HEADER_RE, line)) {
          // Keep useful response headers (strip leading "< ").
          kept.push(line.startsWith("< ") ? _strip(line.slice(2)) : line);
          dropped_resp_headers += 0; // counted below
          continue;
        }
        if (line.startsWith("< ")) {
          // Other response headers: drop silently.
          dropped_resp_headers += 1;
          continue;
        }
        if (_reMatch(_CURL_VERBOSE_META_RE, line)) {
          if (line.startsWith(">")) {
            dropped_req_headers += 1;
          } else {
            dropped_meta += 1;
          }
          continue;
        }
        kept.push(line);
      }
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_meta, `dropped ${dropped_meta} connection-metadata lines`);
    _maybe_note(notes, dropped_req_headers, `dropped ${dropped_req_headers} request-header lines`);
    _maybe_note(notes, dropped_resp_headers, `dropped ${dropped_resp_headers} response-header lines`);
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// rsync regexes (Python ~12291-12302).
// ===========================================================================

// rsync per-file transfer lines:
// "     1,234 100%  123.45kB/s    0:00:00 (xfr#1, to-chk=99/100)"
const _RSYNC_FILE_PROGRESS_RE: RegExp = /^\s+[\d,]+\s+\d+%\s/;
// rsync summary lines we want to keep.
const _RSYNC_SUMMARY_RE: RegExp =
  /^(sent|received|total size|Number of files|Number of created|Number of deleted|Number of regular|speedup)/;
// rsync error / warning lines.
const _RSYNC_ERROR_RE: RegExp =
  /\b(error|ERROR|failed|cannot|permission denied|No such file|rsync error)\b/;

// ===========================================================================
// RsyncFilter
// ===========================================================================

export class RsyncFilter extends Filter {
  override name = "rsync";
  override binaries: ReadonlySet<string> = new Set(["rsync"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped_files = 0;

    for (const line of lines) {
      // Always keep errors/warnings.
      if (_reSearch(_RSYNC_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep summary statistics.
      if (_reMatch(_RSYNC_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Drop inline progress bars.
      if (_reMatch(_RSYNC_FILE_PROGRESS_RE, line)) {
        continue;
      }
      // Heuristic: rsync -av emits bare file paths (relative or absolute).
      // Lines that don't start with whitespace and look like paths (contain
      // "/" or are plain filenames) are per-file listing noise.
      const stripped = _strip(line);
      if (stripped !== "" && stripped.includes("/") && !stripped.startsWith("[")) {
        dropped_files += 1;
        continue;
      }
      // Keep everything else (blank lines, headers like "sending incremental…").
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_files, `collapsed ${dropped_files} per-file transfer lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// ffmpeg / ffprobe / ffplay regexes (Python ~24104-24153).
// ===========================================================================

// "ffmpeg version 6.0 Copyright …" / "ffprobe version 5.1.3 …"
const _FFMPEG_VERSION_RE: RegExp = /^ff(?:mpeg|probe|play)\s+version\s/i;
// Build-info noise lines that appear in the header block.
const _FFMPEG_BUILD_NOISE_RE: RegExp = /^\s+(?:built with\b|configuration:|lib(?:av|sw|post)\w+\s+\d)/;
// "  Metadata:" or "    Metadata:" — section-header line with no key-value.
const _FFMPEG_METADATA_SECTION_RE: RegExp = /^\s{2,}Metadata:\s*$/;
// Metadata key-value lines indented ≥4 spaces with the format "key  : value".
const _FFMPEG_METADATA_KV_RE: RegExp = /^\s{4,}(?!Stream\s*#)[\w][\w ]*\s*:\s+/;
// "Input #0, mov,mp4,..., from 'input.mp4':" / "Output #0, matroska, to 'output.mkv':"
const _FFMPEG_INPUT_OUTPUT_RE: RegExp = /^(?:Input|Output)\s+#\d+,/;
// "  Duration: 00:10:00.00, start: 0.000000, bitrate: 5000 kb/s"
const _FFMPEG_DURATION_RE: RegExp = /^\s{2,}Duration:\s/;
// "    Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080 …"
const _FFMPEG_STREAM_RE: RegExp = /^\s{4,}Stream\s+#\d+:\d+/;
// "Stream mapping:" section header.
const _FFMPEG_STREAM_MAPPING_RE: RegExp = /^Stream mapping:\s*$/;
// Real-time progress: "frame=  100 fps= 25 q=23.0 size=   512kB time=… bitrate=…"
const _FFMPEG_PROGRESS_RE: RegExp = /^\s*frame=\s*\d+\s+fps=/;
// Final encoding-statistics line: "video:373440kB audio:1559kB …"
const _FFMPEG_FINAL_STATS_RE: RegExp = /^\s*video:\d+kB\s+audio:\d+kB/;
// "Press [q] to quit, or [?] for help" — interactive UI hint.
const _FFMPEG_PRESS_Q_RE: RegExp = /^Press\s+\[q\]\s+to\s+quit/;

// ===========================================================================
// FfmpegFilter
// ===========================================================================

export class FfmpegFilter extends Filter {
  override name = "ffmpeg";
  override binaries: ReadonlySet<string> = new Set(["ffmpeg", "ffprobe", "ffplay"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    // ffmpeg/ffprobe write all diagnostics to stderr; stdout carries muxed
    // binary media when writing to a pipe. Use stderr as the primary text
    // stream and fall back to stdout only when stderr is empty.
    const primary = stderr.trim() !== "" ? stderr : stdout;
    const lines = primary.split("\n");

    const kept: string[] = [];
    let dropped_build = 0;
    let dropped_meta = 0;
    let dropped_progress = 0;
    let last_progress: string | null = null;
    let in_stream_mapping = false;

    for (const line of lines) {
      const s = _rstrip(line);

      // Always keep error / warning lines.
      const lower = s.toLowerCase();
      if (lower.includes("error") || lower.includes("warning")) {
        kept.push(s);
        in_stream_mapping = false;
        continue;
      }

      // Version header: "ffmpeg version 6.0 Copyright …"
      if (_reMatch(_FFMPEG_VERSION_RE, s)) {
        kept.push(s);
        in_stream_mapping = false;
        continue;
      }

      // Build-info block: "  built with …", "  configuration: …", "  libav… N"
      if (_reMatch(_FFMPEG_BUILD_NOISE_RE, s)) {
        dropped_build += 1;
        continue;
      }

      // Real-time progress: "frame=N fps=N q=… size=… time=… bitrate=…"
      if (_reMatch(_FFMPEG_PROGRESS_RE, s)) {
        dropped_progress += 1;
        last_progress = s;
        in_stream_mapping = false;
        continue;
      }

      // Final encoding stats: "video:NkB audio:NkB …"
      if (_reMatch(_FFMPEG_FINAL_STATS_RE, s)) {
        if (last_progress !== null) {
          kept.push(last_progress);
          last_progress = null;
          dropped_progress -= 1; // re-added; not collapsed
        }
        kept.push(s);
        in_stream_mapping = false;
        continue;
      }

      // "Press [q] to quit, or [?] for help" — interactivity hint.
      if (_reMatch(_FFMPEG_PRESS_Q_RE, s)) {
        dropped_meta += 1;
        in_stream_mapping = false;
        continue;
      }

      // "Stream mapping:" section header.
      if (_reMatch(_FFMPEG_STREAM_MAPPING_RE, s)) {
        kept.push(s);
        in_stream_mapping = true;
        continue;
      }

      // Stream mapping content: "  Stream #0:0 -> #0:0 (copy)"
      if (in_stream_mapping && _lstrip(s).startsWith("Stream #")) {
        kept.push(s);
        continue;
      }

      // "  Metadata:" or "    Metadata:" section header.
      if (_reMatch(_FFMPEG_METADATA_SECTION_RE, s)) {
        dropped_meta += 1;
        in_stream_mapping = false;
        continue;
      }

      // Metadata key-value: "    major_brand     : isom"
      if (_reMatch(_FFMPEG_METADATA_KV_RE, s)) {
        dropped_meta += 1;
        continue;
      }

      // "Input #0, mov,mp4,…, from 'file':" / "Output #0, matroska, to 'file':"
      if (_reMatch(_FFMPEG_INPUT_OUTPUT_RE, s)) {
        kept.push(s);
        in_stream_mapping = false;
        continue;
      }

      // "  Duration: HH:MM:SS.ss, start: …, bitrate: … kb/s"
      if (_reMatch(_FFMPEG_DURATION_RE, s)) {
        kept.push(s);
        continue;
      }

      // "    Stream #N:M(lang): Video/Audio/Subtitle: …"
      if (_reMatch(_FFMPEG_STREAM_RE, s)) {
        kept.push(s);
        in_stream_mapping = false;
        continue;
      }

      // Everything else: keep (unknown tool-specific messages, ffplay UI, etc.).
      kept.push(s);
      in_stream_mapping = false;
    }

    // If progress lines were suppressed but no final-stats line followed
    // (e.g. encoding was interrupted), surface the last progress frame.
    if (last_progress !== null) {
      kept.push(last_progress);
      dropped_progress -= 1; // re-added; not collapsed
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_build, `dropped ${dropped_build} build-info lines`);
    _maybe_note(notes, dropped_meta, `dropped ${dropped_meta} metadata lines`);
    _maybe_note(notes, dropped_progress, `collapsed ${dropped_progress} progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// dotenv regexes + helper (Python ~24546-24580).
// ===========================================================================

// python-dotenv / dotenv-cli diagnostics worth keeping verbatim — parse
// failures are actionable, not banner noise.
const _DOTENV_PARSE_WARN_RE: RegExp =
  /python-dotenv|could not parse|failed to parse|parse error/i;
// "Exported 23 variables" / "Loaded 23 variables" / "loaded 23 vars" count lines.
const _DOTENV_EXPORT_COUNT_RE: RegExp =
  /\b(?:Exported|Loaded|loaded)\s+(\d+)\s+var(?:iable)?s?\b/i;
// "Skipped 2 variables (already set)" — collapse but never add to the tally.
const _DOTENV_SKIPPED_RE: RegExp = /\bSkipped\s+\d+\s+var(?:iable)?s?\b/i;
// Count-less loading banners: "[dotenv] Loading .env", "Loading .env environment
// variables...", "Loaded variables from .env".
const _DOTENV_PLAIN_LOAD_RE: RegExp =
  /(?:^|\s)\[dotenv\]\s+Load|(?:Loading|Loaded)\b[^\n]*\.env|\.env environment variables/i;

/**
 * Python _is_dotenv_banner — return True for a collapsible dotenv loading /
 * exported / skipped banner.
 *
 * Diagnostic and error lines are never banners; they fall through to be kept
 * verbatim by the caller.
 */
export function _is_dotenv_banner(line: string): boolean {
  if (_reSearch(_DOTENV_PARSE_WARN_RE, line) || _reSearch(_ERROR_SIGNAL_RE, line)) {
    return false;
  }
  return Boolean(
    _reSearch(_DOTENV_EXPORT_COUNT_RE, line) ||
      _reSearch(_DOTENV_SKIPPED_RE, line) ||
      _reSearch(_DOTENV_PLAIN_LOAD_RE, line),
  );
}

// ===========================================================================
// DotenvFilter
// ===========================================================================

export class DotenvFilter extends Filter {
  override name = "dotenv";
  override binaries: ReadonlySet<string> = new Set(["dotenv"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const banner_idx = new Set<number>();
    for (let i = 0; i < lines.length; i += 1) {
      if (_is_dotenv_banner(lines[i]!)) {
        banner_idx.add(i);
      }
    }
    // Nothing to collapse: single-line / no-banner messages pass through.
    if (banner_idx.size < 2) {
      return Filter._finalize(lines);
    }
    const kept: string[] = [];
    let loaded_total = 0;
    let insert_pos: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (banner_idx.has(i)) {
        if (insert_pos === null) {
          insert_pos = kept.length;
        }
        const m = _reSearchObj(_DOTENV_EXPORT_COUNT_RE, line);
        if (m) {
          loaded_total += parseInt(m[1]!, 10);
        }
        continue;
      }
      kept.push(line);
    }
    const summary =
      loaded_total !== 0 ? `[dotenv] loaded ${loaded_total} vars` : "[dotenv] loaded .env";
    kept.splice(insert_pos !== null ? insert_pos : 0, 0, summary);
    return Filter._finalize(kept);
  }
}
