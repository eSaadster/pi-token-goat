/**
 * Overflow guard — cap oversized command output to protect the model's context.
 *
 * Faithful port of src/token_goat/overflow_guard.py.
 *
 * token-goat's whole purpose is to *reduce* token burn, so a surgical-read command
 * that dumps a 10k-line file would be self-defeating. `guard()` is the final
 * safety net: it head-truncates text on a line boundary when the estimated token
 * count exceeds the configured ceiling, appending an actionable marker that tells
 * the agent how to narrow the request.
 *
 * Parity notes (Python -> TS):
 *  - `config.load().overflow_guard` is consumed exactly as in Python. The TS
 *    `load()` always populates `.enabled` / `.max_tokens` (the section is one of
 *    the makeDefault* sections), so the runtime values match config.py.
 *  - util.sanitize_surrogates -> sanitizeSurrogates, util.strip_ansi -> stripAnsi.
 *  - `len(...)` on the char-budget math is JS `.length` (UTF-16 code units). The
 *    Python original uses `len()` on `str` code points; every test input here is
 *    BMP (ASCII / a single U+00E9 / one lone surrogate U+DCE9), so code-unit and
 *    code-point lengths agree. The estimator/budget are deliberately
 *    char-counting (not byte-counting), matching compact.estimate_tokens.
 *  - This module holds NO mutable module-global state, so there is nothing to
 *    registerReset.
 *
 * `verbatimModuleSyntax` is on -> the config namespace import is a value import
 * (it is called), and there are no type-only imports needed here.
 */

import * as config from "./config.js";
import { sanitizeSurrogates, stripAnsi } from "./util.js";

// House marker style matches bash_cache._TRUNC_MARKER: "[token-goat: …]".
/** Reserve headroom so the appended marker itself stays within budget. */
const _MARKER_MARGIN_TOKENS = 64;

/**
 * Conservative token estimate: ~3 chars/token after stripping ANSI color.
 *
 * Mirrors `compact.estimate_tokens` (the most conservative estimator in the
 * codebase) so the guard never *under*-counts and lets an oversized payload slip
 * through. ANSI escapes are stripped first because color codes inflate length
 * without adding model-visible tokens.
 */
export function estimate_tokens(text: string): number {
  const stripped = stripAnsi(text);
  return Math.max(1, Math.floor(stripped.length / 3) + 1);
}

/** Options for {@link guard}. Optional kwargs mirror the Python keyword-only args. */
export interface GuardOptions {
  command?: string;
  max_tokens?: number | null;
  enabled?: boolean | null;
}

/**
 * Return *text* unchanged, or head-truncated with a marker if it overflows.
 *
 * When *enabled* / *max_tokens* are `null`/undefined they are loaded from
 * `config.load().overflow_guard`. The guard is a no-op when disabled, when
 * `max_tokens <= 0` (explicit "never cap"), or when the estimate is within
 * budget. Otherwise it keeps as many leading whole lines as fit under the
 * budget (reserving ~64 tokens for the marker) and appends a single marker
 * line explaining the cap and how to narrow the request.
 */
export function guard(text: string, opts: GuardOptions = {}): string {
  const command = opts.command ?? "";
  let enabled: boolean | null | undefined = opts.enabled;
  let max_tokens: number | null | undefined = opts.max_tokens;

  if (enabled === null || enabled === undefined || max_tokens === null || max_tokens === undefined) {
    const cfg = config.load().overflow_guard ?? {};
    if (enabled === null || enabled === undefined) {
      enabled = cfg.enabled ?? false;
    }
    if (max_tokens === null || max_tokens === undefined) {
      max_tokens = cfg.max_tokens ?? 0;
    }
  }

  if (!enabled || max_tokens <= 0) {
    return text;
  }

  const total_tokens = estimate_tokens(text);
  if (total_tokens <= max_tokens) {
    return text;
  }

  const lines = text.split("\n");
  const total_lines = lines.length;

  // Token budget for the body, reserving margin for the marker line itself.
  const body_budget = Math.max(1, max_tokens - _MARKER_MARGIN_TOKENS);
  // ~3 chars/token -> char budget. Keep leading whole lines until we'd exceed it.
  const char_budget = body_budget * 3;

  const kept: string[] = [];
  let used = 0;
  for (const ln of lines) {
    const cost = stripAnsi(ln).length + 1; // +1 for the newline that rejoins this line.
    if (kept.length === 0 && cost > char_budget) {
      // Single giant leading line (no early newline) already blows the budget: hard-slice it so a minified blob can't pass through whole.
      kept.push(ln.slice(0, char_budget));
      break;
    }
    if (kept.length > 0 && used + cost > char_budget) {
      break;
    }
    kept.push(ln);
    used += cost;
  }

  const shown = kept.length;
  const hint = _hint_for(command);
  const marker =
    `[token-goat: output capped at ~${max_tokens} tokens to protect context ` +
    `— showing ${shown} of ${total_lines} lines. ${hint}]`;
  // sanitize_surrogates guards the non-fail-soft typer.echo at the emit sites: the hard-slice can sever a multi-byte char (or carry a pre-existing lone surrogate), which would raise UnicodeEncodeError on the Windows codepage. Identity on clean text.
  return sanitizeSurrogates(kept.join("\n") + "\n" + marker);
}

/** Tailor the remediation hint to the originating command label. */
export function _hint_for(command: string): string {
  const cmd = (command || "").trim().toLowerCase();
  if (cmd === "symbol") {
    return "Request a specific method (file.py::Class.method) or use --json for structured access.";
  }
  if (cmd === "heading" || cmd === "section") {
    return "Request a narrower sub-heading, e.g. 'doc.md::Section#2'.";
  }
  if (cmd === "lines") {
    return "Request a smaller line range, e.g. 'file.py::100-150'.";
  }
  if (cmd === "bash-output" || cmd === "web-output") {
    return "Use --grep PATTERN, --section HEADING, or --tail N to narrow the cached output.";
  }
  return "Narrow your query or raise [overflow_guard] max_tokens in config.";
}
