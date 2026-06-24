/**
 * bash_compress CONTAINER / ORCHESTRATION FILTERS — TypeScript port of the
 * container & Kubernetes Filter subclasses from src/token_goat/bash_compress.py
 * (Python lines ~3828-4763): the docker/docker-compose/kubectl/helm/kubectl-logs
 * family plus the module-level regexes and per-tool compression helpers they use.
 *
 * Five filters subclass the concrete Filter base from ./framework.js:
 *   - DockerFilter         — `docker build` / `run` / `push` / `pull` (BuildKit
 *                            digest/progress/CACHED/body drop, old-format
 *                            enhancement pass). Overrides compress() directly.
 *   - KubectlFilter        — generic `kubectl` / `k9s` / `oc` (get/top table,
 *                            describe, logs, diff). error_passthrough = true.
 *   - DockerComposeFilter  — `docker-compose` / `docker compose` (pulling/health
 *                            collapse, per-service streaming dedup). matches()
 *                            override; error_passthrough = true.
 *   - HelmFilter           — `helm` (install/upgrade boilerplate, list cap,
 *                            template document-header extraction).
 *   - KubectlLogsFilter    — high-volume `kubectl logs` (access-log / stack-trace
 *                            / JSON-blob / pod-prefix dedup + hard head/tail cap).
 *                            matches() override; error_passthrough = true.
 *
 * KubectlLogsFilter is registered BEFORE the generic KubectlFilter (it claims
 * only `kubectl logs` / `k logs` via its own matches()); the registry ordering
 * is wired by the barrel one level up (out of scope here) — this module only
 * ports the per-class matches() / detection logic verbatim.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: PascalCase class names, snake_case
 *    methods/fields (matches, _compress_body, _strip_pod_prefix, _POD_PREFIX_RE),
 *    snake_case module helpers (_compress_kubectl_table, _compress_kubectl_events,
 *    _compress_kubectl_describe, _compress_helm_install, _compress_helm_list,
 *    _compress_helm_template, _strip_timestamp, _dedup_log_lines,
 *    _dedup_log_lines_with_pod_prefix, _collapse_stack_traces,
 *    _collapse_access_logs, _collapse_json_blobs, _json_blob_summary), and the
 *    module-private regex constants (_DOCKER_*, _DC_*, _HELM_*, _KUBE_*,
 *    _KUBECTL_POD_PREFIX_RE).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i"; verbose (re.X) of _KUBE_ACCESS_LOG_RE is inlined (whitespace removed)
 *    so the source matches byte-for-byte.
 *  - Python re.Pattern.match(line) is anchored at the START (not end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). .search() -> _reSearch
 *    / _reSearchObj (non-global clone, .exec anywhere). Named/numbered capture
 *    groups are read off the RegExpExecArray.
 *  - Path(argv[0]).stem.lower() / .name.lower() -> local _pathStemLower /
 *    _pathNameLower (final path component after normalising backslashes, last
 *    extension stripped for stem, lowercased) — matching framework _pathStem/Name.
 *  - _positional_args / _head_tail_compress / _TIMESTAMP_PREFIX_RE are framework
 *    helpers. _positional_args and _head_tail_compress are framework-PUBLIC and
 *    imported from ./framework.js. _TIMESTAMP_PREFIX_RE and _ERROR_SIGNAL_RE are
 *    framework-PRIVATE (not exported there); they are re-declared MODULE-PRIVATE
 *    here (NOT exported) to avoid a duplicate-export ambiguity across the barrel.
 *  - _json_blob_summary uses Python's json.loads / repr() of the value. JSON.parse
 *    reproduces loads; the !r repr of message/level/etc. is reproduced via
 *    _pyRepr (str -> single-quoted with escaping; non-str -> JSON-ish). Reported
 *    in parity_notes.
 *  - Module-global mutable state: NONE. Every per-call counter/dict/list is a
 *    local inside compress()/_compress_body() or a helper; no registerReset seam
 *    is needed.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  _head_tail_compress,
  _positional_args,
} from "./framework.js";

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
 * helpers that read capture groups. Non-global clone so lastIndex never leaks.
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

/** Python Path(p).name.lower() — final path component (after backslash norm), lowercased. */
function _pathNameLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  return name.toLowerCase();
}

/** Python str.rstrip() — strip trailing ASCII+Unicode whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python str.split() with no separator — split on runs of whitespace, no empties. */
function _splitWhitespace(s: string): string[] {
  return s.split(/\s+/u).filter((tok) => tok !== "");
}

/**
 * Python repr() for the JSON-decoded scalar values _json_blob_summary embeds via
 * the {!r} conversion. A str renders single-quoted with Python escape rules; a
 * bool renders True/False; None renders None; numbers render plainly.
 */
