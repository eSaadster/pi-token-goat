/**
 * bash_compress LANG / PKG / AUTOMATION FILTERS — TypeScript port of the
 * Ansible / PreCommit / Pip / Gem / Uv / Conda Filter subclasses from
 * src/token_goat/bash_compress.py.
 *
 * Six filters subclass the concrete Filter base from ./framework.js:
 *   - AnsibleFilter  — `ansible` / `ansible-playbook` / `ansible-pull` /
 *                      `ansible-console` / `ansible-galaxy` / `ansible-lint`.
 *                      Dispatches on argv[0] binary name: lint / galaxy /
 *                      playbook each have their own compressor. Overrides
 *                      compress() only (default binaries-based matches()).
 *   - PreCommitFilter — `pre-commit` (collapse Passed/Skipped, keep Failed
 *                       blocks + [INFO] env-setup chatter dropped after first).
 *   - PipFilter      — `pip` / `pip3` / `pipx` install (drop download/cache/
 *                      build-wheel noise, cap Collecting at 5, keep errors).
 *   - GemFilter      — `gem` install/update/upgrade (drop Fetching + doc lines,
 *                      collapse Successfully-installed block; other subcommands
 *                      cap at 1000 tokens). Reads positionals to dispatch.
 *   - UvFilter       — `uv` sync/add/remove/pip/lock/tool/python (drop
 *                      Downloading/Fetching + +/- diff lines; pip freeze/list
 *                      head/count). Overrides matches() (subcommand gating).
 *   - CondaFilter    — `conda` / `mamba` / `micromamba` install/create/list/env
 *                      (phase headers kept, download/pkg lines collapsed; list +
 *                      env export head/count). Overrides matches().
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress, _compress_ansible_playbook,
 *    _compress_ansible_lint, _compress_ansible_galaxy, _compress_freeze_list,
 *    _compress_install, _compress_pkg_list, _compress_env_export); snake_case
 *    module-private regex constants (_ANSIBLE_*, _PRECOMMIT_*, _PIP_*, _GEM_*,
 *    _UV_*, _CONDA_*).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). .search() -> _reSearch
 *    (non-global clone, .exec anywhere). Named capture groups read via
 *    _reMatchObj.groups (the (?P<name>...) groups become (?<name>...) in TS).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel export* chain.
 *  - PythonFilter (which sits between GemFilter and UvFilter in the Python
 *    source) is NOT ported here — it already ships in framework.ts.
 *  - Path(argv[0]).name.lower() -> local _pathNameLower (final path component,
 *    after backslash norm, lowercased) for AnsibleFilter's binary dispatch.
 *  - _maybe_note / cap_tokens / _collapse_to_count / _keep_errors_verbatim are
 *    framework-PUBLIC and imported. _combine_output is an INSTANCE method;
 *    _finalize / _emit_notes are STATIC methods on Filter.
 *  - Python list slice-assignment `kept[i:i] = collapsed` (GemFilter success
 *    splice) -> Array.prototype.splice(i, 0, ...collapsed).
 *  - Python str.endswith("{") on rstrip() -> .trimEnd().endsWith("{").
 *  - Module-global mutable state: NONE. Every counter/dict/list is a local inside
 *    compress()/helpers; no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - ansible      : binaries {ansible, ansible-playbook, ansible-pull,
 *                   ansible-console, ansible-galaxy, ansible-lint}; any subcommand.
 *  - pre-commit   : binaries {pre-commit}; any subcommand.
 *  - pip          : binaries {pip, pip3, pipx}; any subcommand.
 *  - gem          : binaries {gem}; any subcommand (install/update/upgrade get
 *                   the full compressor, everything else caps at 1000 tokens).
 *  - uv           : binaries {uv}; gated to sync/add/remove/install/uninstall/
 *                   pip/lock, plus `uv tool {install,upgrade,uninstall,update}`
 *                   and `uv python {install,pin}` (overridden matches()).
 *  - conda        : binaries {conda, mamba, micromamba}; bare invocation OR
 *                   subcommand in {install, create, update, upgrade, remove,
 *                   uninstall, list, env} (overridden matches()).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  _collapse_to_count,
  _keep_errors_verbatim,
  _maybe_note,
  _positional_args,
  cap_tokens,
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
 * Python re.Pattern.match(line) returning the match object (or null) for the
 * callers that read capture groups. Non-global clone so lastIndex never leaks;
 * index===0 enforces the START-anchored semantics of .match().
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0 ? m : null;
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

// ===========================================================================
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Ansible regexes (Python ~9546-9585).
// ===========================================================================

/**
 * Ansible task status lines: `ok: [host]` / `changed: [host] => (item=...)` /
 * `skipping: [host]` / `fatal: [host]: FAILED!`.
 */
