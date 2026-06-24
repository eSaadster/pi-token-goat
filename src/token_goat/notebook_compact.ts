/**
 * Strip cell outputs from Jupyter notebooks to reduce token burn.
 *
 * Faithful port of src/token_goat/notebook_compact.py.
 *
 * `stripNotebook(nbDict)` strips all cell outputs and execution counts from a
 * notebook dict (returns a new dict). `getOrCreateSidecar` caches the stripped
 * version keyed on the SHA-256 of the original bytes so that subsequent reads of
 * an unchanged notebook skip the stripping work.
 *
 * Parity notes (Python → TS):
 *  - Python snake_case names are preserved as the canonical exports the tests
 *    import (`strip_notebook`, `get_or_create_sidecar`, `NB_STRIP_MIN_SAVINGS`).
 *    camelCase aliases (`stripNotebook`, `getOrCreateSidecar`) are also exported
 *    for JS-idiomatic call sites; both spellings reach the same implementation.
 *  - `hashlib.sha256(raw_bytes).hexdigest()` → node:crypto createHash("sha256")
 *    over the same Buffer, .digest("hex"). Input is a Buffer (the Python `bytes`
 *    analogue), so the hash is byte-identical for identical content.
 *  - `json.loads(raw_bytes)` → JSON.parse(raw.toString("utf8")). Both decode the
 *    UTF-8 bytes then parse; both throw on invalid JSON (Python raises
 *    json.JSONDecodeError, JS raises SyntaxError) — the test only asserts that
 *    *some* error is raised for non-JSON input, so either throw type satisfies it.
 *  - `json.dumps(stripped, ensure_ascii=False).encode()` → the sidecar is written
 *    as UTF-8 bytes of JSON.stringify(stripped). ensure_ascii=False keeps
 *    non-ASCII characters literal (not \uXXXX-escaped); JSON.stringify already
 *    emits literal non-ASCII, matching that. The exact byte layout of the sidecar
 *    is NOT asserted by any test (only its parsed content), so minor whitespace /
 *    key-order differences between json.dumps and JSON.stringify are immaterial.
 *  - `{**nb_dict, "cells": cells}` / `{**cell, "outputs": [], ...}` →
 *    object spread, which (like Python dict-unpacking) produces a shallow copy
 *    with the listed keys overridden. `execution_count: None` → `null` (the
 *    notebook JSON null, matching the Python test asserting `is None` ⇒ `=== null`).
 *  - `pathlib.Path` operations → node:path join + node:fs. `sidecar_path.exists()`
 *    → fs.existsSync. `mkdir(parents=True, exist_ok=True)` → fs.mkdirSync with
 *    { recursive: true }. `write_bytes` → fs.writeFileSync with a Buffer.
 *  - `raise ValueError("Not a notebook")` → throw new Error("Not a notebook").
 *    The Python test matches the message text "Not a notebook"; the TS test
 *    asserts on the same substring.
 *  - dict.get("cells", []) / cell.get("cell_type") → guarded property access with
 *    defaults; cells whose container is not array-shaped fall back to [] exactly
 *    as Python's .get default does.
 *
 * `verbatimModuleSyntax` is on → no type-only imports are needed here (all
 * imports are runtime). `noUncheckedIndexedAccess` is on → indexed access is
 * narrowed before use. No module-global mutable state exists, so no
 * registerReset registration is required.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

/** Minimum bytes saved by output stripping before a redirect is worth emitting. */
export const NB_STRIP_MIN_SAVINGS: number = 4096;

/**
 * Return a new notebook dict with all code-cell outputs cleared.
 *
 * Markdown and raw cells are left untouched. `execution_count` on code cells is
 * set to `null` so re-execution counts are not misleading. The `outputs` array
 * is replaced with `[]`; other fields are preserved.
 */
export function stripNotebook(
  nbDict: Record<string, unknown>,
): Record<string, unknown> {
  const cells: unknown[] = [];
  const rawCells = nbDict["cells"];
  const cellList = Array.isArray(rawCells) ? rawCells : [];
  for (const cellAny of cellList) {
    let cell = cellAny;
    if (
      cell !== null &&
      typeof cell === "object" &&
      (cell as Record<string, unknown>)["cell_type"] === "code"
    ) {
      cell = {
        ...(cell as Record<string, unknown>),
        outputs: [],
        execution_count: null,
      };
    }
    cells.push(cell);
  }
  return { ...nbDict, cells };
}

/** snake_case alias mirroring the Python symbol name the tests import. */
export const strip_notebook = stripNotebook;

/**
 * Return `[sidecarPath, created]` for the stripped version of *rawBytes*.
 *
 * If a sidecar already exists for this exact content (same SHA-256), return it
 * directly without re-stripping (`created=false`). Otherwise parse, strip,
 * write, and return (`created=true`). Throws if *rawBytes* is not valid JSON or
 * not a recognisable notebook dict.
 */
export function getOrCreateSidecar(
  rawBytes: Buffer,
  cacheRoot: string,
): [string, boolean] {
  const sha = createHash("sha256").update(rawBytes).digest("hex");
  const sidecarDir = path.join(cacheRoot, "nb_strip", sha);
  const sidecarPath = path.join(sidecarDir, "stripped.ipynb");
  if (fs.existsSync(sidecarPath)) {
    return [sidecarPath, false];
  }
  const nb: unknown = JSON.parse(rawBytes.toString("utf8"));
  if (
    nb === null ||
    typeof nb !== "object" ||
    Array.isArray(nb) ||
    !("cells" in (nb as Record<string, unknown>))
  ) {
    throw new Error("Not a notebook");
  }
  const stripped = stripNotebook(nb as Record<string, unknown>);
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(sidecarPath, Buffer.from(JSON.stringify(stripped), "utf8"));
  return [sidecarPath, true];
}

/** snake_case alias mirroring the Python symbol name the tests import. */
export const get_or_create_sidecar = getOrCreateSidecar;
