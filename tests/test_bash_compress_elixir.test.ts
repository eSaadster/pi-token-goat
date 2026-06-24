/**
 * Tests for MixFilter and ComposerFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_elixir.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import MixFilter / ComposerFilter / select_filter from the barrel
 *         "../src/token_goat/bash_compress.js".
 *  - `from filter_test_helpers import apply_filter as _apply`
 *      -> local `apply_filter(filter, stdout, opts?)` helper below; runs
 *         `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *         to `[filter_.name]` (matching the Python helper exactly).
 *  - `f.apply(stdout, "", 0, argv).percent_saved` -> `.apply(...).percent_saved`
 *    on the TS FilterResult (a getter that mirrors the Python property).
 *
 * Both MixFilter (Elixir) and ComposerFilter (PHP) are already shipped in the
 * barrel via bash_compress/ruby_php.ts, so no test in this module is deferred.
 * The ErlangFilter (rebar3) is NOT exercised by this Python module.
 *
 * Byte-exactness: assertions are substring `in` / `not in`, `.count()` and
 * `len()`-style checks plus `percent_saved` thresholds. The fixtures are pure
 * ASCII, so Python `len` (code points) equals JS `.length` here and no Buffer
 * arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import {
  ComposerFilter,
  MixFilter,
  select_filter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_apply` at the Python import site). When argv is omitted the filter's own
// `.name` is used as the sole argv element.
// ---------------------------------------------------------------------------
function apply_filter(
  filter_: Filter,
  stdout = "",
  opts?: { stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// Count non-overlapping occurrences of `needle` in `haystack` (Python str.count).
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ===========================================================================
// MixFilter — matches()
// ===========================================================================

describe("TestMixFilterMatches", () => {
  it("test_mix_compile_matches", () => {
    const f = new MixFilter();
    expect(f.matches(["mix", "compile"])).toBeTruthy();
  });

  it("test_mix_test_matches", () => {
    const f = new MixFilter();
    expect(f.matches(["mix", "test"])).toBeTruthy();
  });

  it("test_mix_deps_get_matches", () => {
    const f = new MixFilter();
    expect(f.matches(["mix", "deps.get"])).toBeTruthy();
  });

  it("test_mix_phx_server_matches", () => {
    const f = new MixFilter();
    expect(f.matches(["mix", "phx.server"])).toBeTruthy();
  });

  it("test_mix_ecto_migrate_matches", () => {
    const f = new MixFilter();
    expect(f.matches(["mix", "ecto.migrate"])).toBeTruthy();
  });

  it("test_mix_no_subcommand_matches", () => {
    const f = new MixFilter();
    expect(f.matches(["mix"])).toBeTruthy();
  });

  it("test_non_mix_command_does_not_match", () => {
    const f = new MixFilter();
    expect(f.matches(["rebar3", "compile"])).toBeFalsy();
    expect(f.matches(["elixir", "script.exs"])).toBeFalsy();
    expect(f.matches(["pytest"])).toBeFalsy();
  });

  it("test_dispatch_routes_mix", () => {
    const result = select_filter(["mix", "test"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("mix");
  });

  it("test_dispatch_routes_mix_compile", () => {
    const result = select_filter(["mix", "compile"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("mix");
  });
});

// ===========================================================================
// MixFilter — mix deps.get
// ===========================================================================

const _MIX_DEPS_GET_OUTPUT = `Resolving Hex dependencies...
Resolution completed in 0.072s
New:
  cowboy 2.10.0
  cowlib 2.12.1
  plug 1.15.3
  phoenix 1.7.10
  ecto 3.11.1
* Getting cowboy (Hex package)
* Getting cowlib (Hex package)
* Getting plug (Hex package)
* Getting phoenix (Hex package)
* Getting ecto (Hex package)
`;

describe("TestMixFilterDepsGet", () => {
  it("test_getting_lines_collapsed", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_DEPS_GET_OUTPUT, { argv: ["mix", "deps.get"] });
    expect(out).not.toContain("* Getting");
  });

  it("test_fetch_count_reported", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_DEPS_GET_OUTPUT, { argv: ["mix", "deps.get"] });
    expect(out).toContain("5");
    expect(out.toLowerCase()).toContain("dependenc");
  });

  it("test_resolution_line_preserved", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_DEPS_GET_OUTPUT, { argv: ["mix", "deps.get"] });
    expect(out).toContain("Resolving Hex dependencies");
  });

  it("test_savings_significant", () => {
    // Build a large deps list.
    let big = "Resolving Hex dependencies...\nResolution completed in 0.1s\n";
    big += Array.from({ length: 80 }, (_v, i) => `* Getting dep_${i} (Hex package)`).join("\n");
    const f = new MixFilter();
    const result = f.apply(big, "", 0, ["mix", "deps.get"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(40.0);
  });
});

// ===========================================================================
// MixFilter — mix compile
// ===========================================================================

const _MIX_COMPILE_OUTPUT = `==> my_app
Compiling 12 files (.ex)
warning: variable "x" is unused (if the variable is not meant to be used, prefix it with an underscore)
  lib/my_app/server.ex:42

warning: unused import MyApp.Utils
  lib/my_app/helpers.ex:7

Generated my_app app
`;

const _MIX_COMPILE_NOISY = `==> my_app
Resolving Hex dependencies...
Resolution completed in 0.05s
Compiling 25 files (.ex)
Generated my_app app
`;

describe("TestMixFilterCompile", () => {
  it("test_compiling_line_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_COMPILE_OUTPUT, { argv: ["mix", "compile"] });
    expect(out).toContain("Compiling 12 files");
  });

  it("test_warning_lines_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_COMPILE_OUTPUT, { argv: ["mix", "compile"] });
    expect(out).toContain("warning: variable");
    expect(out).toContain("warning: unused import");
  });

  it("test_generated_line_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_COMPILE_OUTPUT, { argv: ["mix", "compile"] });
    expect(out).toContain("Generated my_app app");
  });

  it("test_noisy_compile_drops_progress", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_COMPILE_NOISY, { argv: ["mix", "compile"] });
    // "Resolving Hex dependencies" is noise that should be dropped or counted.
    // "Compiling 25 files" and "Generated my_app app" must survive.
    expect(out).toContain("Compiling 25 files");
    expect(out).toContain("Generated my_app app");
  });
});

// ===========================================================================
// MixFilter — mix test
// ===========================================================================

const _MIX_TEST_ALL_PASSING = `...........................

Finished in 0.3 seconds (0.1s async, 0.2s sync)
27 tests, 0 failures
`;

const _MIX_TEST_WITH_FAILURES = `...F..E.

  1) test MyModule does something important (MyModuleTest)
     ** (ExUnit.AssertionError)

       left:  42
       right: 0

     code: assert result == 0
     stacktrace:
       test/my_module_test.exs:15: (test)

  2) test MyOtherModule raises on bad input (MyOtherModuleTest)
     ** (RuntimeError) unexpected input

     stacktrace:
       lib/my_other_module.ex:9: MyOtherModule.call/1
       test/my_other_module_test.exs:22: (test)

Finished in 0.5 seconds (0.1s async, 0.4s sync)
8 tests, 2 failures
`;

const _MIX_TEST_LARGE_PASSING =
  ".".repeat(500) + "\n\nFinished in 1.2 seconds\n500 tests, 0 failures\n";

describe("TestMixFilterTest", () => {
  it("test_dots_collapsed", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_TEST_ALL_PASSING, { argv: ["mix", "test"] });
    expect(out).not.toContain(".".repeat(10));
  });

  it("test_summary_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_TEST_ALL_PASSING, { argv: ["mix", "test"] });
    expect(out).toContain("27 tests, 0 failures");
  });

  it("test_finished_line_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_TEST_ALL_PASSING, { argv: ["mix", "test"] });
    expect(out).toContain("Finished in");
  });

  it("test_failure_block_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_TEST_WITH_FAILURES, { argv: ["mix", "test"] });
    expect(out).toContain("ExUnit.AssertionError");
    expect(out).toContain("left:  42");
    expect(out).toContain("right: 0");
  });

  it("test_second_failure_block_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_TEST_WITH_FAILURES, { argv: ["mix", "test"] });
    expect(out).toContain("RuntimeError");
    expect(out).toContain("unexpected input");
  });

  it("test_failure_summary_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_TEST_WITH_FAILURES, { argv: ["mix", "test"] });
    expect(out).toContain("8 tests, 2 failures");
  });

  it("test_savings_large_run", () => {
    const f = new MixFilter();
    const result = f.apply(_MIX_TEST_LARGE_PASSING, "", 0, ["mix", "test"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(50.0);
  });
});

// ===========================================================================
// MixFilter — mix ecto.migrate
// ===========================================================================

const _MIX_ECTO_MIGRATE_OUTPUT = `
17:23:45.123 [info] == Running 20231015120000 MyApp.Repo.Migrations.CreateUsers.change/0 forward

17:23:45.130 [info] create table users

17:23:45.155 [info] == Migrated 20231015120000 in 0.0s

17:23:45.160 [info] == Running 20231020093000 MyApp.Repo.Migrations.AddEmailIndex.change/0 forward

17:23:45.165 [info] create index users_email_index

17:23:45.170 [info] == Migrated 20231020093000 in 0.0s
`;

describe("TestMixFilterEctoMigrate", () => {
  it("test_running_lines_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_ECTO_MIGRATE_OUTPUT, { argv: ["mix", "ecto.migrate"] });
    expect(out).toContain("Running 20231015120000");
    expect(out).toContain("Running 20231020093000");
  });

  it("test_migrated_lines_kept", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_ECTO_MIGRATE_OUTPUT, { argv: ["mix", "ecto.migrate"] });
    expect(out).toContain("Migrated 20231015120000");
    expect(out).toContain("Migrated 20231020093000");
  });

  it("test_detail_lines_dropped", () => {
    const f = new MixFilter();
    const out = apply_filter(f, _MIX_ECTO_MIGRATE_OUTPUT, { argv: ["mix", "ecto.migrate"] });
    expect(out).not.toContain("create table users");
    expect(out).not.toContain("create index users_email_index");
  });
});

// ===========================================================================
// ComposerFilter — matches()
// ===========================================================================

describe("TestComposerFilterMatches", () => {
  it("test_composer_install_matches", () => {
    const f = new ComposerFilter();
    expect(f.matches(["composer", "install"])).toBeTruthy();
  });

  it("test_composer_update_matches", () => {
    const f = new ComposerFilter();
    expect(f.matches(["composer", "update"])).toBeTruthy();
  });

  it("test_composer_require_matches", () => {
    const f = new ComposerFilter();
    expect(f.matches(["composer", "require", "vendor/package"])).toBeTruthy();
  });

  it("test_composer_phar_matches", () => {
    const f = new ComposerFilter();
    expect(f.matches(["composer.phar", "install"])).toBeTruthy();
  });

  it("test_non_composer_does_not_match", () => {
    const f = new ComposerFilter();
    expect(f.matches(["npm", "install"])).toBeFalsy();
    expect(f.matches(["pip", "install"])).toBeFalsy();
    expect(f.matches(["bundle", "install"])).toBeFalsy();
  });

  it("test_dispatch_routes_composer", () => {
    const result = select_filter(["composer", "install"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("composer");
  });

  it("test_dispatch_routes_composer_update", () => {
    const result = select_filter(["composer", "update"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("composer");
  });
});

// ===========================================================================
// ComposerFilter — install/update compression
// ===========================================================================

const _COMPOSER_INSTALL_OUTPUT = `Loading composer repositories with package information
Updating dependencies
Lock file operations: 0 installs, 0 updates, 0 removals
Package operations: 15 installs, 2 updates, 0 removals
  - Downloading vendor/package-a (1.2.3)
  - Downloading vendor/package-b (4.5.6)
  - Installing vendor/package-a (1.2.3): Loading from cache
  - Installing vendor/package-b (4.5.6): Loading from cache
  - Installing vendor/package-c (2.0.0): Loading from cache
  - Installing vendor/package-d (3.1.0): Loading from cache
  - Installing vendor/package-e (1.0.0): Loading from cache
Generating autoload files
Generated optimized autoload files containing 1234 classes
`;

const _COMPOSER_WITH_FUNDING = `Package operations: 3 installs, 0 updates, 0 removals
  - Installing vendor/abc (1.0.0): Loading from cache
  - Installing vendor/def (2.0.0): Loading from cache
  - Installing vendor/ghi (3.0.0): Loading from cache
Generating autoload files
3 packages you are using are looking for funding.
Use the \`composer fund\` command to find out more!
`;

const _COMPOSER_WITH_WARNINGS = `Package operations: 2 installs, 0 updates, 0 removals
  - Installing vendor/alpha (1.0.0): Loading from cache
  - Installing vendor/beta (2.0.0): Loading from cache
Warning: The lock file is not up to date with the latest changes in composer.json.
Warning: The lock file is not up to date with the latest changes in composer.json.
Warning: The lock file is not up to date with the latest changes in composer.json.
Generating autoload files
`;

const _COMPOSER_WITH_PROGRESS = `Package operations: 2 installs, 0 updates, 0 removals
  - Installing vendor/large-package (1.0.0) (10%)
  - Installing vendor/large-package (1.0.0) (50%)
  - Installing vendor/large-package (1.0.0) (100%)
  - Installing vendor/small-package (0.1.0): Loading from cache
Generating autoload files
`;

describe("TestComposerFilterInstall", () => {
  it("test_install_lines_collapsed", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_INSTALL_OUTPUT, { argv: ["composer", "install"] });
    expect(out).not.toContain("- Installing");
  });

  it("test_install_count_reported", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_INSTALL_OUTPUT, { argv: ["composer", "install"] });
    expect(out).toContain("5");
    expect(out.toLowerCase()).toContain("install");
  });

  it("test_download_lines_collapsed", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_INSTALL_OUTPUT, { argv: ["composer", "install"] });
    expect(out).not.toContain("- Downloading");
  });

  it("test_autoload_lines_kept", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_INSTALL_OUTPUT, { argv: ["composer", "install"] });
    expect(out).toContain("Generating autoload files");
    expect(out).toContain("Generated optimized autoload");
  });

  it("test_operations_summary_kept", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_INSTALL_OUTPUT, { argv: ["composer", "install"] });
    expect(out).toContain("Package operations:");
  });

  it("test_funding_notice_dropped", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_WITH_FUNDING, { argv: ["composer", "install"] });
    expect(out).not.toContain("looking for funding");
  });

  it("test_duplicate_warnings_deduplicated", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_WITH_WARNINGS, { argv: ["composer", "install"] });
    // The same warning should appear at most once.
    expect(_count(out, "lock file is not up to date")).toBeLessThanOrEqual(1);
  });

  it("test_warning_kept_at_least_once", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_WITH_WARNINGS, { argv: ["composer", "install"] });
    expect(out).toContain("lock file is not up to date");
  });

  it("test_progress_percentage_lines_dropped", () => {
    const f = new ComposerFilter();
    const out = apply_filter(f, _COMPOSER_WITH_PROGRESS, { argv: ["composer", "install"] });
    expect(out).not.toContain("(10%)");
    expect(out).not.toContain("(50%)");
  });

  it("test_savings_significant_large_install", () => {
    let big = "Package operations: 80 installs, 0 updates, 0 removals\n";
    big += Array.from(
      { length: 80 },
      (_v, i) => `  - Installing vendor/package-${i} (1.0.${i}): Loading from cache`,
    ).join("\n");
    big += "\nGenerating autoload files\n";
    const f = new ComposerFilter();
    const result = f.apply(big, "", 0, ["composer", "install"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(50.0);
  });
});