const _ANSIBLE_STATUS_RE: RegExp = /^(ok|changed|skipping|skipped|included):\s*\[/;
/** Ansible PLAY / TASK / HANDLER section headers (e.g. `TASK [Install nginx]`). */
const _ANSIBLE_HEADER_RE: RegExp =
  /^(PLAY|TASK|HANDLER|RUNNING HANDLER|META)(?:\s*\[|\s*RECAP)/;
/** Ansible final `PLAY RECAP` block delimiter. */
const _ANSIBLE_RECAP_RE: RegExp = /^PLAY RECAP/;
/** Ansible failure / error / unreachable / warning signal. */
const _ANSIBLE_FAIL_RE: RegExp = /^(fatal|failed|unreachable|FAILED|ERROR|\[WARNING\]):/;
/** Ansible-lint rule code pattern (modern format). */
const _ANSIBLE_LINT_RULE_RE: RegExp = /^[a-z0-9][a-z0-9\-]*(?:\[[a-z0-9_\-]+\])?:\s+/;
/** Ansible-lint legacy line: `path.yml:line:col: rule-name: message`. */
const _ANSIBLE_LINT_LEGACY_RE: RegExp =
  /^\.?[^:\s]+\.ya?ml:\d+:\d+:\s+[a-z0-9][a-z0-9\-]*(?:\[[a-z0-9_\-]+\])?:/;

// ===========================================================================
// AnsibleFilter (Python ~9588-9823)
// ===========================================================================

/**
 * Compress `ansible` / `ansible-playbook` / `ansible-galaxy` / `ansible-lint`
 * output.
 *
 * Playbook runs emit one `ok: [host]` (or `changed:`/`skipping:`) line per
 * (task × host); on a 30-host inventory with 50 tasks this is 1500 progress
 * lines for a fully-successful run. The signal lives in PLAY/TASK headers, any
 * `fatal:` / `failed:` / `unreachable:` / `[WARNING]` lines, and the final
 * `PLAY RECAP` block.
 *
 * `ansible-galaxy install` -> head=5, tail=5. `ansible-lint` -> group by rule
 * code, keep first 3 examples per rule.
 */
export class AnsibleFilter extends Filter {
  override name = "ansible";
  override binaries: ReadonlySet<string> = new Set([
    "ansible",
    "ansible-playbook",
    "ansible-pull",
    "ansible-console",
    "ansible-galaxy",
    "ansible-lint",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    // Detect the binary name from argv[0].
    const binary_name = argv.length > 0 ? _pathNameLower(argv[0]!) : "";

    // ansible-lint has its own compression.
    if (binary_name.includes("ansible-lint")) {
      return this._compress_ansible_lint(stdout, stderr);
    }

    // ansible-galaxy has a simpler compression (head/tail).
    if (binary_name.includes("ansible-galaxy")) {
      return this._compress_ansible_galaxy(stdout, stderr);
    }

    // Default: ansible, ansible-playbook, ansible-pull compression.
    return this._compress_ansible_playbook(stdout, stderr, argv);
  }

  /** Compress ansible-playbook output: collapse status lines, keep headers & recap. */
  _compress_ansible_playbook(stdout: string, stderr: string, argv?: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    // Pending status counts for the current task.
    const status_counts = new Map<string, number>();
    let in_recap = false;
    let in_fail_payload = false;
    let in_success_payload = false; // suppress verbose => {} JSON blocks after ok/changed/skipped
    let brace_depth = 0;
    const payload_elided: [number] = [0]; // per-task count of suppressed verbose payloads

    const flush_status = (): void => {
      if (status_counts.size === 0) {
        return;
      }
      const parts: string[] = [];
      for (const [label, nn] of status_counts) {
        if (nn) {
          parts.push(`${nn} ${label}`);
        }
      }
      if (parts.length > 0) {
        let note = parts.join(", ");
        if (payload_elided[0]) {
          note += `, ${payload_elided[0]} verbose payload${payload_elided[0] !== 1 ? "s" : ""} elided`;
        }
        kept.push(`[token-goat: ${note}]`);
      }
      status_counts.clear();
      payload_elided[0] = 0;
    };

    // Annotate dry-run mode so the reader knows no actual changes were applied.
    if (argv && (argv.includes("--check") || argv.includes("-C"))) {
      kept.push("[token-goat: ansible-playbook --check (dry run — no actual changes)]");
    }

    for (const line of lines) {
      if (_reMatch(_ANSIBLE_RECAP_RE, line)) {
        flush_status();
        in_recap = true;
        in_fail_payload = false;
        in_success_payload = false;
        kept.push(line);
        continue;
      }
      if (in_recap) {
        // Preserve PLAY RECAP block verbatim until a blank line ends it.
        kept.push(line);
        if (line.trim() === "") {
          in_recap = false;
        }
        continue;
      }
      if (_reMatch(_ANSIBLE_FAIL_RE, line)) {
        flush_status();
        in_fail_payload = true;
        in_success_payload = false;
        kept.push(line);
        continue;
      }
      if (in_fail_payload) {
        // The block ends at the next blank line or a new TASK/PLAY header.
        if (line.trim() === "" || _reMatch(_ANSIBLE_HEADER_RE, line)) {
          in_fail_payload = false;
          if (line.trim() === "") {
            kept.push(line);
            continue;
          }
        } else {
          kept.push(line);
          continue;
        }
      }
      // Suppress verbose JSON payloads that follow ok/changed/skipped status lines.
      if (in_success_payload) {
        if (
          _reMatch(_ANSIBLE_HEADER_RE, line) ||
          _reMatch(_ANSIBLE_FAIL_RE, line) ||
          _reMatch(_ANSIBLE_RECAP_RE, line)
        ) {
          // Structural boundary: exit payload mode and fall through to normal handling.
          in_success_payload = false;
          brace_depth = 0;
        } else {
          brace_depth += _countChar(line, "{") - _countChar(line, "}");
          if (brace_depth <= 0) {
            in_success_payload = false;
            brace_depth = 0;
          }
          continue;
        }
      }
      if (_reMatch(_ANSIBLE_HEADER_RE, line)) {
        flush_status();
        in_success_payload = false;
        kept.push(line);
        continue;
      }
      if (_reMatch(_ANSIBLE_STATUS_RE, line)) {
        const label = _splitOnce(line, ":")[0].trim();
        status_counts.set(label, (status_counts.get(label) ?? 0) + 1);
        // If the status line ends with `{`, the following lines are a verbose JSON payload.
        if (_rstrip(line).endsWith("{")) {
          in_success_payload = true;
          brace_depth = 1;
          payload_elided[0] += 1;
        }
        continue;
      }
      kept.push(line);
    }
    flush_status();
    return Filter._finalize(kept);
  }

  /**
   * Compress ansible-lint output: group violations by rule, keep first 3 per
   * rule. Handles both modern (>= 6) and legacy (< 6) formats.
   */
  _compress_ansible_lint(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    /** Extract the rule code from a modern or legacy violation line. */
    const _rule_code = (line: string): string | null => {
      // Modern: ``yaml[line-length]: ./file.yml:10:80: …``
      if (_reMatch(_ANSIBLE_LINT_RULE_RE, line)) {
        return _splitOnce(line, ":")[0].trim();
      }
      // Legacy: ``./file.yml:10:1: rule-name: …``
      if (_reMatch(_ANSIBLE_LINT_LEGACY_RE, line)) {
        // The rule code sits after the col-number: segment.
        // Format is ``path:line:col: rule-code: message``
        const parts = _splitN(line, ":", 4);
        if (parts.length >= 4) {
          return parts[3]!.trim();
        }
      }
      return null;
    };

    // First pass: classify lines and group violations by rule code.
    const non_violations: string[] = [];
    const by_rule = new Map<string, string[]>();
    const rule_order: string[] = []; // insertion-order tracking

    for (const line of lines) {
      const code = _rule_code(line);
      if (code !== null) {
        let bucket = by_rule.get(code);
        if (bucket === undefined) {
          bucket = [];
          by_rule.set(code, bucket);
          rule_order.push(code);
        }
        bucket.push(line);
      } else {
        non_violations.push(line);
      }
    }

    if (by_rule.size === 0) {
      // No violations classified — pass through as-is.
      return Filter._finalize(lines);
    }

    // Second pass: build output. Violations grouped by rule (insertion order)
    // then non-violations.
    const kept: string[] = [];
    for (const code of rule_order) {
      const rule_lines = by_rule.get(code)!;
      kept.push(...rule_lines.slice(0, 3));
      const extra = rule_lines.length - 3;
      if (extra > 0) {
        kept.push(
          `[token-goat: ${extra} more occurrence${extra !== 1 ? "s" : ""} ` +
            `of ${code} elided]`,
        );
      }
    }
    // Append non-violation lines (summary, blank lines, headers).
    kept.push(...non_violations);

    return Filter._finalize(kept);
  }

  /** Compress ansible-galaxy output: head=5, tail=5 for install progress. */
  _compress_ansible_galaxy(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const non_empty = merged.split("\n").filter((ln) => ln.trim() !== "");
    if (non_empty.length > 10) {
      return _head_tail_compress_local(non_empty, 5, 5, "galaxy lines");
    }
    return non_empty.join("\n");
  }
}

// ===========================================================================
// pre-commit (Python ~9826-9917)
// ===========================================================================

/**
 * pre-commit hook-result line: `Trim trailing whitespace.....................Passed`.
 *
 * Also handles the `hook_name...(no files to check)Skipped` variant where
 * pre-commit interpolates a parenthetical reason between the dot leader and the
 * status word.
 */
const _PRECOMMIT_RESULT_RE: RegExp =
  /^(?<hook>\S.*?)\.{3,}(?:\([^)]*\))?\s*(?<status>Passed|Failed|Skipped|Pre-commit hook failed)\s*$/;
/** pre-commit install/lifecycle progress lines (`[INFO] Initializing environment...`). */
const _PRECOMMIT_INFO_RE: RegExp = /^\[INFO\]\s+(Initializing|Installing|Restored|Cloning)/;

/**
 * Compress `pre-commit run` output.
 *
 * `pre-commit run --all-files` on a large repo emits one `hook_name.....` line
 * per hook, plus `[INFO]` environment-setup chatter, plus the full hook
 * stdout/stderr for every failed hook. Passing hooks are pure noise once the
 * run is green.
 */
export class PreCommitFilter extends Filter {
  override name = "pre-commit";
  override binaries: ReadonlySet<string> = new Set(["pre-commit"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let passed = 0;
    let skipped = 0;
    let info_dropped = 0;
    let first_info_kept = false;
    let in_fail_block = false;
    for (const line of lines) {
      const m = _reMatchObj(_PRECOMMIT_RESULT_RE, line);
      if (m) {
        const status = m.groups!["status"]!;
        if (status === "Failed" || status === "Pre-commit hook failed") {
          if (passed || skipped) {
            kept.push(
              `[token-goat: collapsed ${passed} Passed, ` +
                `${skipped} Skipped hook(s)]`,
            );
            passed = 0;
            skipped = 0;
          }
          in_fail_block = true;
          kept.push(line);
          continue;
        }
        in_fail_block = false;
        if (status === "Passed") {
          passed += 1;
        } else if (status === "Skipped") {
          skipped += 1;
        }
        continue;
      }
      if (_reMatch(_PRECOMMIT_INFO_RE, line)) {
        if (first_info_kept) {
          info_dropped += 1;
          continue;
        }
        first_info_kept = true;
        kept.push(line);
        continue;
      }
      // End of an indented failure block: a blank line.
      if (in_fail_block && line.trim() === "") {
        in_fail_block = false;
      }
      kept.push(line);
    }
    if (passed || skipped) {
      kept.push(`[token-goat: collapsed ${passed} Passed, ${skipped} Skipped hook(s)]`);
    }
    if (info_dropped) {
      kept.push(`[token-goat: dropped ${info_dropped} pre-commit [INFO] env-setup lines]`);
    }
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// pip / uv / poetry regexes (Python ~10263-10274)
// ===========================================================================

/** pip -v/-vv verbose debug lines: "DEBUG pip._internal...: ...". */
const _PIP_VERBOSE_DEBUG_RE: RegExp = /^(?:DEBUG|VERBOSE|TRACE)\b/;
/** pip -v HTTP/network trace lines. */
const _PIP_VERBOSE_HTTP_RE: RegExp =
  /^\s+(?:https?:\/\/|Added \S+ to |Querying |Checking if link|Created temporary directory|Looking up|Skipping link|Local version label|File was already downloaded|\d+ location\(s\) for)\b/;

// ===========================================================================
// PipFilter (Python ~10277-10373)
// ===========================================================================

/**
 * Compress `pip install` / `uv pip install` / `poetry install` output.
 *
 * Pip emits `Downloading X.whl (10 MB)` lines per dependency plus the final
 * `Successfully installed` list. When everything succeeds the interesting line
 * is just the final tally. Drops download/cache/build-wheel noise, caps
 * Collecting at 5, keeps every error/warning line verbatim. Verbose mode (`-v`)
 * also drops DEBUG/VERBOSE/TRACE log lines and HTTP-trace chatter.
 */
export class PipFilter extends Filter {
  override name = "pip";
  override binaries: ReadonlySet<string> = new Set(["pip", "pip3", "pipx"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const verbose =
      argv.includes("-v") ||
      argv.includes("--verbose") ||
      argv.some(
        (a) =>
          a.startsWith("-") &&
          a.startsWith("-v") &&
          [...a.slice(1)].every((c) => c === "v"),
      );
    const kept: string[] = [];
    let downloads = 0;
    let build_noise = 0;
    let collects = 0;
    let verbose_dropped = 0;
    for (const line of lines) {
      // Always preserve error/warning lines even in verbose mode.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Verbose-mode extra noise: DEBUG/VERBOSE/TRACE log lines and HTTP trace.
      if (verbose && (_reMatch(_PIP_VERBOSE_DEBUG_RE, line) || _reMatch(_PIP_VERBOSE_HTTP_RE, line))) {
        verbose_dropped += 1;
        continue;
      }
      // Download progress (pip < 22 uses 2-space indent, newer uses no indent).
      if (line.startsWith("  Downloading ") || line.startsWith("Downloading ")) {
        downloads += 1;
        continue;
      }
      // Wheel cache hits — zero value for the model.
      if (line.startsWith("  Using cached ") || line.startsWith("Using cached ")) {
        downloads += 1; // count alongside downloads (all are "fetch noise")
        continue;
      }
      // Build-wheel lifecycle noise.
      if (
        line.startsWith("  Building wheel") ||
        line.startsWith("Building wheel") ||
        line.startsWith("  Created wheel") ||
        line.startsWith("Created wheel") ||
        line.startsWith("  Stored in directory") ||
        line.startsWith("Stored in directory") ||
        line.startsWith("  Installing build dep") ||
        line.startsWith("Installing build dep") ||
        line.startsWith("  Preparing metadata") ||
        line.startsWith("Preparing metadata") ||
        line.startsWith("  Getting requirements") ||
        line.startsWith("Getting requirements") ||
        line.startsWith("  Obtaining file://") ||
        line.startsWith("Obtaining file://") ||
        line.startsWith("Installing collected packages") ||
        line.startsWith("  Installing collected packages")
      ) {
        build_noise += 1;
        continue;
      }
      // Unicode box-drawing progress bar lines emitted by pip >= 22 when
      // capturing stderr: "   ━━━━━━━━ 862.6/862.6 kB 5.2 MB/s eta 0:00:00"
      if (line.includes("━") && !_reSearch(_ERROR_SIGNAL_RE, line)) {
        downloads += 1;
        continue;
      }
      if (line.startsWith("Collecting ") || line.startsWith("  Collecting ")) {
        collects += 1;
        if (collects <= 5) {
          kept.push(line);
        }
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    if (collects > 5) {
      notes.push(`+${collects - 5} more 'Collecting' lines elided`);
    }
    _maybe_note(notes, downloads, `dropped ${downloads} download/cache-hit lines`);
    _maybe_note(notes, build_noise, `dropped ${build_noise} build-wheel/metadata lines`);
    _maybe_note(notes, verbose_dropped, `dropped ${verbose_dropped} verbose debug/trace lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// gem regexes (Python ~10379-10395)
// ===========================================================================

/** gem Fetching progress lines: "Fetching rails-7.1.3.4.gem". */
const _GEM_FETCH_RE: RegExp = /^Fetching\s+\S+\s*$/;
/** gem documentation build lines. */
const _GEM_DOC_RE: RegExp =
  /^(?:Parsing documentation for|Installing ri documentation for|Done installing documentation for)\s+/;
/** gem "Successfully installed X-Y.Z" lines. */
const _GEM_SUCCESS_RE: RegExp = /^Successfully installed\s+\S/;
/** gem error / permission-denied lines not caught by _ERROR_SIGNAL_RE. */
const _GEM_ERROR_RE: RegExp =
  /^(?:ERROR:|Gem::|You don't have write permissions|gem:)/i;

// ===========================================================================
// GemFilter (Python ~10398-10491)
// ===========================================================================

/**
 * Compress `gem install` / `gem update` output.
 *
 * RubyGems emits one line per package for fetch progress, documentation
 * generation, and installation. Installing a gem with many transitive deps
 * routinely produces 60–120 lines of noise. install/update: drop Fetching +
 * documentation lines, collapse Successfully-installed lines to head-2 + tail-1
 * when >= 5 gems. Other subcommands cap at 1000 tokens.
 */
export class GemFilter extends Filter {
  override name = "gem";
  override binaries: ReadonlySet<string> = new Set(["gem"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    if (subcommand !== "install" && subcommand !== "update" && subcommand !== "upgrade") {
      return cap_tokens(merged, 1000);
    }

    const lines = merged.split("\n");
    const kept: string[] = [];
    let fetching = 0;
    let doc_noise = 0;
    const success_lines: string[] = [];
    let success_insert_idx = -1; // kept-index where first success line appeared

    for (const line of lines) {
      // Always preserve error/warning signals.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_GEM_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Fetching progress: "Fetching rails-7.1.3.4.gem"
      if (_reMatch(_GEM_FETCH_RE, line)) {
        fetching += 1;
        continue;
      }
      // Documentation build noise: Parsing / Installing ri / Done installing
      if (_reMatch(_GEM_DOC_RE, line)) {
        doc_noise += 1;
        continue;
      }
      // Successfully installed: collect separately for collapse; record the
      // insertion point so later summary lines keep their correct position.
      if (_reMatch(_GEM_SUCCESS_RE, line)) {
        if (success_insert_idx < 0) {
          success_insert_idx = kept.length;
        }
        success_lines.push(line);
        continue;
      }
      kept.push(line);
    }

    // Build collapsed success block and splice it in at the original position.
    if (success_lines.length > 0) {
      let collapsed: string[];
      if (success_lines.length <= 4) {
        collapsed = [...success_lines];
      } else {
        const elided = success_lines.length - 3;
        collapsed = [
          ...success_lines.slice(0, 2),
          `... (${elided} more installed) ...`,
          success_lines[success_lines.length - 1]!,
        ];
      }
      const insert_at = success_insert_idx >= 0 ? success_insert_idx : kept.length;
      kept.splice(insert_at, 0, ...collapsed);
    }

    const notes: string[] = [];
    _maybe_note(notes, fetching, `dropped ${fetching} Fetching line${fetching !== 1 ? "s" : ""}`);
    _maybe_note(notes, doc_noise, `dropped ${doc_noise} documentation line${doc_noise !== 1 ? "s" : ""}`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// uv regexes (Python ~10696-10702)
// ===========================================================================

/** uv per-package download/fetch progress lines: "   Downloading foo-1.0 (2.3 MB)". */
const _UV_DOWNLOAD_RE: RegExp = /^\s*(Downloading|Downloaded|Fetching)\s+\S/;
/** uv per-package install/uninstall diff lines: "   + foo==1.0" / "   - foo==1.0". */
const _UV_DIFF_LINE_RE: RegExp = /^\s+[+\-]\s+\S/;

// ===========================================================================
// UvFilter (Python ~10705-10811)
// ===========================================================================

/**
 * Compress `uv sync` / `uv add` / `uv remove` / `uv pip` / `uv tool` output.
 *
 * uv emits verbose per-package `Downloading` / `Fetching` lines plus per-package
 * `+`/`-` diff lines. The interesting lines are the end summary lines (Resolved,
 * Installed, Uninstalled, Audited). Errors and warnings always preserved.
 */
export class UvFilter extends Filter {
  override name = "uv";
  override binaries: ReadonlySet<string> = new Set(["uv"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    if (stem !== "uv") {
      return false;
    }
    const positionals = argv.slice(1).filter((tok) => !tok.startsWith("-"));
    if (positionals.length === 0) {
      return false;
    }
    const first = positionals[0]!;
    // Direct package-management subcommands of ``uv``.
    const pm_subcommands: ReadonlySet<string> = new Set([
      "sync",
      "add",
      "remove",
      "install",
      "uninstall",
      "pip",
      "lock",
    ]);
    if (pm_subcommands.has(first)) {
      return true;
    }
    // ``uv tool <action>`` — install/upgrade/uninstall emit the same noise.
    // Exclude ``uv tool run`` (handled by prefix-stripping + inner-tool filter).
    if (first === "tool" && positionals.length >= 2) {
      const tool_action = positionals[1]!;
      return (
        tool_action === "install" ||
        tool_action === "upgrade" ||
        tool_action === "uninstall" ||
        tool_action === "update"
      );
    }
    // ``uv python install`` / ``uv python pin`` — may emit interpreter download progress.
    if (first === "python" && positionals.length >= 2) {
      const python_action = positionals[1]!;
      return python_action === "install" || python_action === "pin";
    }
    return false;
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    // Detect freeze/list subcommands: ``uv pip freeze`` / ``uv pip list``
    const positionals = argv.slice(1).filter((tok) => !tok.startsWith("-"));
    const is_freeze_or_list =
      positionals.length >= 2 &&
      positionals[0] === "pip" &&
      (positionals[1] === "freeze" || positionals[1] === "list");
    const merged = this._combine_output(stdout, stderr);
    if (is_freeze_or_list) {
      return this._compress_freeze_list(merged);
    }
    const lines = merged.split("\n");
    const kept: string[] = [];
    let downloads = 0;
    let diff_lines = 0;
    for (const line of lines) {
      if (_reMatch(_UV_DOWNLOAD_RE, line)) {
        downloads += 1;
        continue;
      }
      if (_reMatch(_UV_DIFF_LINE_RE, line)) {
        diff_lines += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, downloads, `dropped ${downloads} Downloading/Fetching progress lines`);
    _maybe_note(notes, diff_lines, `dropped ${diff_lines} per-package +/- diff lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /**
   * Compress `uv pip freeze` / `uv pip list` output. When the list exceeds 50
   * package lines, keep the first 20 and append a count summary. Error lines are
   * always preserved verbatim.
   */
  _compress_freeze_list(text: string): string {
    const lines = text.split("\n").filter((ln) => ln.trim() !== "");
    // Preserve error lines regardless of list length.
    const [error_lines, pkg_lines] = _keep_errors_verbatim(lines);
    const _UV_FREEZE_THRESHOLD = 50;
    const _UV_FREEZE_SHOW = 20;
    if (pkg_lines.length <= _UV_FREEZE_THRESHOLD) {
      return _rstrip(text);
    }
    const shown = pkg_lines.slice(0, _UV_FREEZE_SHOW);
    const tail = pkg_lines.slice(_UV_FREEZE_SHOW);
    const collapsed = _collapse_to_count(tail, "package");
    const result = [...shown, ...collapsed];
    if (error_lines.length > 0) {
      result.push(...error_lines);
    }
    return result.join("\n");
  }
}

// ===========================================================================
// conda regexes (Python ~10817-10830)
// ===========================================================================

/** Conda download/extract progress bar lines. */
const _CONDA_DOWNLOAD_RE: RegExp =
  /^\s*(?:[A-Za-z0-9_\-.]+-[\d.]+\s+\||\[[-#\s]+\]|\d+%|\d+\s*(?:KB|MB|kB|B)\/s|Downloading and Extracting Packages:)/;
/** Conda individual package install lines: "  - pkgname version build". */
const _CONDA_PKG_INSTALL_RE: RegExp = /^\s{2}-\s+\S/;
/** Conda solving/metadata lines to keep (status lines). */
const _CONDA_STATUS_RE: RegExp =
  /^(?:Collecting package metadata|Solving environment|Preparing transaction|Executing transaction|Verifying transaction|done\b)/i;

// Inline patterns used by CondaFilter._compress_install / _compress_env_export
// (Python uses re.match(...) with literals).
const _CONDA_DL_HEADER_RE: RegExp = /^Downloading and Extracting Packages/i;
const _CONDA_PKG_PROGRESS_ROW_RE: RegExp = /^\s{2,}[\w.-]/;
const _CONDA_ENV_DEP_RE: RegExp = /^\s+-\s/;

// ===========================================================================
// CondaFilter (Python ~10833-11004)
// ===========================================================================

/**
 * Compress `conda install` / `conda create` / `conda list` output.
 *
 * Conda emits verbose per-package download progress, solver output, and install
 * listings. install/create: keep phase headers, drop progress bars and per-pkg
 * install lines (collapsed to count). list: pass-through <= 50, else first 20 +
 * count. env export: same but for dep lines.
 */
export class CondaFilter extends Filter {
  override name = "conda";
  override binaries: ReadonlySet<string> = new Set(["conda", "mamba", "micromamba"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    if (!this.binaries.has(stem)) {
      return false;
    }
    const positionals = argv.slice(1).filter((tok) => !tok.startsWith("-"));
    if (positionals.length === 0) {
      return true;
    }
    const first = positionals[0]!;
    return (
      first === "install" ||
      first === "create" ||
      first === "update" ||
      first === "upgrade" ||
      first === "remove" ||
      first === "uninstall" ||
      first === "list" ||
      first === "env"
    );
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = argv.slice(1).filter((tok) => !tok.startsWith("-"));
    const subcmd = positionals.length > 0 ? positionals[0]! : "";

    const merged = this._combine_output(stdout, stderr);

    // ``conda list`` — simple package listing
    if (subcmd === "list") {
      return this._compress_pkg_list(merged, "conda list");
    }

    // ``conda env export`` — YAML with pinned deps
    if (subcmd === "env" && positionals.length >= 2 && positionals[1] === "export") {
      return this._compress_env_export(merged);
    }

    // ``conda install`` / ``conda create`` / ``conda update`` / ``conda remove``
    return this._compress_install(merged);
  }

  /** Compress conda install/create/update/remove output. */
  _compress_install(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let downloads_dropped = 0;
    let pkg_installs = 0;
    let in_download_section = false;

    for (const line of lines) {
      // Always preserve error lines.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        in_download_section = false;
        continue;
      }
      // Detect "Downloading and Extracting Packages:" section header.
      if (_reMatch(_CONDA_DL_HEADER_RE, line)) {
        in_download_section = true;
        kept.push(line);
        continue;
      }
      // End download section when we see a blank line or a new phase.
      if (in_download_section) {
        if (line.trim() === "") {
          in_download_section = false;
          kept.push(line);
          continue;
        }
        if (_reMatch(_CONDA_STATUS_RE, line)) {
          in_download_section = false;
          // Fall through to normal processing below.
        } else if (_reMatch(_CONDA_DOWNLOAD_RE, line) || line.trim().startsWith("|")) {
          downloads_dropped += 1;
          continue;
        } else if (_reMatch(_CONDA_PKG_PROGRESS_ROW_RE, line)) {
          // Package progress bar row like "  pkgname-1.0 | 100 KB |"
          downloads_dropped += 1;
          continue;
        } else {
          in_download_section = false;
        }
      }
      // Phase header lines — always keep.
      if (_reMatch(_CONDA_STATUS_RE, line)) {
        kept.push(line);
        continue;
      }
      // Individual package install diff lines "  - pkgname version build"
      if (_reMatch(_CONDA_PKG_INSTALL_RE, line)) {
        pkg_installs += 1;
        continue;
      }
      // Progress bar noise outside download section.
      if (_reMatch(_CONDA_DOWNLOAD_RE, line)) {
        downloads_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, downloads_dropped, `collapsed ${downloads_dropped} download/progress lines`);
    _maybe_note(notes, pkg_installs, `collapsed ${pkg_installs} package install lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Compress `conda list` output (>50 packages → first 20 + count). */
  _compress_pkg_list(text: string, _label = "packages"): string {
    const lines = text.split("\n");
    // Preserve header comment lines (start with #).
    const header = lines.filter((ln) => ln.startsWith("#"));
    const pkg_lines = lines.filter((ln) => ln.trim() !== "" && !ln.startsWith("#"));
    const _THRESHOLD = 50;
    const _SHOW = 20;
    if (pkg_lines.length <= _THRESHOLD) {
      return _rstrip(text);
    }
    const shown = [...header, ...pkg_lines.slice(0, _SHOW)];
    const remaining = pkg_lines.length - _SHOW;
    shown.push(`[token-goat: ${remaining} more packages elided; run conda list for full output]`);
    return shown.join("\n");
  }

  /** Compress `conda env export` YAML (>50 dep lines → first 20 + count). */
  _compress_env_export(text: string): string {
    const lines = text.split("\n");
    // Separate YAML header (name:, channels:, prefix:) from dep lines.
    const dep_lines: string[] = [];
    const other_lines: string[] = [];
    let in_deps = false;
    for (const ln of lines) {
      if (ln.trim().startsWith("dependencies:")) {
        in_deps = true;
        other_lines.push(ln);
      } else if (in_deps && _reMatch(_CONDA_ENV_DEP_RE, ln)) {
        dep_lines.push(ln);
      } else {
        if (in_deps) {
          in_deps = false;
        }
        other_lines.push(ln);
      }
    }

    const _THRESHOLD = 50;
    const _SHOW = 20;
    if (dep_lines.length <= _THRESHOLD) {
      return _rstrip(text);
    }

    // Find insertion point (after "dependencies:" line).
    let dep_start_idx = other_lines.length;
    for (let i = 0; i < other_lines.length; i += 1) {
      if (other_lines[i]!.trim().startsWith("dependencies:")) {
        dep_start_idx = i;
        break;
      }
    }
    const remaining = dep_lines.length - _SHOW;
    const result = [
      ...other_lines.slice(0, dep_start_idx + 1),
      ...dep_lines.slice(0, _SHOW),
      `  # [token-goat: ${remaining} more dependencies elided]`,
      ...other_lines.slice(dep_start_idx + 1),
    ];
    return result.join("\n");
  }
}

// ===========================================================================
// Local shims for Python builtins used above.
// ===========================================================================

/** Python str.stem.lower helper specialised for argv[0] (final comp, last suffix stripped). */
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

/** Count non-overlapping occurrences of a single character (Python str.count). */
function _countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ch) {
      n += 1;
    }
  }
  return n;
}

/**
 * Python str.split(sep, 1) — split on the FIRST occurrence of sep into at most
 * two parts. Returns [head, tail]; when sep is absent returns [s] (length 1) so
 * head reads the whole string, matching Python `s.split(":", 1)[0]`.
 */
function _splitOnce(s: string, sep: string): [string, string] | [string] {
  const idx = s.indexOf(sep);
  if (idx < 0) {
    return [s];
  }
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

/**
 * Python str.split(sep, maxsplit) — split on the first `maxsplit` occurrences of
 * sep, leaving the remainder intact (so the result has at most maxsplit+1 parts).
 */
function _splitN(s: string, sep: string, maxsplit: number): string[] {
  const parts: string[] = [];
  let rest = s;
  for (let k = 0; k < maxsplit; k += 1) {
    const idx = rest.indexOf(sep);
    if (idx < 0) {
      break;
    }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  parts.push(rest);
  return parts;
}

/**
 * Return head lines + marker + tail lines when lines.length > head + tail
 * (Python _head_tail_compress). Replicated locally so the import surface stays
 * minimal; semantics match framework._head_tail_compress.
 */
function _head_tail_compress_local(
  lines: string[],
  head: number,
  tail: number,
  label: string,
): string {
  const total = lines.length;
  if (total <= head + tail) {
    return lines.join("\n");
  }
  const elided = total - head - tail;
  const head_lines = lines.slice(0, head);
  const tail_lines = lines.slice(total - tail);
  const result = [
    ...head_lines,
    `... [${elided} more ${label} elided by token-goat]`,
    ...tail_lines,
  ];
  return result.join("\n");
}
