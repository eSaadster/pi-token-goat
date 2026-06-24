/**
 * Tests for NixFilter, HaskellFilter, and RCmdFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_nix_haskell_r.py. Every Python `def
 * test_*` maps to a vitest `it()` with the SAME name and assertion polarity;
 * the Python test classes (TestNixFilter, TestHaskellFilter, TestRCmdFilter) map
 * to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports NixFilter / HaskellFilter / RCmdFilter + select_filter).
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, stdout, opts?)` helper below; runs
 *         `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *         to `[filter_.name]` (matching the Python helper exactly). The Python
 *         tests pass the error fixtures as the `stdout` positional with an empty
 *         stderr; error_passthrough therefore does NOT short-circuit (the
 *         framework's _preserve_stderr_on_error only fires when stderr is
 *         non-empty on a non-zero exit), so _compress_body runs and the error
 *         lines are kept via the always-keep _ERROR_SIGNAL_RE branch.
 *
 * Byte-exactness: the assertions are substring `in` / `not in` / `.count(...)`
 * checks plus one `.count("... OK") < 20` numeric comparison. All fixtures are
 * pure ASCII so Python `len` (code points) equals JS `.length` equals the UTF-8
 * byte count; no Buffer arithmetic is needed. The "→" arrow in _NIX_FLAKE_UPDATE
 * is U+2192 (one BMP code point, one JS code unit) — it only appears in a fixture
 * body that is never counted, so the parity holds.
 */
import { describe, expect, it } from "vitest";

import {
  HaskellFilter,
  NixFilter,
  RCmdFilter,
  select_filter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local _compress helper (port of filter_test_helpers.apply_filter, aliased as
// `_compress` at the Python import site). When argv is omitted the filter's
// own `.name` is used as the sole argv element.
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  stdout: string,
  opts?: { stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

/** Python str.count(sub) — count of non-overlapping occurrences. */
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// ===========================================================================
// NixFilter
// ===========================================================================

const _NIX_BUILD_SUCCESS = `these 5 paths will be fetched (12.34 MiB download, 45.67 MiB unpacked):
  /nix/store/aaaa-hello-2.12.1
  /nix/store/bbbb-glibc-2.35
fetching path '/nix/store/aaaa-hello-2.12.1'...
[1/5 (2.1 MiB DL)]
[2/5 (4.3 MiB DL)]
fetching path '/nix/store/bbbb-glibc-2.35'...
[3/5 (8.9 MiB DL)]
[4/5 (10.1 MiB DL)]
[5/5 (12.3 MiB DL)]
building '/nix/store/cccc-hello-2.12.1.drv'...
running phase 'buildPhase'
source $stdenv/setup
building '/nix/store/dddd-hello-wrapper.drv'...
/nix/store/eeee-hello-2.12.1
`;

const _NIX_FLAKE_UPDATE =
  "Updated input 'nixpkgs':\n" +
  "  'github:NixOS/nixpkgs/abc123' (2024-01-01)\n" +
  "→ 'github:NixOS/nixpkgs/def456' (2024-01-10)\n" +
  "Updated input 'flake-utils':\n" +
  "  'github:numtide/flake-utils/111' (2023-12-01)\n" +
  "→ 'github:numtide/flake-utils/222' (2024-01-05)\n" +
  "writing modified lock file '/path/to/flake.lock'\n";

const _NIX_ERROR = `building '/nix/store/xxxx-my-pkg.drv'...
error: builder for '/nix/store/xxxx-my-pkg.drv' failed with exit code 1;
       last 10 log lines:
       configure: error: cannot find required header
`;

describe("TestNixFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_nix", () => {
    const f = new NixFilter();
    expect(f.matches(["nix", "build"])).toBe(true);
  });

  it("test_matches_nix_build", () => {
    const f = new NixFilter();
    expect(f.matches(["nix-build", "."])).toBe(true);
  });

  it("test_matches_nix_shell", () => {
    const f = new NixFilter();
    expect(f.matches(["nix-shell", "-p", "python3"])).toBe(true);
  });

  it("test_matches_nix_env", () => {
    const f = new NixFilter();
    expect(f.matches(["nix-env", "-iA", "nixpkgs.hello"])).toBe(true);
  });

  it("test_matches_nixos_rebuild", () => {
    const f = new NixFilter();
    expect(f.matches(["nixos-rebuild", "switch"])).toBe(true);
  });

  it("test_no_match_make", () => {
    const f = new NixFilter();
    expect(f.matches(["make", "all"])).toBe(false);
  });

  it("test_no_match_npm", () => {
    const f = new NixFilter();
    expect(f.matches(["npm", "install"])).toBe(false);
  });

  // --- select -----------------------------------------------------------

  it("test_select_nix_build", () => {
    expect(select_filter(["nix-build", "."]) instanceof NixFilter).toBe(true);
  });

  it("test_select_nix_shell", () => {
    expect(select_filter(["nix-shell"]) instanceof NixFilter).toBe(true);
  });

  // --- compress: success path -------------------------------------------

  it("test_fetch_count_collapsed", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_BUILD_SUCCESS);
    expect(out).toContain("fetched/substituted");
    expect(out).toContain("2"); // two fetch lines
  });

  it("test_build_count_collapsed", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_BUILD_SUCCESS);
    expect(out).toContain("built");
    expect(out).toContain("derivation");
  });

  it("test_progress_lines_dropped", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_BUILD_SUCCESS);
    // [1/5 ...] progress lines should be gone
    expect(out).not.toContain("[1/5");
    expect(out).not.toContain("[5/5");
  });

  it("test_sandbox_noise_dropped", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_BUILD_SUCCESS);
    expect(out).not.toContain("running phase");
    expect(out).not.toContain("source $stdenv");
  });

  it("test_result_store_path_kept", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_BUILD_SUCCESS);
    // The final result /nix/store/... line must be kept
    expect(out).toContain("/nix/store/eeee-hello-2.12.1");
  });

  it("test_paths_summary_kept", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_BUILD_SUCCESS);
    expect(out).toContain("these 5 paths will be fetched");
  });

  it("test_flake_update_collapsed", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_FLAKE_UPDATE);
    expect(out.includes("flake lock update") || out.includes("collapsed")).toBe(true);
  });

  // --- compress: error path -------------------------------------------

  it("test_error_preserved_on_failure", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_ERROR, { exit_code: 1 });
    expect(out).toContain("error: builder for");
  });

  it("test_error_signal_always_kept", () => {
    const f = new NixFilter();
    const out = _compress(f, _NIX_ERROR, { exit_code: 0 });
    expect(out.toLowerCase()).toContain("error:");
  });
});

