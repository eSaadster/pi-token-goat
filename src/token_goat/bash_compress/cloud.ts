/**
 * bash_compress CLOUD-CLI FILTERS — TypeScript port of the cloud-provider CLI
 * Filter subclasses from src/token_goat/bash_compress.py:
 *
 *   - AwsFilter        (Python ~line 5331) — the original AWS CLI filter:
 *                       top-level / nested JSON list truncation (first 20 + N
 *                       elided), kubectl-style table truncation, stderr append.
 *   - AwsCliFilter     (Python ~line 9101) — the enhanced AWS CLI filter: S3
 *                       transfer-line collapsing, describe/list array truncation
 *                       (first 3 + count), CloudFormation describe-stack-events
 *                       IN_PROGRESS deduplication.
 *   - GcloudFilter     (Python ~line 9343) — `gcloud` (Google Cloud SDK): braille
 *                       spinner dropping, API-enablement collapsing, large
 *                       structured-data block collapsing.
 *   - AzureCliFilter   (Python ~line 9439) — `az` (Azure CLI): preview-warning
 *                       collapsing, progress-JSON dedup (keep last), JSON array
 *                       truncation (first 3 + count, like AwsCliFilter).
 *
 * All four subclass the concrete Filter base from ./framework.js and override
 * _compress_body (error_passthrough = true, so the Filter.compress template
 * short-circuits raw error output before _compress_body runs).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase classes (AwsFilter,
 *    AwsCliFilter, GcloudFilter, AzureCliFilter), snake_case methods/fields
 *    (_compress_body, _compress_json_array, _compress_cfn_stack_events,
 *    _compress_s3_transfer, _compress_gcloud, _maybe_collapse_structured,
 *    _compress_az, _JSON_ARRAY_THRESHOLD, _JSON_ARRAY_KEEP,
 *    _STRUCTURED_LINE_THRESHOLD), the exported helper _try_compress_json_list,
 *    and the module-private regex constants (_AWS_*, _GCLOUD_*, _AZ_*).
 *  - re.compile(...) -> top-level RegExp compiled once. IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). re.search ->
 *    _reSearch (non-global clone, any index).
 *  - json.dumps(data, separators=(",", ":")) -> JSON.stringify(data) (compact,
 *    no spaces — JS default has no spaces either, matching Python's compact
 *    separators). json.dumps(data, indent=2) -> JSON.stringify(data, null, 2).
 *    Note: Python's indent=2 separators are (",", ": ") which match JS's
 *    2-space pretty-print exactly for the shapes produced here.
 *  - json.loads -> JSON.parse; ValueError/JSONDecodeError -> catch -> null.
 *    Python dict insertion order is preserved by JSON.parse for the string keys
 *    these filters mutate (AWS/Azure use non-integer-like keys; key order is
 *    observable only via the re-serialised output, which round-trips 1:1).
 *  - _compress_kubectl_table is a kubectl-module helper NOT yet ported to TS;
 *    AwsFilter needs it, so it is re-implemented MODULE-PRIVATE here (verbatim
 *    from Python lines ~4070-4080). It is NOT exported (the kubectl module owns
 *    the canonical export; duplicating an export across the barrel would be a
 *    TS2308 ambiguity).
 *  - Module-global mutable state: NONE. All per-call counters/dicts are locals.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  _maybe_note,
  _positional_args,
} from "./framework.js";

// ===========================================================================
// Internal Python re shims local to this module.
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

/** Python re.Pattern.search(line) — match anywhere in the string. */
function _reSearch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  return r.exec(line) !== null;
}

/**
 * Python str.rstrip() — strip trailing ASCII/Unicode whitespace. Mirrors the
 * framework's `_rstrip`; re-declared here to avoid importing a framework-private
 * (the framework does not export it). Matches Python's default whitespace set
 * for the outputs these filters handle.
 */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

// ===========================================================================
// AwsFilter — original AWS CLI filter (Python lines ~5331-5365) plus the
// module-level _try_compress_json_list helper (Python lines ~5368-5399).
// ===========================================================================

/**
 * Truncate a kubectl tabular output to header + first *max_rows* data rows.
 *
 * Re-implemented MODULE-PRIVATE here: the canonical helper lives in the (not yet
 * ported) kubectl filter module. Verbatim port of Python `_compress_kubectl_table`
 * (lines ~4070-4080). NOT exported — the kubectl module owns the export name.
 */