function _pyRepr(val: unknown): string {
  if (typeof val === "string") {
    // Python prefers single quotes; switches to double only when the string
    // contains a single quote but no double quote. Escape backslash and the
    // chosen quote.
    const hasSingle = val.includes("'");
    const hasDouble = val.includes('"');
    const quote = hasSingle && !hasDouble ? '"' : "'";
    let body = val.replace(/\\/g, "\\\\");
    if (quote === "'") {
      body = body.replace(/'/g, "\\'");
    } else {
      body = body.replace(/"/g, '\\"');
    }
    body = body
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `${quote}${body}${quote}`;
  }
  if (val === true) {
    return "True";
  }
  if (val === false) {
    return "False";
  }
  if (val === null) {
    return "None";
  }
  return String(val);
}

// ===========================================================================
// Framework-private regexes re-declared MODULE-PRIVATE (NOT exported — a
// duplicate export across the barrel's export* chain would be a TS2308
// ambiguity). These mirror the framework's own private definitions verbatim.
// ===========================================================================

// Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback
//   |exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// Python: re.compile(r"^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*"
//                     r"|^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+")
const _TIMESTAMP_PREFIX_RE: RegExp =
  /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*|^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/;

// ===========================================================================
// Docker regexes (Python lines ~3830-3865).
// ===========================================================================

// Python: re.compile(r"^\s*#\d+\s+(sha256:[a-f0-9]{8,}|resolve\s)")
const _DOCKER_DIGEST_RE: RegExp = /^\s*#\d+\s+(sha256:[a-f0-9]{8,}|resolve\s)/;
// Python: re.compile(r"^\s*#\d+\s+\d+(?:\.\d+)?(?:MB|kB|GB)\s+/")
const _DOCKER_PROGRESS_RE: RegExp = /^\s*#\d+\s+\d+(?:\.\d+)?(?:MB|kB|GB)\s+\//;
// Python: re.compile(r"^\s*=>\s|^\s*#\d+\s+\[(internal|build|stage)")
const _DOCKER_STEP_RE: RegExp = /^\s*=>\s|^\s*#\d+\s+\[(internal|build|stage)/;
// Python: re.compile(r"^\s*#\d+\s+\d+(\.\d+)?\s+")
const _DOCKER_STEP_BODY_RE: RegExp = /^\s*#\d+\s+\d+(\.\d+)?\s+/;
// Python: re.compile(r"^\s*#\d+\s+CACHED\s*$")
const _DOCKER_CACHED_RE: RegExp = /^\s*#\d+\s+CACHED\s*$/;
// Python: re.compile(r"^\s*(?:\S+:\s+)?(?:Layer already exists|Mounted from \S+|Pushing\s+\S+:\s+\d)", re.IGNORECASE)
const _DOCKER_PUSH_NOISE_RE: RegExp =
  /^\s*(?:\S+:\s+)?(?:Layer already exists|Mounted from \S+|Pushing\s+\S+:\s+\d)/i;
// Python: re.compile(r"^\s*[a-f0-9]{12}:\s+(?:Pull complete|Verifying Checksum|Download complete|Already exists|Waiting|Pulling fs layer)", re.IGNORECASE)
const _DOCKER_PULL_LAYER_RE: RegExp =
  /^\s*[a-f0-9]{12}:\s+(?:Pull complete|Verifying Checksum|Download complete|Already exists|Waiting|Pulling fs layer)/i;
// Old-format (non-BuildKit) docker build enhancement-pass patterns.
// Python: re.compile(r"^ *---> Using cache\s*$")
const _DOCKER_OLD_CACHE_RE: RegExp = /^ *---> Using cache\s*$/;
// Python: re.compile(r"^ *---> sha256:[0-9a-f]{12,}\s*$")
const _DOCKER_OLD_SHA_RE: RegExp = /^ *---> sha256:[0-9a-f]{12,}\s*$/;
// Python: re.compile(r"^Step \d+/\d+ : ")
const _DOCKER_OLD_STEP_RE: RegExp = /^Step \d+\/\d+ : /;
// Python: re.compile(r"^Successfully built [0-9a-f]+")
const _DOCKER_OLD_SUCCESS_RE: RegExp = /^Successfully built [0-9a-f]+/;
// Python: re.compile(r"^Removing intermediate container [0-9a-f]+")
const _DOCKER_OLD_INTERMEDIATE_RE: RegExp = /^Removing intermediate container [0-9a-f]+/;

// ===========================================================================
// DockerFilter (Python lines ~3868-3998).
// ===========================================================================

/**
 * Compress `docker build` / `docker run` / `docker push` output.
 *
 * BuildKit emits one block per step (`#N [internal] load context`,
 * `#N transferring` ...). When successful most blocks are uninteresting; only
 * `=> ERROR` blocks matter.
 *
 * Compression model:
 *   - Drop sha256 digest lines (`#3 sha256:...`).
 *   - Drop layer-transfer progress (`#5 12.3MB / 50.0MB 0.5s`).
 *   - Drop internal step bodies (timestamp + line of build output) when the step
 *     succeeded, keep only the step header and the trailing `DONE`.
 *   - Keep every step containing `ERROR` or `FAILED`.
 *   - Keep the final `ERROR: failed to solve:` block.
 *   - Keep the final `Successfully built ...` / `writing image sha256:...` line.
 */
export class DockerFilter extends Filter {
  override name = "docker";
  override binaries: ReadonlySet<string> = new Set([
    "docker",
    "buildah",
    "podman",
    "nerdctl",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    // Docker writes progress / errors to stderr; only bodies to stdout.
    // Note: reversed order (stderr first) — we swap the arguments.
    const merged = this._combine_output(stderr, stdout);
    const lines = merged.split("\n");
    let kept: string[] = [];
    let dropped_digest = 0;
    let dropped_progress = 0;
    let dropped_body = 0;
    let dropped_cached = 0;
    let dropped_push_noise = 0;
    let dropped_pull_layers = 0;
    for (const line of lines) {
      if (_reMatch(_DOCKER_DIGEST_RE, line)) {
        dropped_digest += 1;
        continue;
      }
      if (_reMatch(_DOCKER_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      // BuildKit CACHED lines: `#5 CACHED` — layer reused from cache.
      // Dozens of these appear on warm builds with no new information.
      if (_reMatch(_DOCKER_CACHED_RE, line)) {
        dropped_cached += 1;
        continue;
      }
      // docker push: "Layer already exists" / "Mounted from" / "Pushing NNN"
      if (_reMatch(_DOCKER_PUSH_NOISE_RE, line)) {
        dropped_push_noise += 1;
        continue;
      }
      // docker pull per-layer status lines (Pull complete, Waiting, etc.)
      if (_reMatch(_DOCKER_PULL_LAYER_RE, line)) {
        dropped_pull_layers += 1;
        continue;
      }
      // When the step succeeded, drop its body (the prefixed timestamps).
      if (
        _reMatch(_DOCKER_STEP_BODY_RE, line) &&
        !_reMatch(_DOCKER_STEP_RE, line) &&
        !line.includes("ERROR") &&
        !line.toUpperCase().includes("WARN")
      ) {
        dropped_body += 1;
        continue;
      }
      kept.push(line);
    }
    // Enhancement passes for old-format (non-BuildKit) docker build output
    if (lines.some((_l) => _reMatch(_DOCKER_OLD_STEP_RE, _l))) {
      const _old_step_count = lines.filter((_l) => _reMatch(_DOCKER_OLD_STEP_RE, _l)).length;
      const _old_cache_count = lines.filter((_l) => _reMatch(_DOCKER_OLD_CACHE_RE, _l)).length;
      const _old_new: string[] = [];
      let _old_step_hdr: string | null = null;
      let _old_step_err = false;
      for (const _ol of kept) {
        if (_reMatch(_DOCKER_OLD_SUCCESS_RE, _ol)) {
          if (_old_step_hdr !== null && !_old_step_err) {
            // dropped step
          } else if (_old_step_hdr !== null) {
            _old_new.push(_old_step_hdr);
          }
          _old_step_hdr = null;
          _old_new.push(_ol);
          continue;
        }
        if (_reMatch(_DOCKER_OLD_CACHE_RE, _ol)) {
          continue;
        }
        if (_reMatch(_DOCKER_OLD_SHA_RE, _ol)) {
          continue;
        }
        if (_reMatch(_DOCKER_OLD_INTERMEDIATE_RE, _ol)) {
          continue;
        }
        if (_reMatch(_DOCKER_OLD_STEP_RE, _ol)) {
          if (_old_step_hdr !== null) {
            if (_old_step_err) {
              _old_new.push(_old_step_hdr);
            }
            // else: dropped step
          }
          _old_step_hdr = _ol;
          _old_step_err = false;
          continue;
        }
        if (_ol.toLowerCase().includes("error")) {
          _old_step_err = true;
        }
        _old_new.push(_ol);
      }
      if (_old_step_hdr !== null) {
        if (_old_step_err) {
          _old_new.push(_old_step_hdr);
        }
        // else: dropped step
      }
      if (_old_cache_count > 0) {
        _old_new.unshift(`[building ${_old_step_count} layers, ${_old_cache_count} cached]`);
      }
      kept = _old_new;
    }
    const parts: string[] = [];
    if (dropped_digest) {
      parts.push(`${dropped_digest} digest`);
    }
    if (dropped_progress) {
      parts.push(`${dropped_progress} transfer`);
    }
    if (dropped_body) {
      parts.push(`${dropped_body} body`);
    }
    if (dropped_cached) {
      parts.push(`${dropped_cached} CACHED`);
    }
    if (dropped_push_noise) {
      parts.push(`${dropped_push_noise} push-layer`);
    }
    if (dropped_pull_layers) {
      parts.push(`${dropped_pull_layers} pull-layer`);
    }
    if (parts.length > 0) {
      kept.push(`[token-goat: dropped ${parts.join(", ")} lines]`);
    }
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// KubectlFilter (Python lines ~4003-4067) + kubectl helpers (~4070-4196).
// ===========================================================================

/**
 * Compress `kubectl`, `k9s`, `oc`, and `helm` output.
 *
 * `kubectl get` returns tabular output (NAME, READY, STATUS, RESTARTS, AGE); on a
 * large cluster this is thousands of lines. Truncate to header + first 10 data
 * rows + tail summary.
 *
 * `kubectl describe` extracts key metadata (Name, Namespace, Status) and the
 * Events section (last 10 lines).
 *
 * `kubectl apply` / `create` / `delete` are typically short; pass through with
 * stderr appended if present.
 *
 * `kubectl logs` emits high-volume streaming text; use head+tail compression
 * (head=30, tail=20).
 *
 * `kubectl exec` is interactive; pass through.
 *
 * `kubectl diff` can produce large diffs; truncate to first 50 lines.
 *
 * Errors (exit_code != 0) preserve all stderr unchanged.
 */
export class KubectlFilter extends Filter {
  override error_passthrough = true;

  override name = "kubectl";
  override binaries: ReadonlySet<string> = new Set(["kubectl", "k", "k9s", "oc"]);

  override _compress_body(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    let text = stdout;

    if (subcommand === "get" || subcommand === "top") {
      if (text.includes("\n")) {
        const resource = positionals.length > 1 ? positionals[1]! : "";
        if (resource === "events" || resource === "ev" || resource === "event") {
          text = _compress_kubectl_events(text);
        } else {
          text = _compress_kubectl_table(text, 10);
        }
      }
    } else if (subcommand === "describe") {
      if (text.includes("\n")) {
        text = _compress_kubectl_describe(text);
      }
    } else if (subcommand === "apply" || subcommand === "create" || subcommand === "delete") {
      // These are typically short; pass through
    } else if (subcommand === "logs") {
      if (text.includes("\n")) {
        const non_empty = text.split("\n").filter((ln) => ln.trim() !== "");
        if (non_empty.length > 50) {
          text = _head_tail_compress(non_empty, 30, 20, "log lines");
        } else {
          text = non_empty.join("\n");
        }
      }
    } else if (subcommand === "exec") {
      // Interactive; pass through
    } else if (subcommand === "diff") {
      const lines = text.split("\n");
      if (lines.length > 50) {
        text = _head_tail_compress(lines, 50, 0, "diff lines");
      }
    }

    if (stderr.trim() !== "") {
      text = text.trim() !== "" ? `${_rstrip(text)}\n---\n${_rstrip(stderr)}` : stderr;
    }
    return text;
  }
}

/** Truncate a kubectl tabular output to header + first *max_rows* data rows. */
function _compress_kubectl_table(text: string, max_rows = 10): string {
  const lines = text.split("\n");
  // Skip empty lines at the end
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
 * Collapse `kubectl get events` output by grouping on REASON.
 *
 * Keeps the most recent *_MAX_PER_REASON* rows per unique REASON value and emits a
 * count for elided older rows. Falls back to the generic table compressor when the
 * header does not look like an events table.
 */
function _compress_kubectl_events(text: string): string {
  const _MAX_PER_REASON = 3;
  const lines = text.split("\n");
  const non_empty = lines.filter((ln) => ln.trim() !== "");
  if (non_empty.length <= 5) {
    return text;
  }
  const header = non_empty[0]!;
  if (!header.toUpperCase().includes("REASON")) {
    return _compress_kubectl_table(text, 10);
  }
  const reason_idx = header.toUpperCase().indexOf("REASON");
  const groups = new Map<string, string[]>();
  for (const row of non_empty.slice(1)) {
    let reason: string;
    if (row.length > reason_idx) {
      const tail = row.slice(reason_idx);
      const toks = _splitWhitespace(tail);
      reason = toks.length > 0 ? toks[0]! : "Unknown";
    } else {
      reason = "Unknown";
    }
    if (!groups.has(reason)) {
      groups.set(reason, []);
    }
    groups.get(reason)!.push(row);
  }
  const kept: string[] = [header];
  let total_elided = 0;
  for (const [reason, rows] of groups) {
    if (rows.length <= _MAX_PER_REASON) {
      kept.push(...rows);
    } else {
      const elided = rows.length - _MAX_PER_REASON;
      total_elided += elided;
      kept.push(...rows.slice(rows.length - _MAX_PER_REASON));
      kept.push(`  [token-goat: ${elided} earlier '${reason}' events elided]`);
    }
  }
  if (total_elided) {
    kept.push(`[token-goat: ${total_elided} events collapsed; use --field-selector to filter]`);
  }
  return kept.join("\n");
}

// Key single-line describe fields always kept.
const _KEY_PREFIXES: readonly string[] = [
  "Name:", "Namespace:", "Status:", "State:", "Node:", "IP:", "PodIP:",
  "NodeIP:", "QoS Class:", "Priority:", "Image:", "Ready:", "Restart Count:",
  "Started:", "Finished:", "Exit Code:", "Reason:", "Message:",
  "Replicas:", "StrategyType:", "Selector:", "Type:", "ClusterIP:",
  "Limits:", "Requests:", "cpu:", "memory:",
];

/**
 * Extract key metadata from `kubectl describe` output.
 *
 *   - Labels / Annotations: collapsed to header + 3 entries to avoid walls of
 *     SHA hashes that dominate real describe output.
 *   - Conditions: kept in full — compact, high-signal table.
 *   - Container fields: Image, State, Ready, Restart Count, Limits/Requests,
 *     Exit Code, Started, Finished are now included.
 *   - Events: last 10 lines; earlier entries elided with a count.
 */
function _compress_kubectl_describe(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const stripped = line.trim();
    if (stripped === "") {
      i += 1;
      continue;
    }
    const label_key = stripped.includes(":") ? stripped.split(":")[0]! : "";
    // Collapse Labels / Annotations: keep header + first 3 indented entries
    if (label_key === "Labels" || label_key === "Annotations") {
      kept.push(line);
      const header_indent = line.length - line.replace(/^\s+/, "").length;
      const entries: string[] = [];
      i += 1;
      while (i < lines.length) {
        const nxt = lines[i]!;
        const nxt_indent = nxt.trim() !== "" ? nxt.length - nxt.replace(/^\s+/, "").length : 0;
        if (nxt.trim() !== "" && nxt_indent > header_indent) {
          entries.push(nxt);
          i += 1;
        } else {
          break;
        }
      }
      kept.push(...entries.slice(0, 3));
      if (entries.length > 3) {
        kept.push(" ".repeat(header_indent + 2) + `[token-goat: ${entries.length - 3} more entries elided]`);
      }
      continue;
    }
    // Conditions: keep the whole section (compact high-signal table)
    if (stripped.startsWith("Conditions:")) {
      kept.push(line);
      i += 1;
      while (i < lines.length) {
        const nxt = lines[i]!;
        if (nxt.trim() === "") {
          break;
        }
        kept.push(nxt);
        i += 1;
      }
      continue;
    }
    // Events: keep last 10 lines, elide older with a count
    if (stripped.startsWith("Events:")) {
      kept.push("");
      kept.push("Events:");
      const event_lines = lines.slice(i + 1).filter((ln) => ln.trim() !== "");
      if (event_lines.length > 0) {
        if (event_lines.length > 10) {
          kept.push(`  [token-goat: ${event_lines.length - 10} earlier events elided]`);
          kept.push(...event_lines.slice(event_lines.length - 10));
        } else {
          kept.push(...event_lines);
        }
      }
      break;
    }
    // Key single-line fields always kept
    if (_KEY_PREFIXES.some((pfx) => stripped.startsWith(pfx))) {
      kept.push(line);
    }
    i += 1;
  }
  if (kept.length === 0) {
    return lines.slice(0, 20).join("\n") + "\n[token-goat: describe output truncated]";
  }
  return kept.join("\n");
}

// ===========================================================================
// Docker Compose regexes (Python lines ~4202-4213).
// ===========================================================================

// Patterns for docker-compose streaming output ("service_name | log line").
// Python: re.compile(r"^(?P<svc>[a-zA-Z0-9_\-\.]+(?:-\d+)?)\s*\|\s*(?P<msg>.*)$")
const _DC_SERVICE_LOG_RE: RegExp =
  /^(?<svc>[a-zA-Z0-9_\-.]+(?:-\d+)?)\s*\|\s*(?<msg>.*)$/;
// Pulling service lines: "Pulling service_name (image:tag)..."
// Python: re.compile(r"^Pulling\s+\S+\s+\(.*\)\s*\.\.\.\s*$")
const _DC_PULLING_RE: RegExp = /^Pulling\s+\S+\s+\(.*\)\s*\.\.\.\s*$/;
// Health-check retry lines.
// Python: re.compile(r"Container\s+\S+\s+(Waiting|health:\s+\w+|starting|unhealthy)", re.IGNORECASE)
const _DC_HEALTH_RE: RegExp =
  /Container\s+\S+\s+(Waiting|health:\s+\w+|starting|unhealthy)/i;

// ===========================================================================
// DockerComposeFilter (Python lines ~4216-4321).
// ===========================================================================

/**
 * Compress `docker-compose` and `docker compose` output.
 *
 * Compression model:
 *   - Pulling lines: keep the first, collapse the rest to a count.
 *   - Streaming service logs (`svc | message`): when a service emits more than 50
 *     lines in one capture, keep the last 10 with a count marker.
 *   - Creating/Starting/Stopping lines: keep verbatim (they are short).
 *   - Build output: delegate to DockerFilter patterns.
 *   - Health-check retries: collapse repeated waiting/retry lines to a count per
 *     container.
 */
export class DockerComposeFilter extends Filter {
  override error_passthrough = true;

  override name = "docker-compose";
  override binaries: ReadonlySet<string> = new Set(["docker-compose", "docker"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    // docker-compose binary
    if (stem === "docker-compose" || name === "docker-compose") {
      return true;
    }
    // `docker compose` (subcommand form)
    if (stem === "docker" || name === "docker") {
      const positionals = _positional_args(argv.slice(1));
      return positionals.length > 0 && positionals[0] === "compose";
    }
    return false;
  }

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    // Collect per-service log lines for streaming dedup
    const service_lines = new Map<string, string[]>();
    const kept: string[] = [];
    let pulling_count = 0;
    let pulling_kept = 0;
    const health_counts = new Map<string, number>();

    for (const line of lines) {
      // Health-check retry collapsing
      const hm = _reSearch(_DC_HEALTH_RE, line);
      if (hm) {
        // Use the container name as key (first word-like group after
        // "Container") to group retries
        const toks = _splitWhitespace(line);
        const container_key = toks.length > 1 ? toks[1]! : "container";
        health_counts.set(container_key, (health_counts.get(container_key) ?? 0) + 1);
        // Emit only the first occurrence; the rest become the count
        if (health_counts.get(container_key) === 1) {
          kept.push(line);
        }
        continue;
      }

      // Pulling lines: keep the first, collapse the rest
      if (_reMatch(_DC_PULLING_RE, line)) {
        pulling_count += 1;
        if (pulling_kept === 0) {
          kept.push(line);
          pulling_kept = 1;
        }
        continue;
      }

      // Streaming service log lines: buffer per service
      const sm = _reSearchObj(_DC_SERVICE_LOG_RE, line);
      if (sm !== null && sm.index === 0) {
        const svc = sm.groups!["svc"]!;
        if (!service_lines.has(svc)) {
          service_lines.set(svc, []);
        }
        service_lines.get(svc)!.push(line);
        continue;
      }

      kept.push(line);
    }

    // Flush pulled-count summary
    if (pulling_count > pulling_kept) {
      kept.push(`[token-goat: ${pulling_count - pulling_kept} more Pulling lines elided]`);
    }

    // Flush health-check summaries
    for (const container_key of [...health_counts.keys()].sort()) {
      const count = health_counts.get(container_key)!;
      if (count > 1) {
        kept.push(`[token-goat: ${count - 1} more health-check wait lines for ${container_key}]`);
      }
    }

    // Flush service log buffers — collapse services with >50 lines
    const STREAM_THRESHOLD = 50;
    const STREAM_TAIL = 10;
    for (const svc of [...service_lines.keys()].sort()) {
      const svc_lines = service_lines.get(svc)!;
      if (svc_lines.length <= STREAM_THRESHOLD) {
        kept.push(...svc_lines);
      } else {
        const extra = svc_lines.length - STREAM_TAIL;
        kept.push(`[token-goat: ${extra} lines from ${svc} elided (showing last ${STREAM_TAIL})]`);
        kept.push(...svc_lines.slice(svc_lines.length - STREAM_TAIL));
      }
    }

    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Helm regexes (Python lines ~4327-4342).
// ===========================================================================

// Helm release description boilerplate patterns.
// Python: re.compile(r"^(NAME|LAST DEPLOYED|NAMESPACE|CHART|APP VERSION|REVISION
//   |TEST SUITE|NOTES\.|RESOURCES:|==>|USER-SUPPLIED VALUES:|COMPUTED VALUES:
//   |HOOKS:|MANIFEST:)\b")
const _HELM_RELEASE_DESC_RE: RegExp =
  /^(NAME|LAST DEPLOYED|NAMESPACE|CHART|APP VERSION|REVISION|TEST SUITE|NOTES\.|RESOURCES:|==>|USER-SUPPLIED VALUES:|COMPUTED VALUES:|HOOKS:|MANIFEST:)\b/;
// Python: re.compile(r"^STATUS:\s*\S+")
const _HELM_STATUS_RE: RegExp = /^STATUS:\s*\S+/;
// Helm template section headers: "---" possibly followed by "# Source: ...".
// Python: re.compile(r"^---\s*(?:#.*)?$")
const _HELM_TEMPLATE_SECTION_RE: RegExp = /^---\s*(?:#.*)?$/;
// Helm table row (helm list): tab-separated or padded columns.
// Python: re.compile(r"^\S+\s")
const _HELM_LIST_ROW_RE: RegExp = /^\S+\s/;

// ===========================================================================
// HelmFilter (Python lines ~4345-4384) + helm helpers (~4387-4456).
// ===========================================================================

/**
 * Compress `helm` output.
 *
 * Compression model:
 *   - `helm install` / `upgrade`: keep the `STATUS:` line verbatim; collapse the
 *     surrounding release description boilerplate. Error messages are always
 *     preserved.
 *   - `helm list`: when output exceeds 20 data rows, keep the header + first 10
 *     rows + a count of remaining rows.
 *   - `helm template`: when the rendered YAML exceeds 200 lines, emit only the
 *     YAML document separators (`---`) with kind/name comments and a total line
 *     count.
 *   - All other subcommands: pass through.
 */
export class HelmFilter extends Filter {
  override error_passthrough = true;

  override name = "helm";
  override binaries: ReadonlySet<string> = new Set(["helm"]);

  override _compress_body(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    let text = stdout;

    if (subcommand === "install" || subcommand === "upgrade") {
      text = _compress_helm_install(text);
    } else if (subcommand === "list") {
      text = _compress_helm_list(text);
    } else if (subcommand === "template") {
      const lines = text.split("\n");
      if (lines.length > 200) {
        text = _compress_helm_template(lines);
      }
    }
    // else: rollback, status, history, etc. — pass through

    if (stderr.trim() !== "") {
      text = text.trim() !== "" ? `${_rstrip(text)}\n---\n${_rstrip(stderr)}` : stderr;
    }
    return text;
  }
}

/** Collapse helm install/upgrade boilerplate; preserve STATUS and errors. */
function _compress_helm_install(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let dropped = 0;
  let in_notes = false;

  for (const line of lines) {
    // Always keep error signal lines
    if (_reSearch(_ERROR_SIGNAL_RE, line)) {
      kept.push(line);
      continue;
    }
    // Always keep the STATUS line
    if (_reMatch(_HELM_STATUS_RE, line)) {
      kept.push(line);
      continue;
    }
    // Track NOTES section start — keep NOTES header, drop body
    if (line.trim() === "NOTES:") {
      in_notes = true;
      dropped += 1;
      continue;
    }
    if (in_notes) {
      // Notes body: drop until a blank line or next section
      if (line.trim() === "") {
        in_notes = false;
      }
      dropped += 1;
      continue;
    }
    // Drop verbose boilerplate field lines
    if (_reMatch(_HELM_RELEASE_DESC_RE, line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }

  if (dropped) {
    kept.push(`[token-goat: ${dropped} helm release description lines elided]`);
  }
  return kept.join("\n");
}

/** Cap helm list output at header + 10 data rows. */
function _compress_helm_list(text: string): string {
  const lines = text.split("\n").filter((ln) => ln.trim() !== "");
  const MAX_ROWS = 10;
  // First line is header
  if (lines.length <= MAX_ROWS + 1) {
    return text;
  }
  const header = lines[0]!;
  const data = lines.slice(1);
  const kept = [header, ...data.slice(0, MAX_ROWS)];
  kept.push(
    `[token-goat: ${data.length - MAX_ROWS} more helm releases elided; ` +
      "use --filter or --namespace to narrow]",
  );
  return kept.join("\n");
}

/** Emit only YAML document headers from a large helm template output. */
function _compress_helm_template(lines: string[]): string {
  const total = lines.length;
  const sections: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("---")) {
      sections.push(line);
    }
  }
  if (sections.length === 0) {
    // No document separators found — just head/tail truncate
    return _head_tail_compress(lines, 10, 10, "template lines");
  }
  sections.push(
    `[token-goat: helm template ${total} total lines; showing ${sections.length} document headers only]`,
  );
  return sections.join("\n");
}

// ===========================================================================
// KubectlLogs enhanced regexes (Python lines ~4462-4473).
// ===========================================================================

// Timestamp prefix pattern common in structured/k8s log lines.
// Python: re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}")
const _KUBE_TIMESTAMP_RE: RegExp = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
// Access-log pattern: IP + HTTP method/path/status (Python uses re.X — verbose
// whitespace removed here so the source matches byte-for-byte).
// Python: re.compile(r"""(?:\d{1,3}\.){3}\d{1,3}.*?"(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s[^"]*"\s+(\d{3})\b""")
const _KUBE_ACCESS_LOG_RE: RegExp =
  /(?:\d{1,3}\.){3}\d{1,3}.*?"(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s[^"]*"\s+(\d{3})\b/;
// Stack trace frame patterns (Java, Python, Go, Node).
// Python: re.compile(r"""^\s+(?:at\s+[\w\.$<>]+\(|File "[^"]+", line \d+|goroutine \d+ \[|\s+\.\.\.)""")
const _KUBE_STACKFRAME_RE: RegExp =
  /^\s+(?:at\s+[\w.$<>]+\(|File "[^"]+", line \d+|goroutine \d+ \[|\s+\.\.\.)/;

// Pod/container prefix patterns for `kubectl logs --prefix` and sidecar-style
// output. Compiled at module level — used by _dedup_log_lines_with_pod_prefix.
// Python: re.compile(r"^\[[^\]]+\]\s+|^[a-z0-9][a-z0-9\-\.]*\s+\|\s+")
const _KUBECTL_POD_PREFIX_RE: RegExp =
  /^\[[^\]]+\]\s+|^[a-z0-9][a-z0-9\-.]*\s+\|\s+/;

// ===========================================================================
// KubectlLogsFilter (Python lines ~4476-4567).
// ===========================================================================

/**
 * Compress high-volume `kubectl logs` output with richer deduplication.
 *
 * Compression model (applied on top of the base KubectlFilter head/tail):
 *   - Repetitive lines (same message, different timestamps): keep first 3, show
 *     `N more similar lines` for the rest.
 *   - Multi-pod / --prefix output (`pod-name | message`): strip the pod prefix
 *     before deduplication so the same recurring message from multiple pods is
 *     collapsed correctly.
 *   - JSON log blobs: compact single-line JSON passes through; JSON blobs spanning
 *     more than 5 lines are collapsed to a one-line summary.
 *   - Stack traces: keep first 5 frame lines + `... N frames` marker.
 *   - HTTP access logs: when more than 20 lines match the access-log pattern,
 *     collapse to `N HTTP requests (2xx: N, 4xx: N, 5xx: N)`.
 *   - Head+tail cap: if output is still > 200 lines after all the above, cap to
 *     head=40, tail=40 to prevent unbounded context burn on `--follow` streams
 *     that were interrupted.
 */
export class KubectlLogsFilter extends Filter {
  override error_passthrough = true;

  override name = "kubectl-logs";
  override binaries: ReadonlySet<string> = new Set(["kubectl", "k"]);

  // `kubectl logs --prefix` or `kubectl logs -l selector` emits lines like
  // `[pod/my-pod-abc123/container] 2024-01-01T... message` or the legacy
  // `pod-name | message` from some log-tailing tools.
  // Python: re.compile(r"^\[pod/[^/]+/[^\]]+\]\s+|^[a-z0-9][a-z0-9\-\.]*\s+\|\s+")
  _POD_PREFIX_RE: RegExp = /^\[pod\/[^/]+\/[^\]]+\]\s+|^[a-z0-9][a-z0-9\-.]*\s+\|\s+/;

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    if (stem !== "kubectl" && stem !== "k" && name !== "kubectl" && name !== "k") {
      return false;
    }
    const positionals = _positional_args(argv.slice(1));
    return positionals.length > 0 && positionals[0] === "logs";
  }

  /** Return *line* with the pod/container prefix removed, if present. */
  static _strip_pod_prefix(line: string): string {
    // `[pod/name/container] ` prefix (--prefix flag)
    const m = /^\[[^\]]+\]\s+/.exec(line);
    if (m !== null && m.index === 0) {
      return line.slice(m.index + m[0].length);
    }
    // `pod-name | ` prefix (multi-container log tools)
    const m2 = /^[a-z0-9][a-z0-9\-.]*\s+\|\s+/.exec(line);
    if (m2 !== null && m2.index === 0) {
      return line.slice(m2.index + m2[0].length);
    }
    return line;
  }

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const lines = stdout.split("\n");
    let non_empty = lines.filter((ln) => ln.trim() !== "");

    if (non_empty.length <= 50) {
      return stdout;
    }

    // Step 1: access-log collapsing
    non_empty = _collapse_access_logs(non_empty);

    // Step 2: stack-trace collapsing
    non_empty = _collapse_stack_traces(non_empty);

    // Step 3: repetitive-line dedup (timestamp- AND pod-prefix-normalised).
    non_empty = _dedup_log_lines_with_pod_prefix(non_empty, 3);

    // Step 4: JSON blob collapsing
    non_empty = _collapse_json_blobs(non_empty, 5);

    // Step 5: hard head+tail cap for very long --follow captures.
    if (non_empty.length > 200) {
      const non_empty_str = _head_tail_compress(non_empty, 40, 40, "log lines");
      if (stderr.trim() !== "") {
        return non_empty_str.trim() !== ""
          ? `${_rstrip(non_empty_str)}\n---\n${_rstrip(stderr)}`
          : stderr;
      }
      return non_empty_str;
    }

    if (stderr.trim() !== "") {
      const result = non_empty.join("\n");
      return result.trim() !== "" ? `${_rstrip(result)}\n---\n${_rstrip(stderr)}` : stderr;
    }
    return non_empty.join("\n");
  }
}

/**
 * Remove leading ISO-8601 timestamp from a log line for pattern comparison.
 *
 * Delegates to the shared _TIMESTAMP_PREFIX_RE so all timestamp formats (ISO-8601,
 * compact datetime, HH:MM:SS) are handled consistently.
 */
function _strip_timestamp(line: string): string {
  return line.replace(_TIMESTAMP_PREFIX_RE, "").trim();
}

/**
 * Deduplicate log lines that differ only in leading timestamps.
 *
 * Groups consecutive lines by their timestamp-stripped content. The first
 * *keep_first_n* in each run are kept verbatim; additional lines are collapsed to
 * a single `N more similar lines` marker.
 */
function _dedup_log_lines(lines: string[], keep_first_n = 3): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = _strip_timestamp(line);
    // Count consecutive lines with the same de-timestamped content
    let j = i + 1;
    while (j < lines.length && _strip_timestamp(lines[j]!) === key) {
      j += 1;
    }
    const run = lines.slice(i, j);
    if (run.length <= keep_first_n) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, keep_first_n));
      out.push(`[token-goat: ${run.length - keep_first_n} more similar lines omitted]`);
    }
    i = j;
  }
  return out;
}