// ===========================================================================
// HaskellFilter
// ===========================================================================

const _CABAL_BUILD_SUCCESS = `Resolving dependencies...
Downloading servant-0.20 from Hackage...
Downloading base-4.17.0 from Hackage...
Configuring servant-0.20...
Configuring base-compat-0.13...
Preprocessing library for servant-0.20..
[ 1 of 42] Compiling Servant.API ()
[ 2 of 42] Compiling Servant.API.Alternative ()
[ 3 of 42] Compiling Servant.API.ContentTypes ()
[15 of 42] Compiling Servant.Server.Internal ()
[42 of 42] Compiling Servant ()
Linking dist/build/servant/servant ...
Installing library in /home/user/.cabal/lib/servant-0.20
Registering library
Completed 3 action(s).
`;

const _STACK_BUILD_FAIL = `Resolving package versions...
[ 1 of 10] Compiling MyLib.Types
[ 2 of 10] Compiling MyLib.Api

src/MyLib/Api.hs:42:5: error:
    • Couldn't match type 'Int' with 'Text'
      Expected: Text
        Actual: Int
   |
42 |     myField = 42
   |               ^^
`;

const _CABAL_WARNINGS = `Preprocessing library for mylib-0.1.0.0..
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Warning: Module 'Data.MyLib.Internal' is listed in exposed-modules but cannot be found.
Completed 1 action(s).
`;