function _compress_kubectl_table(text: string, max_rows = 10): string {
  const lines = text.split("\n");
  // Skip empty lines at the end.
  const non_empty = lines.filter((ln) => ln.trim() !== "");
  if (non_empty.length <= max_rows + 1) {
    return text;
  }
  return (
    non_empty.slice(0, max_rows + 1).join("\n") +
    `\n[token-goat: ${non_empty.length - max_rows - 1} more rows; use --selector or -l to narrow]`
  );
}

/**
 * If *text* is a JSON document with a long top-level list, truncate it.
 *
 * Returns the compressed JSON string, or `null` when the text is not JSON or
 * when no compression was applied. Only the most common AWS list shapes are
 * detected: top-level array, or top-level object whose first list-valued key has
 * > 20 entries.
 *
 * Port of Python `_try_compress_json_list` (lines ~5368-5399). json.dumps with
 * compact separators (",", ":") -> JSON.stringify (no whitespace).
 */
export function _try_compress_json_list(text: string): string | null {
  const stripped = text.trim();
  if (!stripped || (stripped[0] !== "{" && stripped[0] !== "[")) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  let changed = false;
  if (Array.isArray(data) && data.length > 20) {
    const original = data.length;
    data = [
      ...data.slice(0, 20),
      { __token_goat__: `+${original - 20} items elided` },
    ];
    changed = true;
  } else if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (Array.isArray(value) && value.length > 20) {
        const original = value.length;
        obj[key] = [
          ...value.slice(0, 20),
          { __token_goat__: `+${original - 20} items elided` },
        ];
        changed = true;
      }
    }
  }
  if (!changed) {
    return null;
  }
  return JSON.stringify(data);
}

/**
 * Compress AWS CLI output (original filter).
 *
 * The AWS CLI's default `--output json` emits one giant JSON document.
 * Compression model: top-level / nested list truncation (keep first 20 + an
 * "[+N more items elided]" sentinel), kubectl-style table truncation for
 * `--output table`, and verbatim error passthrough.
 */
export class AwsFilter extends Filter {
  override error_passthrough = true;

  override name = "aws";
  override binaries: ReadonlySet<string> = new Set(["aws", "aws2"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    let text = stdout;
    // Try JSON compression first; fall back to table truncation.
    const compressed = _try_compress_json_list(text);
    if (compressed !== null) {
      text = compressed;
    } else if (text.includes("\n") && text.includes("|")) {
      text = _compress_kubectl_table(text, 25);
    }
    if (stderr.trim() !== "") {
      text =
        text.trim() !== ""
          ? _rstrip(text) + "\n---\n" + _rstrip(stderr)
          : stderr;
    }
    return text;
  }
}

// ===========================================================================
// AWS CLI (enhanced) regexes (Python lines ~9083-9098).
// ===========================================================================

// Matches AWS S3 upload lines: "upload: local/path to s3://bucket/key"
// Python: re.compile(r"^upload:\s+\S+\s+to\s+s3://", re.IGNORECASE)
const _AWS_UPLOAD_RE: RegExp = /^upload:\s+\S+\s+to\s+s3:\/\//i;
// Matches AWS S3 download lines: "download: s3://bucket/key to local/path"
// Python: re.compile(r"^download:\s+s3://", re.IGNORECASE)
const _AWS_DOWNLOAD_RE: RegExp = /^download:\s+s3:\/\//i;
// Matches AWS S3 progress/transfer-rate lines emitted during cp/sync.
// Python: re.compile(
//   r"^(?:Completed\s+\d|\d+(?:\.\d+)?\s*(?:KiB|MiB|GiB|B)/s|Calculating|"
//   r"upload\s+failed:|download\s+failed:)", re.IGNORECASE)
const _AWS_S3_PROGRESS_RE: RegExp =
  /^(?:Completed\s+\d|\d+(?:\.\d+)?\s*(?:KiB|MiB|GiB|B)\/s|Calculating|upload\s+failed:|download\s+failed:)/i;

// ===========================================================================
// AwsCliFilter — enhanced AWS CLI filter (Python lines ~9101-9317).
// ===========================================================================

/**
 * Enhanced AWS CLI filter with S3 transfer collapsing and describe/list array
 * truncation.
 *
 * Compression model:
 *  - JSON arrays > 10 items (describe-* / list-*): collapse to first 3 + a
 *    "N items (showing first 3)" sentinel.
 *  - S3 upload/download lines: collapse to a count summary.
 *  - S3 progress bars: drop; keep only the final transfer summary line.
 *  - CloudFormation describe-stack-events: collapse consecutive IN_PROGRESS
 *    events for the same logical resource. COMPLETE/FAILED/ROLLBACK kept.
 *  - Error messages: kept verbatim (error_passthrough).
 */
export class AwsCliFilter extends Filter {
  override error_passthrough = true;

