/**
 * bash_compress INFRASTRUCTURE-AS-CODE / DEPLOY FILTERS — TypeScript port of the
 * IaC + deployment Filter subclasses from src/token_goat/bash_compress.py:
 *
 *   - TerraformFilter   (Python ~line 8750) — `terraform` / `tofu` / `terragrunt`
 *                         plan/apply/init/validate/show/state subcommand dispatch
 *                         with per-subcommand compression (refresh/read drop,
 *                         (known after apply) collapse, Still-line dedup, provider
 *                         install collapse, show/state attribute pruning).
 *   - PulumiFilter      (Python ~line 19131) — `pulumi` up/preview/destroy/refresh
 *                         (progress / "still ..." heartbeat drop, keep completion
 *                         + summary + diagnostic + header lines).
 *   - CdkFilter         (Python ~line 19249) — `cdk` deploy/synth/diff (asset
 *                         progress drop, IN_PROGRESS stack-event drop, keep
 *                         COMPLETE/FAILED + summary + error).
 *   - WasmPackFilter    (Python ~line 19359) — `wasm-pack` build/test/pack/publish
 *                         ([INFO] step drop, Cargo Compiling collapse, keep
 *                         Finished/Done/[WARN]/test-summary/error).
 *   - WranglerFilter    (Python ~line 21490) — Cloudflare `wrangler` deploy/pages
 *                         (asset upload/skip collapse, build-step + dev-mode drop,
 *                         bulk-op collapse, keep summary + error).
 *   - HardhatFilter     (Python ~line 21659) — Hardhat `hardhat` compile/test
 *                         (compilation + Solc-timing + passing-test collapse, tx
 *                         receipt drop, keep summary/failure/warn/deploy-header).
 *   - ServerlessFilter  (Python ~line 21821) — Serverless Framework `serverless` /
 *                         `sls` deploy/info/invoke (step collapse, CF IN_PROGRESS
 *                         + dot/tick drop, keep COMPLETE/FAILED + service-info +
 *                         summary + error).
 *
 * All seven subclass the concrete Filter base from ./framework.js. Every one sets
 * error_passthrough = true and overrides _compress_body (the Filter.compress
 * template short-circuits raw error output before _compress_body runs whenever the
 * command exits non-zero with non-empty stderr).
 *
 * Dispatch (binaries / subcommand gating) is wired by the BARREL one level up
 * (out of scope here); this module only ports the per-class detection + body
 * compression verbatim. There is no intra-cluster precedence among these seven
 * (each owns a disjoint binary set: terraform/tofu/terragrunt, pulumi, cdk,
 * wasm-pack, wrangler/wrangler2, hardhat, serverless/sls).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase classes, snake_case
 *    methods/fields (_compress_body, _compress_terraform_plan,
 *    _compress_terraform_apply, _compress_terraform_init,
 *    _compress_terraform_show), and the module-private regex constants
 *    (_TF_*, _PULUMI_*, _CDK_*, _WASMPACK_*, _WRANGLER_*, _HARDHAT_*, _SLS_*).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i". Patterns copied VERBATIM (same source, same flags).
 *  - Python re.Pattern.match(line) is anchored at the START (NOT end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). .search() -> _reSearch
 *    (non-global clone, any index). Inline re.match(pattern, line) calls in
 *    _compress_terraform_plan / _compress_terraform_show use literal RegExps via
 *    _reMatch too.
 *  - self._emit_notes(kept, notes) / self._finalize(kept) are STATIC on the
 *    framework Filter; called as <ClassName>._emit_notes / ._finalize.
 *    self._combine_output(...) is an instance method (this._combine_output).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (framework.ts does NOT export it); it
 *    is re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel's export* chain. _maybe_note,
 *    _head_tail_compress, _positional_args are framework-PUBLIC and imported.
 *  - Python str.rstrip() -> _rstrip (re-declared module-private; framework does
 *    not export it). dict[str, str] (still_last) -> a Map<string, string>;
 *    dict.pop(key, None) -> Map.get + Map.delete; iteration over .values()
 *    preserves insertion order (Python dict + JS Map both do).
 *  - Module-global mutable state: NONE. Every counter / Map / list is a local
 *    inside _compress_body or a per-subcommand helper; no registerReset seam.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  _head_tail_compress,
  _maybe_note,
  _positional_args,
} from "./framework.js";

// ===========================================================================
// Internal Python re / builtin shims local to this module.
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
  return _nonGlobal(re).exec(line) !== null;
}

/**
 * Python str.rstrip() — strip trailing ASCII/Unicode whitespace. The framework
 * does not export its own `_rstrip`; re-declared module-private here. Matches
 * Python's default whitespace set for the outputs these filters handle.
 */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

// ===========================================================================
// Framework-private error-signal pattern, re-declared MODULE-PRIVATE.
// ===========================================================================

// Patterns that signal an error or failure line worth preserving. framework.ts
// declares the identical _ERROR_SIGNAL_RE but does NOT export it; re-declaring it
// here keeps this module self-contained without introducing a duplicate export
// across the barrel's `export *` chain (which would be a TS2308 ambiguity).
// Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback
//   |exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Terraform regexes (Python lines ~8688-8747)
// ===========================================================================

