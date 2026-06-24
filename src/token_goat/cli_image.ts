/**
 * image command implementations — the TS port of cli.py's batch G (3 of 4
 * commands): fetch-image, caption-instead, image-shrink.
 *
 * `compress` (cli.py:6471) is DEFERRED — it delegates to `bash_runner.run(cmd,
 * filter_name=, timeout=, compression_profile=, max_tokens=)` which spawns a
 * subprocess and runs the full bash_compress pipeline. There is no
 * `bash_runner.ts` port yet (the `bash_compress` TS barrel only re-exports the
 * filter modules; nothing spawns a shell + returns an exit code), so `compress`
 * cannot be ported faithfully until bash_runner lands (its own run).
 *
 * Faithful 1:1 port of cli.py command bodies:
 *   - cmd_fetch_image   (cli.py:3062)  — reuses `_emit_path_result`
 *   - caption_instead   (cli.py:3078)  — a hidden command (typer derives the
 *     name "caption-instead" from the function); echoes a v2-not-in-v1 stub
 *   - cmd_image_shrink  (cli.py:6336)
 *
 * Output seam: Python `typer.echo` / `raise typer.Exit` / `_warn` / `_error`
 * route through cli_common.ts (`_echo` / `CliExit` / `_warn` / `_error`),
 * identical to cli_gdrive.ts. `_emit_path_result` is imported from cli_gdrive.ts
 * (where batch E first ported it) — same reuse pattern as batch D's exported
 * `_run_history_listing_command` (for batch F).
 *
 * ASYNC gotcha: webfetch.fetch_url AND image_shrink.shrink/stats_for are async
 * in the TS port (Python sync), so fetch_image / image_shrink are `async` and
 * `await` them. caption_instead stays sync.
 *
 * Spy-ability gotcha: webfetch + image_shrink fns the tests `vi.spyOn` are
 * called via the `import * as` namespace (ESM live-binding analogue of Python
 * `patch.object`).
 */
import * as fs from "node:fs";

import * as image_shrink from "./image_shrink.js";
import * as webfetch from "./webfetch.js";
import { CliExit, _echo, _error, _warn } from "./cli_common.js";
import { _emit_path_result } from "./cli_gdrive.js";

/**
 * Fetch an image URL (auto-shrunk). Returns the local cached path. Port of
 * cli.py `cmd_fetch_image` (cli.py:3062). Always exits 0 (fail-soft): a WebFetch
 * failure never breaks Claude's session.
 */
export async function fetch_image(args: {
  url: string;
  json_output: boolean;
}): Promise<void> {
  const { url, json_output } = args;
  let pathResult: string;
  try {
    pathResult = await webfetch.fetch_url(url);
  } catch (e) {
    // Python catches (ValueError, RuntimeError, OSError); the TS port raises
    // Error subclasses for all of these. Fail-soft: never break the session.
    _warn(`WebFetch failed: ${e}`);
    throw new CliExit(0);
  }
  _emit_path_result(pathResult, json_output);
}

/**
 * Generate text caption instead of image (v2 feature). Port of cli.py
 * `caption_instead` (cli.py:3078) — a hidden command that is a v1 placeholder.
 */
export function caption_instead(args: { path: string }): void {
  void args;
  _echo("v2 feature, not in v1");
}

/**
 * Manually shrink an image (also used by hooks). Port of cli.py
 * `cmd_image_shrink` (cli.py:6336).
 */
export async function image_shrink_cmd(args: {
  src: string;
  json_output: boolean;
}): Promise<void> {
  const { src, json_output } = args;

  if (!fs.existsSync(src)) {
    _error(`file not found: ${src}`);
    throw new CliExit(1);
  }
  const out = await image_shrink.shrink(src);
  if (out === null) {
    _echo(`Not shrunk (below threshold or not an image): ${src}`);
    throw new CliExit(0);
  }
  const stats = await image_shrink.stats_for(src, out);
  if (json_output) {
    _echo(JSON.stringify({ shrunken_path: out, ...stats }));
  } else {
    _echo(
      `${src} → ${out} ` +
        `(${_comma(stats.src_bytes)} → ${_comma(stats.out_bytes)} bytes, ` +
        `saved ${_comma(stats.bytes_saved)})`,
    );
  }
}

/** Insert thousands separators — Python `f"{n:,}"` for a non-negative integer. */
function _comma(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