describe("TestHaskellFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_cabal", () => {
    const f = new HaskellFilter();
    expect(f.matches(["cabal", "build"])).toBe(true);
  });

  it("test_matches_stack", () => {
    const f = new HaskellFilter();
    expect(f.matches(["stack", "build"])).toBe(true);
  });

  it("test_matches_ghc", () => {
    const f = new HaskellFilter();
    expect(f.matches(["ghc", "Main.hs"])).toBe(true);
  });

  it("test_matches_runghc", () => {
    const f = new HaskellFilter();
    expect(f.matches(["runghc", "script.hs"])).toBe(true);
  });

  it("test_no_match_cargo", () => {
    const f = new HaskellFilter();
    expect(f.matches(["cargo", "build"])).toBe(false);
  });

  it("test_no_match_make", () => {
    const f = new HaskellFilter();
    expect(f.matches(["make"])).toBe(false);
  });

  // --- select -----------------------------------------------------------

  it("test_select_cabal", () => {
    expect(select_filter(["cabal", "build"]) instanceof HaskellFilter).toBe(true);
  });

  it("test_select_stack", () => {
    expect(select_filter(["stack", "build"]) instanceof HaskellFilter).toBe(true);
  });

  // --- compress: success path -------------------------------------------

  it("test_module_compilation_collapsed", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_BUILD_SUCCESS);
    expect(out.toLowerCase()).toContain("compiled");
    expect(out.toLowerCase()).toContain("module");
  });

  it("test_resolve_download_collapsed", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_BUILD_SUCCESS);
    expect(out.toLowerCase().includes("dependency") || out.toLowerCase().includes("resolution")).toBe(true);
  });

  it("test_success_summary_kept", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_BUILD_SUCCESS);
    expect(out).toContain("Completed 3 action(s)");
  });

  it("test_linking_collapsed", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_BUILD_SUCCESS);
    // Linking / installing / registering are collapsed — not dropped silently
    expect(
      out.toLowerCase().includes("linking") ||
        out.toLowerCase().includes("collapsed") ||
        out.toLowerCase().includes("step"),
    ).toBe(true);
  });

  it("test_individual_module_lines_removed", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_BUILD_SUCCESS);
    // Individual "[N of M] Compiling" lines should be collapsed
    expect(out).not.toContain("[ 1 of 42] Compiling");
    expect(out).not.toContain("[42 of 42] Compiling");
  });

  // --- compress: failure path -------------------------------------------

  it("test_ghc_error_kept", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _STACK_BUILD_FAIL, { exit_code: 1 });
    expect(out).toContain("Couldn't match type");
    expect(out).toContain("42:5: error");
  });

  it("test_error_preserved_on_failure", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _STACK_BUILD_FAIL, { exit_code: 1 });
    expect(out.toLowerCase()).toContain("error");
  });

  // --- compress: warnings deduplication -----------------------------------

  it("test_warning_dedup_keeps_first_three", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_WARNINGS);
    // Warning appears 4 times; first 3 should be kept
    const occurrences = _count(out, "Module 'Data.MyLib.Internal'");
    expect(occurrences).toBe(3);
  });

  it("test_warning_dedup_suppresses_fourth", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_WARNINGS);
    // Fourth occurrence must be deduplicated (marker emitted instead)
    expect(out.includes("deduplicated") || out.includes("repeated")).toBe(true);
  });

  it("test_success_summary_after_warnings_kept", () => {
    const f = new HaskellFilter();
    const out = _compress(f, _CABAL_WARNINGS);
    expect(out).toContain("Completed 1 action(s)");
  });
});

// ===========================================================================
// RCmdFilter
// ===========================================================================

const _R_CMD_CHECK_PASS = `* using R version 4.3.1 (2023-06-16)
* using platform: x86_64-pc-linux-gnu
* using session charset: UTF-8
* checking for file 'mypkg/DESCRIPTION' ... OK
* checking extension type ... Package
* this is package 'mypkg' version '1.0.0'
* checking package namespace information ... OK
* checking package dependencies ... OK
* checking if this is a source package ... OK
* checking if there is a namespace ... OK
* checking for executable files ... OK
* checking for hidden files and directories ... OK
* checking DESCRIPTION meta-information ... OK
* checking top-level files ... OK
* checking for left-over files ... OK
* checking index information ... OK
* checking package subdirectories ... OK
* checking R files for non-ASCII characters ... OK
* checking R files for syntax errors ... OK
* checking whether the package can be loaded ... OK
* checking whether the package can be loaded with stated dependencies ... OK
Loading required package: testthat
Attaching package: 'testthat'
* checking whether the package can be unloaded cleanly ... OK
* checking whether the namespace can be loaded with stated dependencies ... OK
* checking whether the namespace can be unloaded cleanly ... OK
* checking loading without being on the library search path ... OK
* checking use of SHLIB_EXT in Makefiles ... OK
* checking installed files from 'inst/doc' ... SKIPPED
* checking examples ... OK
* DONE (mypkg)

Status: OK
`;