/**
 * Deduplicate log lines that differ only in timestamps and/or pod prefixes.
 *
 * Extends _dedup_log_lines to handle `kubectl logs --prefix` and
 * `kubectl logs -l <selector>` output where each line is prefixed with a
 * pod/container identifier. Lines that share the same timestamp-stripped,
 * pod-stripped content are treated as a single repeated message even when they
 * come from different pods.
 *
 * The first *keep_first_n* occurrences of each normalised message are kept
 * verbatim (preserving the original line). The rest are collapsed.
 */
function _dedup_log_lines_with_pod_prefix(lines: string[], keep_first_n = 3): string[] {
  const _normalise = (line: string): string => {
    // Strip pod prefix then timestamp.
    const no_pod = line.replace(_KUBECTL_POD_PREFIX_RE, "");
    return _strip_timestamp(no_pod).trim();
  };

  const out: string[] = [];
  const seen = new Map<string, number>();
  const omit = new Map<string, number>();
  let prev_key: string | null = null;

  for (const line of lines) {
    const key = _normalise(line);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);

    if (count < keep_first_n) {
      // Flush any pending omit marker for the previous key when we move to a new
      // message (non-consecutive run).
      if (prev_key !== null && prev_key !== key && (omit.get(prev_key) ?? 0)) {
        out.push(`[token-goat: ${omit.get(prev_key)!} more similar lines omitted]`);
        omit.set(prev_key, 0);
      }
      out.push(line);
    } else {
      omit.set(key, (omit.get(key) ?? 0) + 1);
    }

    prev_key = key;
  }

  // Flush final omit counters in insertion order (Map preserves insertion order).
  const flushed = new Set<string>();
  for (const [key, count] of omit) {
    if (count > 0 && !flushed.has(key)) {
      out.push(`[token-goat: ${count} more similar lines omitted]`);
      flushed.add(key);
    }
  }

  return out;
}