// Terraform state refresh/read progress lines (one per resource, often hundreds).
const _TF_REFRESH_RE: RegExp =
  /^[a-z0-9_.[\]"-]+: (Refreshing state|Reading|Read complete|Still |Modifications complete)/;
// Terraform plan/apply summary line: ``Plan: 5 to add, 2 to change, 1 to destroy.``
const _TF_PLAN_SUMMARY_RE: RegExp = /^Plan: \d+ to (add|change|destroy|import)/;
// Terraform "No changes" plan output — resource is unchanged.
const _TF_NO_CHANGES_RE: RegExp =
  /^No changes\.|^(?:This plan does nothing|Nothing to do\.)/i;
// Terraform "Still creating..." / "Still modifying..." progress lines.
const _TF_STILL_RE: RegExp =
  /^[a-z0-9_.[\]"-]+: Still (?:creating|modifying|destroying)\.\.\./i;
// Terraform apply completion: ``Apply complete! Resources: 5 added, ...``
const _TF_APPLY_COMPLETE_RE: RegExp = /^Apply complete! Resources:/;
// Terraform creation/destruction completion lines.
const _TF_RESOURCE_COMPLETE_RE: RegExp =
  /^[a-z0-9_.[\]"-]+: (?:Creation|Destruction|Modifications?) complete/i;
// Terraform error or warning markers.
const _TF_ERROR_RE: RegExp = /^(?:Error|Warning):|FAILED/;
// Terraform plan attribute lines with ``(known after apply)``.
const _TF_KNOWN_AFTER_APPLY_RE: RegExp = /\(known after apply\)/;
// Terraform plan ``~`` (in-place update) attribute diff lines.
const _TF_PLAN_ATTR_DIFF_RE: RegExp = /^\s+[~+\-]\s+\S/;
// terraform init provider noise.
const _TF_INIT_PROVIDER_RE: RegExp =
  /^\s*-\s+(?:Finding|Installing|Installed|Downloading|Locking)\s+\S+/i;
// terraform show/state resource block header.
const _TF_SHOW_RESOURCE_HDR_RE: RegExp =
  /^# (?:(?:module\.\S+\.)?[a-z][a-z0-9_]+\.[a-zA-Z0-9_.[\]-]+):$/;
// terraform show: high-signal attribute names worth keeping per resource block.
const _TF_SHOW_KEY_ATTR_RE: RegExp =
  /^\s+(?:id|arn|name|region|account_id|bucket|type|instance_type|endpoint|address|hostname|dns_name|tags(?:_all)?)\s*=/;

// Inline literal patterns used by _compress_terraform_plan / _show.
const _TF_RESOURCE_OPEN_QUOTED_RE: RegExp = /^\s+resource\s+"/;
const _TF_RESOURCE_OPEN_DOTTED_RE: RegExp =
  /^\s{2,6}[a-z][a-z0-9_]*\.[a-zA-Z0-9_.[\]-]+\s+\{/;
const _TF_BLOCK_CLOSE_RE: RegExp = /^\s{0,6}\}\s*$/;
const _TF_SHOW_BLOCK_OPENER_RE: RegExp = /^(?:resource|data)\s+"/;

/**
 * Compress ``terraform plan`` / ``apply`` / ``init`` / ``validate`` / ``show`` output.
 *
 * Terraform prints per-resource ``Refreshing state…`` lines (one per object,
 * often hundreds), then a giant diff with full resource bodies (mostly unchanged
 * attributes). Init outputs progress bars. Plan/apply produce multi-line
 * summaries.
 */
export class TerraformFilter extends Filter {
  override error_passthrough = true;

  override name = "terraform";
  override binaries: ReadonlySet<string> = new Set(["terraform", "tofu", "terragrunt"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    argv: string[],
  ): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    let text = stdout;

    if (subcommand === "plan") {
      text = this._compress_terraform_plan(text);
    } else if (subcommand === "apply") {
      text = this._compress_terraform_apply(text, stderr);
    } else if (subcommand === "init") {
      text = this._compress_terraform_init(text);
    } else if (subcommand === "validate" || subcommand === "validate-config") {
      // Pass through; validate output is typically brief.
    } else if (subcommand === "show" || subcommand === "state") {
      text = this._compress_terraform_show(text);
    } else if (subcommand === "output" || subcommand === "outputs") {
      // ``terraform output`` / ``terraform outputs`` emit key = value pairs.
      // Usually short; pass through.
    } else if (subcommand === "workspace") {
      // ``terraform workspace list/new/select/show/delete`` — short.
    } else if (subcommand === "import") {
      // ``terraform import`` — short resource lines, keep all.
    } else {
      // Unknown or missing subcommand: still strip terraform noise (Refreshing
      // state / Read complete lines) that appears in any terraform output.
      const lines = text.split("\n");
      let filtered = lines.filter((ln) => !_reSearch(_TF_REFRESH_RE, ln));
      if (filtered.length > 30) {
        filtered = filtered.filter((ln) => ln.trim() !== "");
        text = _head_tail_compress(filtered, 10, 20, "lines");
      } else if (filtered.length < lines.length) {
        text = filtered.join("\n");
      }
    }

    if (stderr.trim() !== "" && subcommand !== "apply") {
      // For non-apply commands, append stderr if not already included.
      text =
        text.trim() !== ""
          ? _rstrip(text) + "\n---\n" + _rstrip(stderr)
          : stderr;
    }
    return text;
  }

  /**
   * Compress terraform plan output.
   *
   * Drops refresh/read lines, collapses ``No changes.`` blocks for unchanged
   * resources, compresses ``(known after apply)``-only attribute sections in
   * resource blocks (keeps up to 8 non-trivial attributes per resource block),
   * keeps diff attribute lines (``~``/``+``/``-``), keeps the ``Plan: N to add…``
   * summary line, and keeps the last 20 lines of detailed plan diff.
   */
  _compress_terraform_plan(stdout: string): string {
    const lines = stdout.split("\n");
    let kept: string[] = [];
    let dropped_refresh = 0;
    let dropped_no_change_blocks = 0;
    let dropped_kaa = 0; // (known after apply) attribute lines collapsed

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;

      // Drop refresh/read progress lines.
      if (_reMatch(_TF_REFRESH_RE, line)) {
        dropped_refresh += 1;
        i += 1;
        continue;
      }

      // Detect "# resource will not be changed" / data-source read blocks.
      if (
        line.startsWith("# ") &&
        (line.includes("will not be") ||
          line.includes("is up-to-date") ||
          line.includes("not be created") ||
          line.includes("will be read during apply") ||
          line.includes("is a data resource"))
      ) {
        // Skip this comment block.
        i += 1;
        while (i < lines.length) {
          const body = lines[i]!;
          if (body.trim() === "") {
            break;
          }
          if (body.startsWith("# ")) {
            break;
          }
          if (_reMatch(_TF_PLAN_SUMMARY_RE, body) || _reMatch(_TF_APPLY_COMPLETE_RE, body)) {
            break;
          }
          i += 1;
        }
        dropped_no_change_blocks += 1;
        continue;
      }

      if (_reMatch(_TF_NO_CHANGES_RE, line)) {
        kept.push(line);
        i += 1;
        continue;
      }

      // Detect a resource block being created/modified (``resource_type.name {``).
      // Within such blocks, attribute lines that only have ``(known after apply)``
      // values add nothing useful. Keep diff lines (``~``, ``+``, ``-``) and the
      // first 8 non-kaa attribute lines; collapse the rest.
      if (
        (_reMatch(_TF_RESOURCE_OPEN_QUOTED_RE, line) ||
          _reMatch(_TF_RESOURCE_OPEN_DOTTED_RE, line)) &&
        i + 1 < lines.length
      ) {
        kept.push(line);
        i += 1;
        // Consume the body of this resource block until closing ``}`` at the
        // same indent level.
        let block_kaa = 0;
        let block_non_kaa_kept = 0;
        const NON_KAA_KEEP_MAX = 8;
        while (i < lines.length) {
          const body = lines[i]!;
          // Closing brace at same / outer indent = end of block
          if (_reMatch(_TF_BLOCK_CLOSE_RE, body)) {
            kept.push(body);
            i += 1;
            break;
          }
          // Diff attribute lines (changed values) — always keep.
          if (_reMatch(_TF_PLAN_ATTR_DIFF_RE, body)) {
            kept.push(body);
            i += 1;
            continue;
          }
          // Attribute line with ``(known after apply)`` — collapse.
          if (_reSearch(_TF_KNOWN_AFTER_APPLY_RE, body)) {
            block_kaa += 1;
            i += 1;
            continue;
          }
          // Other attribute lines: keep first NON_KAA_KEEP_MAX.
          if (block_non_kaa_kept < NON_KAA_KEEP_MAX) {
            kept.push(body);
            block_non_kaa_kept += 1;
          } else {
            block_kaa += 1; // count as collapsed
          }
          i += 1;
        }
        if (block_kaa) {
          kept.push(
            `    [token-goat: collapsed ${block_kaa}` +
              ` (known after apply) / excess attribute lines]`,
          );
          dropped_kaa += block_kaa;
        }
        continue;
      }

      kept.push(line);
      i += 1;
    }

    // Find the plan summary line and reorganise output around it.
    let summary_line: string | null = null;
    for (const ln of kept) {
      if (_reMatch(_TF_PLAN_SUMMARY_RE, ln)) {
        summary_line = ln;
        break;
      }
    }

    if (summary_line !== null) {
      // Keep plan summary first + last 20 lines of non-refresh kept output so
      // that the agent sees the resource names and the plan total.
      const tail_lines = kept.filter((ln) => !_reMatch(_TF_REFRESH_RE, ln));
      const final_kept: string[] = [summary_line];
      const tail_start = Math.max(0, tail_lines.length - 20);
      for (const ln of tail_lines.slice(tail_start)) {
        if (ln !== summary_line) {
          final_kept.push(ln);
        }
      }
      kept = final_kept;
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_refresh, `dropped ${dropped_refresh} terraform refresh/read lines`);
    _maybe_note(
      notes,
      dropped_no_change_blocks,
      `collapsed ${dropped_no_change_blocks} unchanged/read-only block(s)`,
    );
    _maybe_note(notes, dropped_kaa, `collapsed ${dropped_kaa} (known after apply) attribute lines`);
    TerraformFilter._emit_notes(kept, notes);
    return TerraformFilter._finalize(kept);
  }

  /**
   * Compress terraform apply output.
   *
   * Collapses ``Still creating…`` / ``Still modifying…`` progress lines to the
   * last status per resource; keeps ``Creation complete`` / ``Destruction
   * complete``; keeps ``Apply complete!`` summary; keeps all error blocks
   * verbatim.
   */
  _compress_terraform_apply(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped_refresh = 0;
    // resource_key -> last "Still ..." line seen
    const still_last = new Map<string, string>();
    let still_dropped = 0;

    for (const line of lines) {
      // Check resource-completion lines BEFORE the refresh filter because
      // _TF_REFRESH_RE also matches "Modifications complete" (which is a
      // completion signal, not noise).
      if (_reMatch(_TF_RESOURCE_COMPLETE_RE, line)) {
        const resource_key = line.split(":")[0]!.trim();
        const last_still = still_last.get(resource_key);
        still_last.delete(resource_key);
        if (last_still !== undefined && last_still) {
          kept.push(last_still);
        }
        kept.push(line);
        continue;
      }
      if (_reMatch(_TF_REFRESH_RE, line)) {
        dropped_refresh += 1;
        continue;
      }
      // Collapse "Still creating/modifying..." — track last per resource.
      if (_reMatch(_TF_STILL_RE, line)) {
        // Extract resource key (everything before ": Still")
        const resource_key = line.split(": Still")[0]!.trim();
        if (still_last.has(resource_key)) {
          still_dropped += 1;
        }
        still_last.set(resource_key, line);
        continue;
      }
      if (_reMatch(_TF_APPLY_COMPLETE_RE, line) || _reMatch(_TF_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep non-refresh, non-progress lines.
      if (line.trim() !== "") {
        kept.push(line);
      }
    }

    // Flush any remaining "Still..." lines that didn't get a completion event.
    for (const last_still of still_last.values()) {
      kept.push(last_still);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_refresh, `dropped ${dropped_refresh} terraform refresh/read lines`);
    _maybe_note(notes, still_dropped, `collapsed ${still_dropped} Still creating/modifying line(s)`);
    TerraformFilter._emit_notes(kept, notes);
    return TerraformFilter._finalize(kept);
  }

  /** Compress terraform init: collapse provider download/install noise, keep key messages. */
  _compress_terraform_init(stdout: string): string {
    const lines = stdout.split("\n");
    const kept: string[] = [];
    let provider_collapsed = 0;
    for (const line of lines) {
      if (_reMatch(_TF_INIT_PROVIDER_RE, line)) {
        provider_collapsed += 1;
        continue;
      }
      kept.push(line);
    }
    // Strip trailing blank lines.
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") {
      kept.pop();
    }
    const non_empty = kept.filter((ln) => ln.trim() !== "");
    const notes: string[] = [];
    _maybe_note(notes, provider_collapsed, `collapsed ${provider_collapsed} provider install/find lines`);
    if (non_empty.length > 12) {
      let compressed = _head_tail_compress(non_empty, 5, 5, "lines");
      if (notes.length > 0) {
        compressed = _rstrip(compressed) + "\n" + notes.join("\n");
      }
      return compressed;
    }
    TerraformFilter._emit_notes(kept, notes);
    return TerraformFilter._finalize(kept);
  }

  /** Compress terraform show/state: keep high-signal attributes per resource block, collapse rest. */
  _compress_terraform_show(stdout: string): string {
    const lines = stdout.split("\n");
    const kept: string[] = [];
    let collapsed_total = 0;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (_reMatch(_TF_SHOW_RESOURCE_HDR_RE, line)) {
        kept.push(line);
        i += 1;
        let block_collapsed = 0;
        while (i < lines.length) {
          const body = lines[i]!;
          // Blank line signals end of this resource block.
          if (body.trim() === "") {
            kept.push(body);
            i += 1;
            break;
          }
          // Next resource header ends this block.
          if (_reMatch(_TF_SHOW_RESOURCE_HDR_RE, body)) {
            break;
          }
          // Keep block opener/closer lines.
          if (
            _reMatch(_TF_SHOW_BLOCK_OPENER_RE, body) ||
            body.trim() === "}" ||
            body.trim() === "{"
          ) {
            kept.push(body);
            i += 1;
            continue;
          }
          // Keep high-signal attribute lines.
          if (_reMatch(_TF_SHOW_KEY_ATTR_RE, body)) {
            kept.push(body);
            i += 1;
            continue;
          }
          block_collapsed += 1;
          collapsed_total += 1;
          i += 1;
        }
        if (block_collapsed) {
          kept.push(`  [token-goat: collapsed ${block_collapsed} attribute lines]`);
        }
        continue;
      }
      kept.push(line);
      i += 1;
    }
    // For short output (no resource headers found) fall back to head/tail.
    if (collapsed_total === 0) {
      const non_empty = kept.filter((ln) => ln.trim() !== "");
      if (non_empty.length > 30) {
        return _head_tail_compress(non_empty, 20, 10, "lines");
      }
    }
    const notes: string[] = [];
    _maybe_note(
      notes,
      collapsed_total,
      `collapsed ${collapsed_total} show/state attribute lines across resource blocks`,
    );
    TerraformFilter._emit_notes(kept, notes);
    return TerraformFilter._finalize(kept);
  }
}

// ===========================================================================
// Pulumi regexes (Python lines ~19081-19127)
// ===========================================================================

// Pulumi per-resource progress lines during up/destroy/refresh.
const _PULUMI_PROGRESS_RE: RegExp =
  /^\s+[a-zA-Z0-9_.:/-]+\s+\([^)]+\):\s+(?:creating|updating|deleting|replacing|refreshing|reading|configuring|waiting)\b/i;
// Pulumi per-resource "still ..." heartbeat lines.
const _PULUMI_STILL_RE: RegExp =
  /^\s+[a-zA-Z0-9_.:/-]+\s+\([^)]+\):\s+still\s+/i;