  override name = "aws-cli";
  override binaries: ReadonlySet<string> = new Set(["aws", "aws2"]);

  // number of items to keep from a large JSON array
  static readonly _JSON_ARRAY_THRESHOLD = 10;
  static readonly _JSON_ARRAY_KEEP = 3;

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    argv: string[],
  ): string {
    const positionals = _positional_args(argv.slice(1));
    // S3 transfer subcommands get transfer-line collapsing.
    const is_s3_transfer =
      positionals.length >= 2 &&
      positionals[0] === "s3" &&
      (positionals[1] === "cp" || positionals[1] === "sync" || positionals[1] === "mv");
    // CloudFormation describe-stack-events — deduplicate IN_PROGRESS events.
    const is_cfn_events =
      positionals.length >= 2 &&
      positionals[0] === "cloudformation" &&
      positionals[1] === "describe-stack-events";

    let text = stdout;
    if (is_s3_transfer) {
      text = this._compress_s3_transfer(text);
    } else if (is_cfn_events) {
      const compressed = this._compress_cfn_stack_events(text);
      if (compressed !== null) {
        text = compressed;
      }
    } else {
      const compressed = this._compress_json_array(text);
      if (compressed !== null) {
        text = compressed;
      }
    }

    if (stderr.trim() !== "") {
      text =
        text.trim() !== ""
          ? _rstrip(text) + "\n---\n" + _rstrip(stderr)
          : stderr;
    }
    return text;
  }