/** Collapse stack-trace frame runs to first 5 frames + count marker. */
function _collapse_stack_traces(lines: string[]): string[] {
  const MAX_FRAMES = 5;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (_reMatch(_KUBE_STACKFRAME_RE, lines[i]!)) {
      // Collect all contiguous frame lines
      let j = i;
      while (j < lines.length && _reMatch(_KUBE_STACKFRAME_RE, lines[j]!)) {
        j += 1;
      }
      const frames = lines.slice(i, j);
      out.push(...frames.slice(0, MAX_FRAMES));
      if (frames.length > MAX_FRAMES) {
        out.push(`    ... ${frames.length - MAX_FRAMES} more frames`);
      }
      i = j;
    } else {
      out.push(lines[i]!);
      i += 1;
    }
  }
  return out;
}

/** Collapse HTTP access log lines to a summary when there are more than 20. */
function _collapse_access_logs(lines: string[]): string[] {
  const ACCESS_THRESHOLD = 20;
  const access_lines: string[] = [];
  const other_lines: string[] = [];
  for (const line of lines) {
    if (_reSearch(_KUBE_ACCESS_LOG_RE, line)) {
      access_lines.push(line);
    } else {
      other_lines.push(line);
    }
  }
  if (access_lines.length <= ACCESS_THRESHOLD) {
    return lines; // not enough to bother compressing
  }
  // Tally status code buckets
  const counts = new Map<string, number>();
  for (const line of access_lines) {
    const m = _reSearchObj(_KUBE_ACCESS_LOG_RE, line);
    if (m !== null) {
      const status = m[1]!;
      const bucket = `${status[0]!}xx`;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }
  const detail = [...counts.keys()]
    .sort()
    .map((k) => `${k}: ${counts.get(k)!}`)
    .join(", ");
  const summary = `[token-goat: ${access_lines.length} HTTP access log lines collapsed (${detail})]`;
  return [...other_lines, summary];
}

/**
 * Collapse multi-line JSON blobs that span more than *max_json_lines* lines.
 *
 * Detects JSON blobs by looking for lines that start with `{` and end with `}`
 * after accounting for nested structure via brace counting. Compact single-line
 * JSON objects are left unchanged.
 */
function _collapse_json_blobs(lines: string[], max_json_lines = 5): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const stripped = line.trim();
    // Possible start of a JSON object blob
    if (stripped.startsWith("{") && !stripped.endsWith("}")) {
      let depth = _countChar(stripped, "{") - _countChar(stripped, "}");
      let j = i + 1;
      while (j < lines.length && depth > 0) {
        const chunk = lines[j]!.trim();
        depth += _countChar(chunk, "{") - _countChar(chunk, "}");
        j += 1;
      }
      const blob_lines = lines.slice(i, j);
      if (blob_lines.length > max_json_lines) {
        // Try to extract a summary key from the blob
        const summary_key = _json_blob_summary(blob_lines);
        out.push(`[token-goat: JSON blob ${blob_lines.length} lines collapsed${summary_key}]`);
        i = j;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out;
}

/** Python str.count(sub) — count of non-overlapping occurrences of a single char. */
function _countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) {
    if (c === ch) {
      n += 1;
    }
  }
  return n;
}

/** Extract a short summary from a JSON blob (first key-value pair). */
function _json_blob_summary(blob_lines: string[]): string {
  try {
    const obj: unknown = JSON.parse(blob_lines.join("\n"));
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>;
      for (const key of ["message", "msg", "level", "severity", "event", "type"]) {
        if (Object.prototype.hasOwnProperty.call(rec, key)) {
          return `: ${key}=${_pyRepr(rec[key])}`;
        }
      }
    }
  } catch {
    // ValueError / TypeError parity — fall through to "".
  }
  return "";
}

// ===========================================================================
// Module-private regex/helper references kept for parity (some are declared in
// Python but not referenced by these classes; retained so the source maps 1:1).
// Touch them in a no-op so strict unused-symbol settings stay quiet without
// exporting framework-private names.
// ===========================================================================
void _HELM_TEMPLATE_SECTION_RE;
void _HELM_LIST_ROW_RE;
void _KUBE_TIMESTAMP_RE;
void _dedup_log_lines;
