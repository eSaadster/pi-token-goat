/**
 * 1:1 port of tests/test_index_features.py.
 *
 * Test `--check` flag for dirty-queue status, `--verbose` per-file output, and
 * the final summary line.
 *
 * Port model:
 *  - Every case drives the Typer CLI via `runner.invoke(cli.app, [...])`. The
 *    cli.ts module (the Typer `app`, the `index` command, `_watch_project`) is
 *    NOT ported at this layer — there is no `cli` export to invoke. All cases
 *    are therefore DEFERRED (it.skip) with a reason, and the missing surface
 *    is reported via the StructuredOutput `missingExports` field.
 *  - The Python suite also lazy-imports `_pytest.monkeypatch` for chdir; the TS
 *    port would use process.chdir inside a tmp root, but since the CLI itself
 *    is absent the chdir setup is moot until cli.ts lands.
 *  - `paths.dirtyQueuePath` and `paths.ensureDir` ARE shipped (paths.ts), so
 *    once cli.ts is ported the --check cases can write a dirty-queue file via
 *    `fs.writeFileSync(paths.dirtyQueuePath(), ...)` exactly as Python does.
 */
import { describe, it } from "vitest";

// NOTE: cli.ts (the Typer `app`, the `index` command, `_watch_project`) is NOT
// ported at this layer — there is no `cli` export to invoke. paths.ts IS
// shipped (dirtyQueuePath/ensureDir), so once cli.ts lands the --check cases
// can write a dirty-queue file via fs.writeFileSync(paths.dirtyQueuePath(), ...).

// ===========================================================================
// TestIndexCheck — `--check` flag for dirty queue status.
// DEFERRED: cli.ts (`app`, `index --check`) not ported.
// ===========================================================================

describe("TestIndexCheck", () => {
  it.skip("test_check_exits_0_when_no_dirty_files", () => {
    // PORT: deferred — cli.ts (`index --check`) not ported.
  });
  it.skip("test_check_exits_1_when_dirty_files_exist", () => {
    // PORT: deferred — cli.ts (`index --check`) not ported.
  });
  it.skip("test_check_counts_multiple_dirty_files", () => {
    // PORT: deferred — cli.ts (`index --check`) not ported.
  });
});

// ===========================================================================
// TestIndexVerbose — `--verbose` per-file output.
// DEFERRED: cli.ts (`index --verbose`) not ported. These also require the
// python grammar extractor (the fixture writes .py files and asserts symbol
// counts), so they are doubly deferred.
// ===========================================================================

describe("TestIndexVerbose", () => {
  it.skip("test_verbose_shows_indexed_files", () => {
    // PORT: deferred — cli.ts not ported AND requires the python grammar
    // extractor (fixture writes test.py; asserts "2 symbols").
  });
  it.skip("test_verbose_shows_single_symbol", () => {
    // PORT: deferred — cli.ts not ported AND requires the python grammar
    // extractor (fixture writes single.py; asserts "1 symbol").
  });
});

// ===========================================================================
// TestIndexSummary — final summary line.
// DEFERRED: cli.ts (`index`) not ported. The summary-content cases also
// require the python grammar extractor (fixture writes .py; asserts "symbols").
// ===========================================================================

describe("TestIndexSummary", () => {
  it.skip("test_summary_shows_indexed_count", () => {
    // PORT: deferred — cli.ts not ported (fixture also writes .py).
  });
  it.skip("test_summary_shows_symbol_count", () => {
    // PORT: deferred — cli.ts not ported AND requires the python grammar
    // extractor (asserts "symbols" in output from a .py fixture).
  });
});