  /**
   * Collapse top-level or nested JSON arrays > _JSON_ARRAY_THRESHOLD items.
   * Returns the compressed JSON string or `null` when no compression applied.
   */
  _compress_json_array(text: string): string | null {
    const stripped = text.trim();
    if (!stripped || (stripped[0] !== "{" && stripped[0] !== "[")) {
      return null;
    }
    let data: unknown;
    try {
      data = JSON.parse(stripped);
    } catch {
      return null;
    }

    const keep = AwsCliFilter._JSON_ARRAY_KEEP;
    const threshold = AwsCliFilter._JSON_ARRAY_THRESHOLD;
    let changed = false;

    if (Array.isArray(data) && data.length > threshold) {
      const total = data.length;
      data = [
        ...data.slice(0, keep),
        { __token_goat__: `${total} items (showing first ${keep})` },
      ];
      changed = true;
    } else if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (Array.isArray(value) && value.length > threshold) {
          const total = value.length;
          obj[key] = [
            ...value.slice(0, keep),
            { __token_goat__: `${total} items (showing first ${keep})` },
          ];
          changed = true;
        }
      }
    }
    if (!changed) {
      return null;
    }
    return JSON.stringify(data, null, 2);
  }

  /**
   * Deduplicate `aws cloudformation describe-stack-events` JSON output.
   *
   * Collapse consecutive IN_PROGRESS events for the same logical resource beyond
   * the first one. COMPLETE / FAILED / ROLLBACK_* / SKIPPED events are kept. A
   * __token_goat__ summary entry is inserted after each collapsed run. Returns
   * the compressed JSON string, or `null` on parse failure.
   */
  _compress_cfn_stack_events(text: string): string | null {
    const stripped = text.trim();
    if (!stripped || stripped[0] !== "{") {
      return null;
    }
    let data: unknown;
    try {
      data = JSON.parse(stripped);
    } catch {
      return null;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const obj = data as Record<string, unknown>;

    const events = obj["StackEvents"];
    if (!Array.isArray(events)) {
      return null;
    }
    if (events.length <= AwsCliFilter._JSON_ARRAY_THRESHOLD) {
      return null; // Short enough — use default path.
    }

    // Deduplicate: collapse consecutive IN_PROGRESS for the same resource.
    // Events are ordered newest-first in AWS output; process in that order.
    const kept_events: unknown[] = [];
    const in_progress_run = new Map<string, number>(); // resource_id -> count of consecutive IN_PROGRESS
    const last_resource_status = new Map<string, string>();

    for (const event of events) {
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        kept_events.push(event);
        continue;
      }
      const ev = event as Record<string, unknown>;
      const resource_id = String(ev["LogicalResourceId"] ?? "");
      const status = String(ev["ResourceStatus"] ?? "");
      const is_in_progress = status.endsWith("_IN_PROGRESS");

      if (is_in_progress) {
        const prev_status = last_resource_status.get(resource_id) ?? "";
        if (prev_status.endsWith("_IN_PROGRESS") && prev_status === status) {
          // Consecutive IN_PROGRESS for the same resource — collapse.
          in_progress_run.set(resource_id, (in_progress_run.get(resource_id) ?? 0) + 1);
          continue;
        } else {
          // First IN_PROGRESS for this resource in this run — keep.
          // Flush any previous collapse count for this resource.
          const prev_count = in_progress_run.get(resource_id) ?? 0;
          in_progress_run.delete(resource_id);
          if (prev_count) {
            kept_events.push({
              __token_goat__:
                `${prev_count} repeated ${prev_status} event(s) ` +
                `for ${resource_id} collapsed`,
            });
          }
          kept_events.push(event);
        }
      } else {
        // Terminal or other status — flush any pending collapse.
        const prev_count = in_progress_run.get(resource_id) ?? 0;
        in_progress_run.delete(resource_id);
        if (prev_count) {
          const prev_status = last_resource_status.get(resource_id) ?? "IN_PROGRESS";
          kept_events.push({
            __token_goat__:
              `${prev_count} repeated ${prev_status} event(s) ` +
              `for ${resource_id} collapsed`,
          });
        }
        kept_events.push(event);
      }

      last_resource_status.set(resource_id, status);
    }

    // Flush any remaining in-progress runs at end of list.
    for (const [resource_id, count] of in_progress_run.entries()) {
      if (count) {
        const prev_status = last_resource_status.get(resource_id) ?? "IN_PROGRESS";
        kept_events.push({
          __token_goat__:
            `${count} repeated ${prev_status} event(s) ` +
            `for ${resource_id} collapsed`,
        });
      }
    }

    obj["StackEvents"] = kept_events;
    return JSON.stringify(obj, null, 2);
  }

  /** Collapse S3 upload/download lines and progress bars to count summaries. */
  _compress_s3_transfer(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let upload_count = 0;
    let download_count = 0;
    let progress_dropped = 0;

    for (const line of lines) {
      if (_reMatch(_AWS_UPLOAD_RE, line)) {
        upload_count += 1;
        continue;
      }
      if (_reMatch(_AWS_DOWNLOAD_RE, line)) {
        download_count += 1;
        continue;
      }
      if (_reMatch(_AWS_S3_PROGRESS_RE, line)) {
        progress_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, upload_count, `uploaded ${upload_count} file(s)`);
    _maybe_note(notes, download_count, `downloaded ${download_count} file(s)`);
    _maybe_note(notes, progress_dropped, `dropped ${progress_dropped} progress line(s)`);
    AwsCliFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Google Cloud SDK regexes (Python lines ~9322-9340).
// ===========================================================================

// gcloud progress spinner characters (braille spinner).
// Python: re.compile(r"^[⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s")
const _GCLOUD_SPINNER_RE: RegExp = /^[⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/;
// gcloud "Updated/Created/Deleted [URL]" status lines — always keep.
// Python: re.compile(r"^(?:Updated|Created|Deleted)\s+\[https?://", re.IGNORECASE)
const _GCLOUD_STATUS_RE: RegExp = /^(?:Updated|Created|Deleted)\s+\[https?:\/\//i;
// gcloud API enablement verbose lines.
// Python: re.compile(
//   r"^(?:Enabling service|Waiting for async operation|Operation \[operation-)",
//   re.IGNORECASE)
const _GCLOUD_API_ENABLE_RE: RegExp =
  /^(?:Enabling service|Waiting for async operation|Operation \[operation-)/i;
// gcloud "Do you want to continue" prompt — keep.
// Python: re.compile(r"Do you want to continue", re.IGNORECASE)
const _GCLOUD_CONTINUE_RE: RegExp = /Do you want to continue/i;

// ===========================================================================
// GcloudFilter — gcloud (Google Cloud SDK) (Python lines ~9343-9417).
// ===========================================================================

/**
 * Compress `gcloud` (Google Cloud SDK) output.
 *
 * Compression model:
 *  - Spinner lines (braille prefix): dropped entirely.
 *  - "Updated/Created/Deleted [url]": kept verbatim (actionable signal).
 *  - "Do you want to continue (Y/n)?": kept verbatim.
 *  - API enablement verbose lines: collapsed to count.
 *  - Large JSON/YAML resource descriptions (> 20 lines of structured data):
 *    collapsed to a "[Resource description: N lines ...]" placeholder.
 *  - Errors (non-zero exit code): kept verbatim (error_passthrough).
 */
export class GcloudFilter extends Filter {
  override error_passthrough = true;

  override name = "gcloud";
  override binaries: ReadonlySet<string> = new Set(["gcloud"]);

  static readonly _STRUCTURED_LINE_THRESHOLD = 20;

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    let text = this._compress_gcloud(stdout);
    if (stderr.trim() !== "") {
      text =
        text.trim() !== ""
          ? _rstrip(text) + "\n---\n" + _rstrip(stderr)
          : stderr;
    }
    return text;
  }

  _compress_gcloud(text: string): string {
    const lines = text.split("\n");
    let kept: string[] = [];
    let spinners_dropped = 0;
    let api_enable_dropped = 0;

    for (const line of lines) {
      // Drop braille spinner progress lines.
      if (_reMatch(_GCLOUD_SPINNER_RE, line)) {
        spinners_dropped += 1;
        continue;
      }
      // Collapse API enablement verbose lines.
      if (_reMatch(_GCLOUD_API_ENABLE_RE, line)) {
        api_enable_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    // Check if the kept output is a large structured-data block.
    kept = this._maybe_collapse_structured(kept);

    const notes: string[] = [];
    _maybe_note(notes, spinners_dropped, `dropped ${spinners_dropped} spinner line(s)`);
    _maybe_note(notes, api_enable_dropped, `collapsed ${api_enable_dropped} API enablement line(s)`);
    GcloudFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** If the output looks like a large structured data block, collapse it. */
  _maybe_collapse_structured(lines: string[]): string[] {
    const non_empty = lines.filter((ln) => ln.trim() !== "");
    if (non_empty.length <= GcloudFilter._STRUCTURED_LINE_THRESHOLD) {
      return lines;
    }
    // Heuristic: structured data lines contain ":", "{", "}", "[", "]", "-"
    // at high density with no obvious prose patterns.
    const structured_chars = new Set([":", "{", "[", "]", "-"]);
    let structured_count = 0;
    for (const ln of non_empty) {
      const has_struct = [...ln].some((ch) => structured_chars.has(ch));
      if (
        has_struct &&
        !_reMatch(_GCLOUD_STATUS_RE, ln) &&
        !_reSearch(_GCLOUD_CONTINUE_RE, ln)
      ) {
        structured_count += 1;
      }
    }
    const ratio = non_empty.length ? structured_count / non_empty.length : 0.0;
    if (ratio >= 0.7) {
      return [
        `[Resource description: ${non_empty.length} lines ` +
          `(use --format=json to see full output)]`,
      ];
    }
    return lines;
  }
}

// ===========================================================================
// Azure CLI regexes (Python lines ~9422-9436).
// ===========================================================================

// Azure CLI "Command group ... is in preview" warning.
// Python: re.compile(
//   r"^(?:Command group|The command|This command).*\bis in preview",
//   re.IGNORECASE)
const _AZ_PREVIEW_RE: RegExp =
  /^(?:Command group|The command|This command).*\bis in preview/i;
// Azure CLI "Resource provider ... is not registered" — actionable, keep.
// Python: re.compile(r"Resource provider .* is not registered", re.IGNORECASE)
const _AZ_PROVIDER_RE: RegExp = /Resource provider .* is not registered/i;
// Azure CLI long-running operation progress JSON blobs.
// e.g. {"status": "Running", "percentComplete": 50.0}
// Python: re.compile(
//   r'^\s*\{[^}]*"(?:status|percentComplete|provisioningState)"[^}]*\}\s*$')
const _AZ_PROGRESS_JSON_RE: RegExp =
  /^\s*\{[^}]*"(?:status|percentComplete|provisioningState)"[^}]*\}\s*$/;

// ===========================================================================
// AzureCliFilter — az (Azure CLI) (Python lines ~9439-9539).
// ===========================================================================

/**
 * Compress `az` (Azure CLI) output.
 *
 * Compression model:
 *  - Progress JSON blobs ({"status": "Running", ...}): collapsed to the final
 *    status only.
 *  - "Command group ... is in preview" warnings: collapsed to a count.
 *  - "Resource provider ... is not registered": kept verbatim (actionable).
 *  - JSON arrays > 10 items: collapsed to first 3 + count, like AwsCliFilter.
 *  - Error messages (non-zero exit code): kept verbatim (error_passthrough).
 */
export class AzureCliFilter extends Filter {
  override error_passthrough = true;

  override name = "azure-cli";
  override binaries: ReadonlySet<string> = new Set(["az"]);

  static readonly _JSON_ARRAY_THRESHOLD = 10;
  static readonly _JSON_ARRAY_KEEP = 3;

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    let text = this._compress_az(stdout);
    if (stderr.trim() !== "") {
      text =
        text.trim() !== ""
          ? _rstrip(text) + "\n---\n" + _rstrip(stderr)
          : stderr;
    }
    return text;
  }

  _compress_az(text: string): string {
    // Try JSON array compression first (whole document).
    const compressed = this._compress_json_array(text);
    if (compressed !== null) {
      return compressed;
    }

    const lines = text.split("\n");
    const kept: string[] = [];
    let preview_dropped = 0;
    let last_progress_status: string | null = null;
    let in_progress_run = false;

    for (const line of lines) {
      // Collapse "is in preview" warnings.
      if (_reMatch(_AZ_PREVIEW_RE, line)) {
        preview_dropped += 1;
        continue;
      }
      // Collapse intermediate progress JSON blobs; keep the last one.
      if (_reMatch(_AZ_PROGRESS_JSON_RE, line)) {
        last_progress_status = line.trim();
        in_progress_run = true;
        continue;
      }
      // When we leave a progress-json run, emit the last status.
      if (in_progress_run) {
        if (last_progress_status) {
          kept.push(last_progress_status);
        }
        in_progress_run = false;
        last_progress_status = null;
      }
      kept.push(line);
    }

    // Flush any trailing progress run.
    if (in_progress_run && last_progress_status) {
      kept.push(last_progress_status);
    }

    const notes: string[] = [];
    _maybe_note(notes, preview_dropped, `collapsed ${preview_dropped} preview warning(s)`);
    AzureCliFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Collapse top-level or nested JSON arrays > _JSON_ARRAY_THRESHOLD items. */
  _compress_json_array(text: string): string | null {
    const stripped = text.trim();
    if (!stripped || (stripped[0] !== "{" && stripped[0] !== "[")) {
      return null;
    }
    let data: unknown;
    try {
      data = JSON.parse(stripped);
    } catch {
      return null;
    }

    const keep = AzureCliFilter._JSON_ARRAY_KEEP;
    const threshold = AzureCliFilter._JSON_ARRAY_THRESHOLD;
    let changed = false;

    if (Array.isArray(data) && data.length > threshold) {
      const total = data.length;
      data = [
        ...data.slice(0, keep),
        { __token_goat__: `${total} items (showing first ${keep})` },
      ];
      changed = true;
    } else if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (Array.isArray(value) && value.length > threshold) {
          const total = value.length;
          obj[key] = [
            ...value.slice(0, keep),
            { __token_goat__: `${total} items (showing first ${keep})` },
          ];
          changed = true;
        }
      }
    }
    if (!changed) {
      return null;
    }
    return JSON.stringify(data, null, 2);
  }
}

// Re-exports for the Python __all__ surface / test imports. These regex
// constants are module-private in Python (leading underscore); they are
// re-exported here (as in go.ts) so a later barrel phase and any white-box test
// can reference them by their exact Python name. The names are unique across the
// barrel export* chain (no framework helper shares them), so no TS2308 ambiguity
// arises — unlike framework-PRIVATE helpers (e.g. _ERROR_SIGNAL_RE) which must
// stay unexported. `_AZ_PROVIDER_RE` is a 1:1 port of the Python constant even
// though the Python filter never references it directly (the "not registered"
// line survives via the generic keep path); exported for parity.
export {
  _AWS_UPLOAD_RE,
  _AWS_DOWNLOAD_RE,
  _AWS_S3_PROGRESS_RE,
  _GCLOUD_SPINNER_RE,
  _GCLOUD_STATUS_RE,
  _GCLOUD_API_ENABLE_RE,
  _GCLOUD_CONTINUE_RE,
  _AZ_PREVIEW_RE,
  _AZ_PROVIDER_RE,
  _AZ_PROGRESS_JSON_RE,
};