const _R_CMD_CHECK_NOTE = `* checking for file 'mypkg/DESCRIPTION' ... OK
* checking package dependencies ... OK
* checking if this is a source package ... OK
* checking R files for syntax errors ... OK
* checking whether the package can be loaded ... OK
Loading required package: dplyr
Attaching package: 'dplyr'
* checking examples ... OK
* DONE (mypkg)

Status: 1 NOTE
* checking DESCRIPTION meta-information ... NOTE
Non-standard license specification:
  MIT + file LICENSE
Standardizable: FALSE
`;

const _R_CMD_CHECK_ERROR = `* checking for file 'mypkg/DESCRIPTION' ... OK
* checking package dependencies ... OK
* checking whether the package can be loaded ... OK
* running examples for arch 'x86_64'
  Running 'example.R' ... ERROR
Running examples in 'mypkg-Ex.R' failed
The error most likely occurred in:

> base::assign(".ptime", proc.time(), pos = "CheckExEnv")
> ### Name: my_function
> ### Title: My function
> my_function(NULL)
Error in my_function(NULL) : argument must not be NULL
`;

describe("TestRCmdFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_r_cmd", () => {
    const f = new RCmdFilter();
    expect(f.matches(["R", "CMD", "check", "mypkg"])).toBe(true);
  });

  it("test_matches_r_cmd_install", () => {
    const f = new RCmdFilter();
    expect(f.matches(["R", "CMD", "INSTALL", "."])).toBe(true);
  });

  it("test_matches_rscript", () => {
    const f = new RCmdFilter();
    expect(f.matches(["Rscript", "-e", "devtools::check()"])).toBe(true);
  });

  it("test_no_match_r_without_cmd", () => {
    // Plain `R` without CMD should not match
    const f = new RCmdFilter();
    expect(f.matches(["R"])).toBe(false);
  });

  it("test_no_match_ruby", () => {
    const f = new RCmdFilter();
    expect(f.matches(["ruby", "script.rb"])).toBe(false);
  });

  it("test_no_match_ruff", () => {
    const f = new RCmdFilter();
    expect(f.matches(["ruff", "check"])).toBe(false);
  });

  // --- select -----------------------------------------------------------

  it("test_select_r_cmd_check", () => {
    expect(select_filter(["R", "CMD", "check"]) instanceof RCmdFilter).toBe(true);
  });

  it("test_select_rscript", () => {
    expect(
      select_filter(["Rscript", "-e", "devtools::check()"]) instanceof RCmdFilter,
    ).toBe(true);
  });

  // --- compress: passing run -------------------------------------------

  it("test_ok_lines_collapsed", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_PASS);
    expect(out.includes("OK/SKIPPED") || out.toLowerCase().includes("checking")).toBe(true);
    // Individual "checking ... OK" lines should not all be present
    expect(_count(out, "... OK")).toBeLessThan(20); // 20 OK lines in input, should be collapsed
  });

  it("test_done_line_kept", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_PASS);
    expect(out).toContain("DONE (mypkg)");
  });

  it("test_status_ok_kept", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_PASS);
    expect(out).toContain("Status: OK");
  });

  it("test_namespace_loading_dropped", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_PASS);
    // "Loading required package: testthat" and "Attaching package:" should be dropped
    expect(out).not.toContain("Loading required package");
    expect(out).not.toContain("Attaching package");
  });

  it("test_collapsed_count_marker_present", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_PASS);
    // At least one collapsed-count marker should be emitted
    expect(out).toContain("token-goat");
  });

  // --- compress: NOTE / WARNING / ERROR -----------------------------------

  it("test_note_detail_kept", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_NOTE);
    expect(out).toContain("Non-standard license");
  });

  it("test_status_note_kept", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_NOTE);
    expect(out).toContain("Status: 1 NOTE");
  });

  it("test_note_header_kept", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_NOTE);
    expect(out).toContain("NOTE");
  });

  it("test_error_section_kept", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_ERROR, { exit_code: 1 });
    expect(out).toContain("Error in my_function");
  });

  it("test_running_examples_kept", () => {
    const f = new RCmdFilter();
    const out = _compress(f, _R_CMD_CHECK_ERROR, { exit_code: 1 });
    expect(out.toLowerCase().includes("running examples") || out.includes("Running 'example.R'")).toBe(true);
  });
});
