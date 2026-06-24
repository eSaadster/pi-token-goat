/**
 * Dockerfile extractor — one Section per `FROM` build stage.
 *
 * Faithful port of src/token_goat/languages/dockerfile_idx.py.
 *
 * A Dockerfile is a flat list of instructions where `FROM` introduces a new
 * build stage and every subsequent `RUN` / `COPY` / `ENV` / etc. applies within
 * that stage until the next `FROM` or EOF. Multi-stage Dockerfiles
 * (`FROM ... AS builder` followed by `FROM ... AS runtime`) are the natural unit
 * of sectioning.
 *
 * Sections
 * --------
 *  - Each `FROM` line opens a new section. When the line ends with `AS <name>`
 *    the section heading is the stage name; otherwise it is the image reference
 *    (e.g. `python:3.11`) so the section is still addressable.
 *  - `level` is always 1.
 *  - `end_line` is the line before the next `FROM` or EOF for the last stage.
 *
 * Symbols
 * -------
 * The same headings are emitted as `dockerfile_stage` symbols. Other
 * instructions (`RUN`, `COPY`, etc.) are intentionally not indexed.
 */

import { ImpExp, Ref, Section, Symbol } from "../parser.js";
import { getLogger } from "../util.js";
import { scan_flat_headers } from "./common.js";

export const __all__ = ["extract"] as const;

const _LOG = getLogger("languages.dockerfile_idx");

// Column-0-anchored ``FROM`` instruction. Dockerfile keywords are
// case-insensitive ("FROM" and "from" both work) per the official spec; we also
// tolerate trailing comments after the instruction body. The trailing
// ``AS <name>`` clause is captured separately so we can prefer the stage name as
// the section heading when present.
//
// Python: re.compile(r"^\s*FROM\s+(?P<image>[^\s#]+)(?:\s+AS\s+(?P<alias>[A-Za-z0-9_\-]+))?\s*(?:#.*)?$", re.IGNORECASE)
const _FROM_RE =
  /^\s*FROM\s+(?<image>[^\s#]+)(?:\s+AS\s+(?<alias>[A-Za-z0-9_\-]+))?\s*(?:#.*)?$/i;

// Maximum number of stages indexed.
const _MAX_STAGES = 50;
// Maximum heading length we accept.
const _MAX_HEADING_LEN = 200;

/**
 * Return the stage heading from a `_FROM_RE` match.
 *
 * Prefers the `AS <alias>` clause when present — that is the stage's intended
 * name and the one `COPY --from=<alias>` will reference. Falls back to the image
 * reference (e.g. `python:3.11`) so unnamed stages remain addressable.
 */
function _docker_get_name(m: RegExpMatchArray): string {
  const groups = m.groups ?? {};
  const alias = (groups.alias ?? "").trim();
  if (alias) {
    return alias;
  }
  return (groups.image ?? "").trim();
}

/**
 * Extract `FROM` stages as Section + Symbol entries.
 *
 * Refs and imports are always empty for Dockerfiles — there is no cross-file
 * reference model.
 */
export function extract(
  source: Buffer,
  _rel_path: string,
): [Symbol[], Ref[], ImpExp[], Section[]] {
  const result = scan_flat_headers(source, _LOG, "dockerfile_idx", {
    pattern: _FROM_RE,
    get_name: _docker_get_name,
    symbol_kind: "dockerfile_stage",
    max_entries: _MAX_STAGES,
    max_heading_len: _MAX_HEADING_LEN,
    // No useful single-character prefilter: ``FROM`` is case-insensitive and may
    // be preceded by whitespace, so the regex must run on every line.
  });
  if (result === null) {
    return [[], [], [], []];
  }
  const [symbols, sections] = result;
  return [symbols, [], [], sections];
}