// Pulumi resource completion lines (always keep).
const _PULUMI_COMPLETE_RE: RegExp =
  /^\s+[a-zA-Z0-9_.:/-]+\s+\([^)]+\):\s+(?:created|updated|deleted|replaced|refreshed|read|configured)\b/i;
// Pulumi plan/summary line (always keep).
const _PULUMI_SUMMARY_RE: RegExp =
  /^\s*(?:Resources:|Duration:|Outputs:|View\s+Live|Permalink:|The resources in the stack have been deleted|Your update was rejected|No changes\.|Previewing\s+(?:update|destroy|refresh)|Updating\s+\(|Destroying\s+\(|Refreshing\s+\(|\d+\s+resource[s]?\s+(?:created|updated|deleted|changed|unchanged|same))/i;
// Pulumi diagnostic lines — error/warning (always keep).
const _PULUMI_DIAG_RE: RegExp = /^\s*(?:error:|warning:|diagnostic:)\s*/i;
// Pulumi stack header lines (always keep).
const _PULUMI_HEADER_RE: RegExp =
  /^\s*(?:Updating\s+\(|Previewing\s+\(|Destroying\s+\(|Refreshing\s+\(|Stack\s+|pulumi\s+version\s+|warning:\s+A\s+new\s+version)/i;

/**
 * Compress ``pulumi up`` / ``preview`` / ``destroy`` / ``refresh`` output.
 *
 * Pulumi emits a live-updating progress display: one line per resource per state
 * transition. Compression keeps only the final completion event per resource plus
 * summary / diagnostic / header lines; progress and "still ..." heartbeat lines
 * are dropped.
 */
export class PulumiFilter extends Filter {
  override error_passthrough = true;

  override name = "pulumi";
  override binaries: ReadonlySet<string> = new Set(["pulumi"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_progress = 0;
    let dropped_still = 0;

    for (const line of lines) {
      // Summary, diagnostic, header — always keep.
      if (
        _reMatch(_PULUMI_SUMMARY_RE, line) ||
        _reMatch(_PULUMI_DIAG_RE, line) ||
        _reMatch(_PULUMI_HEADER_RE, line) ||
        _reSearch(_ERROR_SIGNAL_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Completion events — always keep.
      if (_reMatch(_PULUMI_COMPLETE_RE, line)) {
        kept.push(line);
        continue;
      }
      // "still ..." heartbeat lines — drop.
      if (_reMatch(_PULUMI_STILL_RE, line)) {
        dropped_still += 1;
        continue;
      }
      // Initial progress lines (creating / updating …) — drop.
      if (_reMatch(_PULUMI_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} resource progress lines`);
    _maybe_note(notes, dropped_still, `dropped ${dropped_still} 'still ...' heartbeat lines`);
    PulumiFilter._emit_notes(kept, notes);
    return PulumiFilter._finalize(kept);
  }
}

// ===========================================================================
// AWS CDK regexes (Python lines ~19199-19246)
// ===========================================================================

// CDK asset upload/build progress lines (verbose, low-signal).
const _CDK_ASSET_PROGRESS_RE: RegExp =
  /^\s*(?:\[\s*\d+%\s*\]|\[asset\s|\[copy\s|\[zip\s|\bAsset\s+\S+\s+uploaded\b)/i;
// CDK stack event lines emitted during deploy — IN_PROGRESS status columns.
const _CDK_STACK_IN_PROGRESS_RE: RegExp = /^\s+\w+_IN_PROGRESS\s+/;
// CDK stack event completion lines (always keep).
const _CDK_STACK_COMPLETE_RE: RegExp =
  /^\s+(?:CREATE|UPDATE|DELETE|REPLACE|ROLLBACK)_COMPLETE\s+/;
// CDK stack event failure lines (always keep).
const _CDK_STACK_FAILED_RE: RegExp = /^\s+\w+_FAILED\s+/;
// CDK deploy summary / header (always keep).
const _CDK_SUMMARY_RE: RegExp =
  /^\s*(?:✅|❌|Stack\s+ARN:|Outputs:|CDK Toolkit|cdk\s+version\s+|[A-Za-z0-9_-]+:\s+(?:deploying|destroying|synthesizing|deploy|diff)\b|Successfully\s+deployed|Deployment\s+(?:complete|failed)|There\s+were\s+no\s+differences|Resources:|This deployment\s+will|Bundling\s+asset|Found\s+\d+\s+stack)/i;
// CDK hotswap / lookup lines (informational noise).
const _CDK_HOTSWAP_TIME_RE: RegExp =
  /^\s*(?:✨\s+Synthesis time:|✨\s+Total time:|⏱\s+Total time:|⚠️.*hotswap|Hotswap\s+deployment)/i;

/**
 * Compress ``cdk deploy`` / ``destroy`` / ``synth`` / ``diff`` output.
 *
 * CDK emits granular CloudFormation stack events (one line per resource per
 * status transition) plus verbose asset bundling progress. Asset progress and
 * IN_PROGRESS events are dropped; COMPLETE / FAILED / summary / error lines are
 * always kept.
 */
export class CdkFilter extends Filter {
  override error_passthrough = true;

  override name = "cdk";
  override binaries: ReadonlySet<string> = new Set(["cdk"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_asset = 0;
    let dropped_in_progress = 0;

    for (const line of lines) {
      // Error signal / failure events — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_CDK_STACK_FAILED_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary / completion events — always keep.
      if (_reMatch(_CDK_SUMMARY_RE, line) || _reMatch(_CDK_STACK_COMPLETE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Timing / hotswap noise — drop (low signal).
      if (_reMatch(_CDK_HOTSWAP_TIME_RE, line)) {
        dropped_in_progress += 1;
        continue;
      }
      // Asset progress lines — drop.
      if (_reMatch(_CDK_ASSET_PROGRESS_RE, line)) {
        dropped_asset += 1;
        continue;
      }
      // IN_PROGRESS stack events — drop.
      if (_reMatch(_CDK_STACK_IN_PROGRESS_RE, line)) {
        dropped_in_progress += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_asset, `dropped ${dropped_asset} asset build/upload progress lines`);
    _maybe_note(notes, dropped_in_progress, `dropped ${dropped_in_progress} IN_PROGRESS / timing lines`);
    CdkFilter._emit_notes(kept, notes);
    return CdkFilter._finalize(kept);
  }
}

// ===========================================================================
// wasm-pack regexes (Python lines ~19314-19356)
// ===========================================================================

// wasm-pack compilation step lines: "[INFO]: ..."
const _WASMPACK_INFO_RE: RegExp = /^\s*\[INFO\]:\s+/i;
// wasm-pack success summary (always keep via re.search, not re.match).
const _WASMPACK_DONE_RE: RegExp =
  /(?:✨\s+Done|Your\s+wasm\s+pkg\s+is\s+ready|wasm-pack\s+\S+\s+succeeded|Successfully\s+ran)/i;
// wasm-pack warning lines (keep): "[WARN]: ..."
const _WASMPACK_WARN_RE: RegExp = /^\s*\[WARN\]:\s+/i;
// Cargo compile progress lines that wasm-pack wraps (low-signal).
const _WASMPACK_CARGO_COMPILING_RE: RegExp =
  /^\s+(?:Compiling|Downloading|Fetching|Unpacking|Checking)\s+\S+\s+v\d+\./i;
// wasm-pack Cargo build summary (always keep): "   Finished ..."
const _WASMPACK_CARGO_FINISHED_RE: RegExp = /^\s+Finished\s+/i;
// wasm-pack test output lines.
const _WASMPACK_TEST_SUMMARY_RE: RegExp =
  /^\s*(?:running\s+\d+\s+test|test\s+result:\s+(?:ok|FAILED))/i;

/**
 * Compress ``wasm-pack build`` / ``test`` / ``pack`` / ``publish`` output.
 *
 * ``wasm-pack`` orchestrates a Rust→WebAssembly build pipeline whose verbose
 * Cargo compilation output drowns out the actual build summary. [INFO] steps are
 * dropped, Cargo Compiling lines collapsed; Finished / Done / [WARN] / test
 * summary / error lines are always kept.
 */
export class WasmPackFilter extends Filter {
  override error_passthrough = true;

  override name = "wasm-pack";
  override binaries: ReadonlySet<string> = new Set(["wasm-pack"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_info = 0;
    let dropped_compiling = 0;

    for (const line of lines) {
      // Error signal / warnings / test summary / done — always keep.
      // _WASMPACK_DONE_RE uses re.search (not re.match) because wasm-pack often
      // embeds the done message inside an [INFO]: :-) prefix line.
      if (
        _reSearch(_ERROR_SIGNAL_RE, line) ||
        _reMatch(_WASMPACK_WARN_RE, line) ||
        _reSearch(_WASMPACK_DONE_RE, line) ||
        _reMatch(_WASMPACK_TEST_SUMMARY_RE, line) ||
        _reMatch(_WASMPACK_CARGO_FINISHED_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // [INFO] step announcements — drop (must come AFTER done check so
      // [INFO]: :-) Your wasm pkg is ready… is preserved above).
      if (_reMatch(_WASMPACK_INFO_RE, line)) {
        dropped_info += 1;
        continue;
      }
      // Cargo compiling/downloading dependency lines — drop.
      if (_reMatch(_WASMPACK_CARGO_COMPILING_RE, line)) {
        dropped_compiling += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_info, `dropped ${dropped_info} [INFO] step announcement lines`);
    _maybe_note(notes, dropped_compiling, `dropped ${dropped_compiling} Cargo dependency compile lines`);
    WasmPackFilter._emit_notes(kept, notes);
    return WasmPackFilter._finalize(kept);
  }
}

// ===========================================================================
// Cloudflare Wrangler regexes (Python lines ~21405-21487)
// ===========================================================================

// Wrangler asset upload progress lines — one per file, hundreds on large sites.
const _WRANGLER_ASSET_UPLOAD_RE: RegExp =
  /^\s*(?:\+\s+\/\S+\s+\(\d+\s+bytes?\)|Uploading\s+asset\s+\/\S+|Uploading\s+\d+\s+assets?\s+to\s+\S+|No\s+cached\s+assets\s+found\.\s+Uploading\s+all\s+\d+|Diff\s+result:\s+\d+\s+added|↑\s+\S+\s+\(\d+\s+bytes?\))/i;
// Wrangler "Skipping upload of asset" or "N assets already up to date" lines.
const _WRANGLER_ASSET_SKIP_RE: RegExp =
  /^\s*(?:Skipping\s+upload\s+of\s+asset\s+|\d+\s+assets?\s+(?:already\s+(?:up\s+to\s+date|uploaded)|unchanged)|All\s+\d+\s+assets?\s+are\s+already\s+up\s+to\s+date)/i;
// Wrangler build/bundle step noise.
const _WRANGLER_BUILD_STEP_RE: RegExp =
  /^\s*(?:Building\.\.\.|Bundling\s+with\s+esbuild|Checking\s+for\s+common\s+issues|Running\s+custom\s+build|Processing\s+dependencies|Minif(?:ying|ied)\s+|Wrote\s+script\s+to\s+\S+\.js\b)/i;
// Wrangler deploy/publish success and summary lines (always keep).
const _WRANGLER_SUMMARY_RE: RegExp =
  /^\s*(?:Published\s+\S+\s+\(|Deployed\s+\S+|Uploaded\s+\S+\s+\(|Total\s+Upload:|Current\s+Deployment\s+ID:|✨\s+Built\s+successfully|Your\s+worker\s+has\s+access|\d+\s+requests?\s+were\s+served|View\s+your\s+(?:worker|pages\s+site)\s+at\b|Success!?\s*$|Deployment\s+(?:complete|ready)|pages\.dev|workers\.dev)/i;
// Wrangler tail / dev session noise lines.
const _WRANGLER_DEV_NOISE_RE: RegExp =
  /^\s*\[(?:wrangler|mf):\w+\]\s+(?:Reloading\b|Worker\s+reloaded!|GET\s+|POST\s+|PUT\s+|PATCH\s+|DELETE\s+|OPTIONS\s+|HEAD\s+)/i;
// Wrangler KV / D1 / R2 bulk operation progress.
const _WRANGLER_BULK_PROGRESS_RE: RegExp =
  /^\s*(?:Inserting\s+\d+\s+rows|Processing\s+chunk\s+\d+\/\d+|Writing\s+\d+\s+key[s\/])/i;

/**
 * Compress Cloudflare ``wrangler deploy`` / ``publish`` / ``pages`` output.
 *
 * Wrangler emits one line per asset upload (hundreds for a Pages site), verbose
 * esbuild bundling steps, and deployment event chatter. Asset upload/skip and
 * bulk-op lines collapse to counts; build-step and dev-mode noise are dropped;
 * the final Published/Deployed summary and any errors are kept.
 */
export class WranglerFilter extends Filter {
  override error_passthrough = true;

  override name = "wrangler";
  override binaries: ReadonlySet<string> = new Set(["wrangler", "wrangler2"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let upload_count = 0;
    let skip_count = 0;
    let dropped_build = 0;
    let dropped_dev = 0;
    let bulk_count = 0;

    for (const line of lines) {
      // Error signals and summary lines — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_WRANGLER_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Asset upload lines — count.
      if (_reMatch(_WRANGLER_ASSET_UPLOAD_RE, line)) {
        upload_count += 1;
        continue;
      }
      // Asset-skip lines — count.
      if (_reMatch(_WRANGLER_ASSET_SKIP_RE, line)) {
        skip_count += 1;
        continue;
      }
      // Build step noise — drop.
      if (_reMatch(_WRANGLER_BUILD_STEP_RE, line)) {
        dropped_build += 1;
        continue;
      }
      // Dev-mode HTTP access / reload noise — drop.
      if (_reMatch(_WRANGLER_DEV_NOISE_RE, line)) {
        dropped_dev += 1;
        continue;
      }
      // Bulk operation progress — count.
      if (_reMatch(_WRANGLER_BULK_PROGRESS_RE, line)) {
        bulk_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (upload_count) {
      out.push(
        `[token-goat: ${upload_count} asset upload line(s) collapsed; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    if (skip_count) {
      out.push(`[token-goat: ${skip_count} asset-skip line(s) collapsed]`);
    }
    if (bulk_count) {
      out.push(`[token-goat: ${bulk_count} bulk-operation progress line(s) collapsed]`);
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, dropped_build, `dropped ${dropped_build} build-step noise line(s)`);
    _maybe_note(notes, dropped_dev, `dropped ${dropped_dev} dev-mode noise line(s)`);
    WranglerFilter._emit_notes(out, notes);
    return WranglerFilter._finalize(out);
  }
}

// ===========================================================================
// Hardhat regexes (Python lines ~21583-21656)
// ===========================================================================

// Hardhat compilation step: "Compiling X files with Solc 0.8.24"
const _HARDHAT_COMPILING_RE: RegExp =
  /^\s*Compiling\s+\d+\s+(?:file[s]?\s+with|Solidity\s+file[s]?)/i;
// Hardhat "Solc ... finished in Ns" per-compiler-version progress.
const _HARDHAT_SOLC_FINISHED_RE: RegExp = /^\s*Solc\s+\S+\s+finished\s+in\s+\d/i;
// Hardhat deployment transaction receipt noise.
const _HARDHAT_TX_NOISE_RE: RegExp =
  /^\s*(?:deployer:|Deployment\s+transaction:|Gas\s+used:\s+\d|Transaction\s+hash:\s+0x|Block\s+(?:number|hash):|Nonce:\s+\d|Value:\s+\d|From:\s+0x|To:\s+0x|Contract\s+address:\s+0x\w{40}\s*$)/i;
// Hardhat test framework output — passing test lines.
const _HARDHAT_PASS_TEST_RE: RegExp = /^\s+(?:✓|✔|√)\s+/;
// Hardhat test summary (always keep).
const _HARDHAT_TEST_SUMMARY_RE: RegExp = /^\s*\d+\s+(?:passing|failing|pending)\b/i;
// Hardhat failure block header (always keep).
const _HARDHAT_FAILURE_RE: RegExp =
  /^\s*(?:\d+\s+failing\b|AssertionError:|Error:|expected\s+)/i;
// Hardhat "Compilation finished successfully" or "Nothing to compile".
const _HARDHAT_COMPILE_DONE_RE: RegExp =
  /^\s*(?:Compilation\s+finished\s+successfully|Nothing\s+to\s+compile|Compiled\s+\d+\s+Solidity\s+file|No\s+need\s+to\s+generate\s+any\s+compiler)/i;
// Hardhat warnings about compiler settings (keep — actionable).
const _HARDHAT_WARN_RE: RegExp =
  /^\s*(?:HardhatError:|HardhatWarning:|Warning:|ProviderError:|Duplicate\s+definition\s+of\b)/i;
// Hardhat network/deployment header lines (keep — high value).
const _HARDHAT_DEPLOY_HEADER_RE: RegExp =
  /^\s*(?:Deploying\s+\w|\w[\w\s]*\s+deployed\s+to:\s+0x|Running\s+\S+\.(?:ts|js)\b|Network:\s+\w|Deploying\s+contracts\s+with\s+the\s+account)/i;

/**
 * Compress Hardhat Ethereum development framework output.
 *
 * ``npx hardhat compile`` emits many "Compiling N files with Solc 0.8.x" lines;
 * ``npx hardhat test`` emits one line per passing test (often 100+); deployment
 * scripts emit verbose transaction receipts. Compilation / Solc-timing / passing
 * tests collapse to counts; tx receipts drop; summary / failure / warning /
 * deploy-header lines are always kept.
 */
export class HardhatFilter extends Filter {
  override error_passthrough = true;

  override name = "hardhat";
  override binaries: ReadonlySet<string> = new Set(["hardhat"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let compiling_count = 0;
    let solc_timing_count = 0;
    let pass_count = 0;
    let tx_noise_count = 0;

    for (const line of lines) {
      // Error signals, warnings, failure headers — always keep.
      if (
        _reSearch(_ERROR_SIGNAL_RE, line) ||
        _reMatch(_HARDHAT_FAILURE_RE, line) ||
        _reMatch(_HARDHAT_WARN_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Compilation done / deploy header / test summary — always keep.
      if (
        _reMatch(_HARDHAT_COMPILE_DONE_RE, line) ||
        _reMatch(_HARDHAT_DEPLOY_HEADER_RE, line) ||
        _reMatch(_HARDHAT_TEST_SUMMARY_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Compiling step lines — count.
      if (_reMatch(_HARDHAT_COMPILING_RE, line)) {
        compiling_count += 1;
        continue;
      }
      // Solc per-version timing — count.
      if (_reMatch(_HARDHAT_SOLC_FINISHED_RE, line)) {
        solc_timing_count += 1;
        continue;
      }
      // Passing test lines — count.
      if (_reMatch(_HARDHAT_PASS_TEST_RE, line)) {
        pass_count += 1;
        continue;
      }
      // Transaction receipt noise — drop.
      if (_reMatch(_HARDHAT_TX_NOISE_RE, line)) {
        tx_noise_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (compiling_count) {
      out.push(
        `[token-goat: collapsed ${compiling_count} Solidity compilation step line(s); ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    if (solc_timing_count) {
      out.push(`[token-goat: collapsed ${solc_timing_count} Solc per-version timing line(s)]`);
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing test line(s)`);
    _maybe_note(notes, tx_noise_count, `dropped ${tx_noise_count} transaction receipt noise line(s)`);
    HardhatFilter._emit_notes(out, notes);
    return HardhatFilter._finalize(out);
  }
}

// ===========================================================================
// Serverless Framework regexes (Python lines ~21756-21818)
// ===========================================================================

// Serverless "Serverless: Packaging service..." and step progress lines.
const _SLS_STEP_PROGRESS_RE: RegExp =
  /^\s*Serverless:\s+(?:Packaging\s+service|Excluding\s+development\s+dependencies|Creating\s+Stack\.\.\.|Checking\s+Stack\s+create\s+progress|Stack\s+create\s+finished|Uploading\s+CloudFormation\s+file\s+to\s+S3|Uploading\s+artifacts|Uploading\s+service\s+\S+\.zip\s+file\s+to\s+S3|Validating\s+template|Updating\s+Stack\.\.\.|Checking\s+Stack\s+update\s+progress|Stack\s+update\s+finished|Executing\s+Changeset|Removing\s+old\s+service\s+artifacts\s+from\s+S3)/i;
// Serverless CloudFormation stack event lines — IN_PROGRESS (drop).
const _SLS_CF_IN_PROGRESS_RE: RegExp =
  /^\s*(?:AWS::|ServerlessDeployment).*_IN_PROGRESS\s*$|^\s+\w+_IN_PROGRESS\s+(?:AWS::|ServerlessDeployment)/;
// Serverless CloudFormation COMPLETE event lines (keep).
const _SLS_CF_COMPLETE_RE: RegExp =
  /^\s*(?:AWS::|ServerlessDeployment).*_COMPLETE\s*$|^\s+(?:CREATE|UPDATE|DELETE|REPLACE|ROLLBACK)_COMPLETE\s+/;
// Serverless CloudFormation FAILED event lines (keep).
const _SLS_CF_FAILED_RE: RegExp = /\w+_FAILED\s+/;
// Serverless "Service Information" section header and endpoint/function lines.
const _SLS_SERVICE_INFO_RE: RegExp =
  /^\s*(?:Service\s+Information|service:\s+\S|stage:\s+\S|region:\s+\S|stack:\s+\S|resources:|api\s+keys:|endpoints:|functions:|layers:|ANY\s+-\s+https:\/\/|GET\s+-\s+https:\/\/|POST\s+-\s+https:\/\/|PUT\s+-\s+https:\/\/|DELETE\s+-\s+https:\/\/|Serverless:\s+Stack\s+Tags|Serverless:\s+Invoke\s+|Serverless:\s+(?:Done!|WARNING:|ERROR:))/i;
// Serverless final deploy summary (always keep).
const _SLS_SUMMARY_RE: RegExp =
  /^\s*(?:Service\s+deployed\s+to\s+stack\s+|✔\s+Service\s+deployed|Serverless:\s+Run\s+the\s+'serverless|Deployed\s+functions:|Stack\s+Outputs\b)/i;
// Serverless dotted progress / "." dot lines emitted during CF polling.
const _SLS_DOT_PROGRESS_RE: RegExp = /^\s*\.+\s*$/;
// Serverless "Serverless: ......." tick lines during polling.
const _SLS_TICK_RE: RegExp = /^\s*Serverless:\s+\.+\s*$/;

/**
 * Compress Serverless Framework ``deploy`` / ``info`` / ``invoke`` output.
 *
 * The Serverless Framework CLI emits verbose CloudFormation stack event lines,
 * upload step announcements, and polling dots. Step progress collapses to a
 * count; CF IN_PROGRESS events + dot/tick progress drop; CF COMPLETE / FAILED,
 * service-info, summary, and error lines are always kept.
 */
export class ServerlessFilter extends Filter {
  override error_passthrough = true;

  override name = "serverless";
  override binaries: ReadonlySet<string> = new Set(["serverless", "sls"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let step_count = 0;
    let in_progress_count = 0;
    let dot_count = 0;

    for (const line of lines) {
      // Error signals and CF failure events — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reSearch(_SLS_CF_FAILED_RE, line)) {
        kept.push(line);
        continue;
      }
      // Service info / summary lines — always keep.
      if (
        _reMatch(_SLS_SERVICE_INFO_RE, line) ||
        _reMatch(_SLS_SUMMARY_RE, line) ||
        _reMatch(_SLS_CF_COMPLETE_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Step progress lines — count.
      if (_reMatch(_SLS_STEP_PROGRESS_RE, line)) {
        step_count += 1;
        continue;
      }
      // CF IN_PROGRESS event lines — drop.
      if (_reMatch(_SLS_CF_IN_PROGRESS_RE, line)) {
        in_progress_count += 1;
        continue;
      }
      // Dot / tick progress — drop.
      if (_reMatch(_SLS_DOT_PROGRESS_RE, line) || _reMatch(_SLS_TICK_RE, line)) {
        dot_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (step_count) {
      out.push(
        `[token-goat: collapsed ${step_count} Serverless deploy step line(s); ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, in_progress_count, `dropped ${in_progress_count} CF _IN_PROGRESS event line(s)`);
    _maybe_note(notes, dot_count, `dropped ${dot_count} polling dot line(s)`);
    ServerlessFilter._emit_notes(out, notes);
    return ServerlessFilter._finalize(out);
  }
}
