/**
 * Tests for C/C++ tool filters: ConanFilter, VcpkgFilter, CppcheckFilter,
 * ClangTidyFilter.
 *
 * 1:1 port of tests/test_bash_compress_cpp_tools.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes (TestConanFilter, TestVcpkgFilter, TestCppcheckFilter,
 * TestClangTidyFilter) map to `describe()` blocks of the same name.
 *
 * Run 9 un-deferral: all four filters (ConanFilter, VcpkgFilter, CppcheckFilter,
 * ClangTidyFilter) now ship from "./bash_compress/cpp.js" via the barrel, so
 * every previously-deferred `it.skip` is filled in and activated. The
 * FilterTestMixin's two injected tests (test_empty_input + test_empty_output)
 * are reproduced per describe block via filterTestMixin().
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports ConanFilter/VcpkgFilter/CppcheckFilter/ClangTidyFilter +
 *        select_filter).
 *  - `from filter_test_helpers import FilterTestMixin`
 *      -> the mixin injects test_empty_input + test_empty_output into every
 *        subclass; reproduced here by filterTestMixin() emitting both it()s.
 *  - `_apply(filter_, stdout="", stderr="", exit_code=0)` runs
 *    `filter_.apply(stdout, stderr, exit_code, argv).text` with
 *    `argv = [next(iter(filter_.binaries))]` — i.e. the first declared binary.
 *    JS Set preserves insertion order, so [...filter_.binaries][0] is the
 *    Python `next(iter(...))` equivalent (conan / vcpkg / cppcheck / clang-tidy).
 *
 * Byte-exactness: the four filters override _compress_body (Conan/Vcpkg, with
 * error_passthrough=true) or compress (Cppcheck/ClangTidy) and call
 * this._combine_output(stdout, stderr) internally, so stderr diagnostics flow
 * into the compressed text exactly as in Python. The assertions are substring
 * in / not in checks and compressed_bytes < original_bytes comparisons (UTF-8
 * byte counts on the CompressedOutput, read off result.compressed_bytes /
 * result.original_bytes directly — no String.length arithmetic needed).
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  ClangTidyFilter,
  ConanFilter,
  CppcheckFilter,
  VcpkgFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// Referenced so the barrel namespace import is not flagged as unused.
void bc;

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of the Python module-level `_apply`). When
// argv is omitted the filter's first declared binary is used (Python:
// `next(iter(filter_.binaries))`; JS: spread the ReadonlySet and take [0]).
// ---------------------------------------------------------------------------
function _apply(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = [...filter_.binaries];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ---------------------------------------------------------------------------
// FilterTestMixin — injects test_empty_input + test_empty_output into every
// subclass (each subclass sets a class-level `F = bc.<X>Filter()`). Ported as a
// helper that emits both it()s against the supplied fresh filter instance.
// ---------------------------------------------------------------------------
function filterTestMixin(F: () => Filter): void {
  it("test_empty_input", () => {
    const result = _apply(F());
    expect(result).toBe("");
  });

  it("test_empty_output", () => {
    const f = F();
    const result = f.apply("some output\n", "", 0, [...f.binaries]).text;
    expect(result).toContain("some output");
  });
}

// ===========================================================================
// ConanFilter
// ===========================================================================

const _CONAN_LIFECYCLE_LINES: string = [
  "zlib/1.2.13: Calling build()",
  "zlib/1.2.13: Package 'abc123def456' created",
  "openssl/3.0.7: Calling build()",
  "openssl/3.0.7: Package 'deadbeef1234' created",
  "boost/1.82.0: Calling build()",
  "boost/1.82.0: Package '12345678abcd' already exists",
].join("\n");

const _CONAN_OUTPUT: string = [
  "Configuration:",
  "[settings]",
  "  os=Linux",
  "Requirements",
  "    zlib/1.2.13 from 'conancenter' - Cache",
  "    openssl/3.0.7 from 'conancenter' - Download",
  "    boost/1.82.0 from 'conancenter' - Cache",
  "Packages",
  "    zlib/1.2.13:abc123 - Cache",
  _CONAN_LIFECYCLE_LINES,
  "zlib/1.2.13: Copying",
  "zlib/1.2.13: Generating the package",
  "Install finished",
].join("\n");

describe("TestConanFilter", () => {
  filterTestMixin(() => new ConanFilter());

  it("test_matches_conan", () => {
    const f = new ConanFilter();
    expect(f.matches(["conan", "install", "."])).toBe(true);
  });

  it("test_matches_conan2", () => {
    const f = new ConanFilter();
    expect(f.matches(["conan2", "create", "."])).toBe(true);
  });

  it("test_does_not_match_cmake", () => {
    const f = new ConanFilter();
    expect(f.matches(["cmake", "--build", "."])).toBe(false);
  });

  it("test_select_returns_conan_filter", () => {
    const f = bc.select_filter(["conan", "install", "."]);
    expect(f instanceof ConanFilter).toBe(true);
  });

  it("test_lifecycle_lines_collapsed", () => {
    const result = _apply(new ConanFilter(), { stdout: _CONAN_OUTPUT });
    // The raw "Calling build()" lines should not appear verbatim.
    expect(result).not.toContain("Calling build()");
    // But the collapse note should be present.
    expect(result.toLowerCase()).toContain("collapsed");
    expect(result.toLowerCase()).toContain("conan progress");
  });

  it("test_requirements_block_kept", () => {
    const result = _apply(new ConanFilter(), { stdout: _CONAN_OUTPUT });
    expect(result).toContain("Requirements");
  });

  it("test_packages_block_kept", () => {
    const result = _apply(new ConanFilter(), { stdout: _CONAN_OUTPUT });
    expect(result).toContain("Packages");
  });

  it("test_install_finished_kept", () => {
    const result = _apply(new ConanFilter(), { stdout: _CONAN_OUTPUT });
    expect(result).toContain("Install finished");
  });

  it("test_errors_kept_on_failure", () => {
    const output: string = [
      "zlib/1.2.13: Calling build()",
      "zlib/1.2.13: ERROR: Package binary not found",
      "Install finished",
    ].join("\n");
    // ConanFilter has error_passthrough=true, but stderr is empty here so the
    // short-circuit does not fire; _compress_body keeps the ERROR line.
    const result = new ConanFilter().apply(output, "", 1, ["conan", "install", "."]).text;
    expect(result).toContain("ERROR: Package binary not found");
  });

  it("test_compression_ratio", () => {
    const result = new ConanFilter().apply(_CONAN_OUTPUT, "", 0, ["conan", "install", "."]);
    expect(result.compressed_bytes).toBeLessThan(result.original_bytes);
  });

  it("test_no_false_collapse_on_clean_output", () => {
    const output = "Install finished\n";
    const result = _apply(new ConanFilter(), { stdout: output });
    expect(result).toContain("Install finished");
    expect(result.toLowerCase()).not.toContain("collapsed");
  });

  it("test_copying_lines_collapsed", () => {
    const output: string = [
      "zlib/1.2.13: Copying",
      "openssl/3.0.7: Copying",
      "Install finished",
    ].join("\n");
    const result = _apply(new ConanFilter(), { stdout: output });
    expect(result).not.toContain("Copying");
    expect(result.toLowerCase()).toContain("collapsed");
  });
});

// ===========================================================================
// VcpkgFilter
// ===========================================================================

const _VCPKG_PROGRESS_LINES: string = [
  "Building zlib:x64-linux...",
  "Installing zlib:x64-linux...",
  "Building openssl:x64-linux...",
  "Installing openssl:x64-linux...",
  "Building boost-filesystem:x64-linux...",
  "Installing boost-filesystem:x64-linux...",
].join("\n");

const _VCPKG_OUTPUT: string = [
  "The following packages will be built and installed:",
  "    zlib[core]:x64-linux",
  "    openssl[core]:x64-linux",
  "    boost-filesystem[core]:x64-linux",
  _VCPKG_PROGRESS_LINES,
  "  -- Extracting source /root/.cache/vcpkg/downloads/zlib-1.2.13.tar.gz",
  "  -- Applying patch zlib-0001-msvc.patch",
  "Elapsed time for package zlib:x64-linux: 12.3 s",
  "Elapsed time for package openssl:x64-linux: 45.6 s",
  "Total install time: 58.1 s",
  'CMake projects should use: "-DCMAKE_TOOLCHAIN_FILE=..."',
].join("\n");

describe("TestVcpkgFilter", () => {
  filterTestMixin(() => new VcpkgFilter());

  it("test_matches_vcpkg", () => {
    const f = new VcpkgFilter();
    expect(f.matches(["vcpkg", "install", "zlib"])).toBe(true);
  });

  it("test_does_not_match_cmake", () => {
    const f = new VcpkgFilter();
    expect(f.matches(["cmake", "--build", "."])).toBe(false);
  });

  it("test_select_returns_vcpkg_filter", () => {
    const f = bc.select_filter(["vcpkg", "install", "zlib"]);
    expect(f instanceof VcpkgFilter).toBe(true);
  });

  it("test_building_lines_collapsed", () => {
    const result = _apply(new VcpkgFilter(), { stdout: _VCPKG_OUTPUT });
    expect(result).not.toContain("Building zlib:x64-linux...");
    expect(result.toLowerCase()).toContain("collapsed");
  });

  it("test_installing_lines_collapsed", () => {
    const result = _apply(new VcpkgFilter(), { stdout: _VCPKG_OUTPUT });
    expect(result).not.toContain("Installing openssl:x64-linux...");
  });

  it("test_plan_block_kept", () => {
    const result = _apply(new VcpkgFilter(), { stdout: _VCPKG_OUTPUT });
    expect(result).toContain("The following packages will be built and installed");
  });

  it("test_total_install_time_kept", () => {
    const result = _apply(new VcpkgFilter(), { stdout: _VCPKG_OUTPUT });
    expect(result).toContain("Total install time");
  });

  it("test_cmake_toolchain_hint_kept", () => {
    const result = _apply(new VcpkgFilter(), { stdout: _VCPKG_OUTPUT });
    expect(result).toContain("CMake projects should use");
  });

  it("test_elapsed_time_dropped", () => {
    const result = _apply(new VcpkgFilter(), { stdout: _VCPKG_OUTPUT });
    expect(result).not.toContain("Elapsed time for package");
  });

  it("test_substep_lines_collapsed", () => {
    const result = _apply(new VcpkgFilter(), { stdout: _VCPKG_OUTPUT });
    expect(result).not.toContain("-- Extracting source");
    expect(result.toLowerCase()).toContain("sub-step");
  });

  it("test_errors_kept_on_failure", () => {
    const output: string = [
      "Building zlib:x64-linux...",
      "error: building package zlib:x64-linux failed with: BUILD_FAILED",
    ].join("\n");
    // VcpkgFilter has error_passthrough=true; stderr is empty here so the
    // short-circuit does not fire and _compress_body keeps the error line.
    const result = new VcpkgFilter().apply(output, "", 1, ["vcpkg", "install", "zlib"]).text;
    expect(result).toContain("BUILD_FAILED");
  });

  it("test_compression_ratio", () => {
    const result = new VcpkgFilter().apply(_VCPKG_OUTPUT, "", 0, ["vcpkg", "install", "zlib"]);
    expect(result.compressed_bytes).toBeLessThan(result.original_bytes);
  });

  it("test_already_installed_kept", () => {
    const output = "Package zlib:x64-linux is already installed\n";
    const result = _apply(new VcpkgFilter(), { stdout: output });
    expect(result).toContain("already installed");
  });
});

// ===========================================================================
// CppcheckFilter
// ===========================================================================

const _CPPCHECK_DIAG_LINES: string = [
  "[src/main.cpp:42]: (error) Null pointer dereference: ptr",
  "[src/util.cpp:17]: (warning) Variable 'x' is assigned a value that is never used",
  "[include/foo.h:8]: (style) The function 'foo' is never used",
].join("\n");

const _CPPCHECK_OUTPUT: string = [
  "Checking src/main.cpp...",
  "1/3 files checked 33% done",
  "Checking src/util.cpp...",
  "2/3 files checked 67% done",
  "Checking include/foo.h...",
  "3/3 files checked 100% done",
  _CPPCHECK_DIAG_LINES,
  "4 errors",
].join("\n");

// cppcheck typically writes diagnostics to stderr.
const _CPPCHECK_STDERR: string = [
  "Checking src/main.cpp...",
  "1/2 files checked 50% done",
  "Checking src/util.cpp...",
  "2/2 files checked 100% done",
  "[src/main.cpp:10]: (error) Memory leak: buf",
  "[src/util.cpp:5]: (warning) Unused variable: x",
  "2 errors",
].join("\n");

describe("TestCppcheckFilter", () => {
  filterTestMixin(() => new CppcheckFilter());

  it("test_matches_cppcheck", () => {
    const f = new CppcheckFilter();
    expect(f.matches(["cppcheck", "--enable=all", "src/"])).toBe(true);
  });

  it("test_does_not_match_clang", () => {
    const f = new CppcheckFilter();
    expect(f.matches(["clang", "-c", "foo.cpp"])).toBe(false);
  });

  it("test_select_returns_cppcheck_filter", () => {
    const f = bc.select_filter(["cppcheck", "src/"]);
    expect(f instanceof CppcheckFilter).toBe(true);
  });

  it("test_checking_progress_collapsed", () => {
    const result = _apply(new CppcheckFilter(), { stdout: _CPPCHECK_OUTPUT });
    expect(result).not.toContain("Checking src/main.cpp...");
    expect(result.toLowerCase()).toContain("collapsed");
  });

  it("test_percentage_progress_dropped", () => {
    const result = _apply(new CppcheckFilter(), { stdout: _CPPCHECK_OUTPUT });
    expect(result).not.toContain("files checked");
  });

  it("test_error_diagnostics_kept", () => {
    const result = _apply(new CppcheckFilter(), { stdout: _CPPCHECK_OUTPUT });
    expect(result).toContain("[src/main.cpp:42]: (error) Null pointer dereference: ptr");
  });

  it("test_warning_diagnostics_kept", () => {
    const result = _apply(new CppcheckFilter(), { stdout: _CPPCHECK_OUTPUT });
    expect(result).toContain("[src/util.cpp:17]: (warning)");
  });

  it("test_style_diagnostics_kept", () => {
    const result = _apply(new CppcheckFilter(), { stdout: _CPPCHECK_OUTPUT });
    expect(result).toContain("[include/foo.h:8]: (style)");
  });

  it("test_summary_line_kept", () => {
    const result = _apply(new CppcheckFilter(), { stdout: _CPPCHECK_OUTPUT });
    expect(result).toContain("4 errors");
  });

  it("test_stderr_diagnostics_kept", () => {
    // CppcheckFilter.compress combines stdout+stderr internally.
    const result = _apply(new CppcheckFilter(), { stderr: _CPPCHECK_STDERR });
    expect(result).toContain("[src/main.cpp:10]: (error) Memory leak: buf");
  });

  it("test_compression_ratio", () => {
    const result = new CppcheckFilter().apply(_CPPCHECK_OUTPUT, "", 0, ["cppcheck", "src/"]);
    expect(result.compressed_bytes).toBeLessThan(result.original_bytes);
  });

  it("test_no_errors_clean_run", () => {
    const output: string = [
      "Checking src/main.cpp...",
      "1/1 files checked 100% done",
      "No errors found",
    ].join("\n");
    const result = _apply(new CppcheckFilter(), { stdout: output });
    expect(result).toContain("No errors found");
    expect(result).not.toContain("Checking src/main.cpp...");
  });

  it("test_no_false_collapse_on_only_diagnostics", () => {
    const output = "[src/foo.cpp:1]: (error) division by zero\n";
    const result = _apply(new CppcheckFilter(), { stdout: output });
    expect(result).toContain("[src/foo.cpp:1]: (error) division by zero");
    // No collapse note because there was nothing to collapse.
    expect(result.toLowerCase()).not.toContain("collapsed");
  });
});

// ===========================================================================
// ClangTidyFilter
// ===========================================================================

const _CLANG_TIDY_DIAGS: string = [
  "src/main.cpp:10:5: warning: use of 'strcpy' is insecure [clang-analyzer-security.insecureAPI.strcpy]",
  "    strcpy(buf, input);",
  "    ^~~~~~~~~~~~~~~~~~",
  "src/util.cpp:25:3: error: variable 'x' has indeterminate value when used here [clang-diagnostic-uninitialized]",
  "  int x;",
  "  ^",
  "src/util.cpp:30:1: note: uninitialized use of 'x' here",
].join("\n");

const _CLANG_TIDY_OUTPUT: string = [
  "1 warning generated.",
  "2 warnings generated.",
  "In file included from src/main.cpp:3:",
  "In file included from /usr/include/string.h:1:",
  _CLANG_TIDY_DIAGS,
  "clang-tidy: 3 warnings generated.",
].join("\n");

const _CLANG_TIDY_STDERR_PROGRESS: string = [
  "clang-tidy: Processing 5 files...",
  "src/main.cpp:10:5: warning: use of 'strcpy' is insecure [security.insecureAPI.strcpy]",
  "1 warning generated.",
].join("\n");

describe("TestClangTidyFilter", () => {
  filterTestMixin(() => new ClangTidyFilter());

  it("test_matches_clang_tidy", () => {
    const f = new ClangTidyFilter();
    expect(f.matches(["clang-tidy", "src/main.cpp"])).toBe(true);
  });

  it("test_matches_run_clang_tidy", () => {
    const f = new ClangTidyFilter();
    expect(f.matches(["run-clang-tidy", "-p", "build/"])).toBe(true);
  });

  it("test_does_not_match_clang", () => {
    // plain `clang` is not clang-tidy.
    const f = new ClangTidyFilter();
    expect(f.matches(["clang", "-c", "foo.cpp"])).toBe(false);
  });

  it("test_select_returns_clang_tidy_filter", () => {
    const f = bc.select_filter(["clang-tidy", "src/main.cpp"]);
    expect(f instanceof ClangTidyFilter).toBe(true);
  });

  it("test_diagnostic_headers_kept", () => {
    const result = _apply(new ClangTidyFilter(), { stdout: _CLANG_TIDY_OUTPUT });
    expect(result).toContain("src/main.cpp:10:5: warning: use of 'strcpy'");
  });

  it("test_error_diagnostic_kept", () => {
    const result = _apply(new ClangTidyFilter(), { stdout: _CLANG_TIDY_OUTPUT });
    expect(result).toContain("src/util.cpp:25:3: error:");
  });

  it("test_note_line_kept", () => {
    const result = _apply(new ClangTidyFilter(), { stdout: _CLANG_TIDY_OUTPUT });
    expect(result).toContain("note: uninitialized use");
  });

  it("test_warnings_generated_collapsed", () => {
    const result = _apply(new ClangTidyFilter(), { stdout: _CLANG_TIDY_OUTPUT });
    // The raw "N warnings generated." lines should be collapsed.
    expect(result).not.toContain("1 warning generated.");
    expect(result.toLowerCase()).toContain("collapsed");
    expect(result.toLowerCase()).toContain("warnings generated");
  });

  it("test_include_chains_collapsed", () => {
    const result = _apply(new ClangTidyFilter(), { stdout: _CLANG_TIDY_OUTPUT });
    // The actual include-chain lines should not appear verbatim as source lines.
    // (The collapse note mentions the phrase — check the lines directly instead.)
    const result_lines = result.split(/\r?\n/);
    const include_source_lines = result_lines.filter((ln) =>
      ln.startsWith("In file included from"),
    );
    expect(include_source_lines).toEqual([]);
    // The collapse marker note should mention the chains.
    expect(result.toLowerCase()).toContain("included from");
  });

  it("test_summary_line_kept", () => {
    const result = _apply(new ClangTidyFilter(), { stdout: _CLANG_TIDY_OUTPUT });
    expect(result).toContain("clang-tidy: 3 warnings generated.");
  });

  it("test_processing_progress_dropped", () => {
    // ClangTidyFilter.compress combines stdout+stderr internally.
    const result = _apply(new ClangTidyFilter(), { stderr: _CLANG_TIDY_STDERR_PROGRESS });
    expect(result).not.toContain("clang-tidy: Processing 5 files...");
  });

  it("test_compression_ratio_on_verbose_output", () => {
    // Build a realistic-sized output with many progress/include/context lines
    // so compression savings exceed the marker overhead.
    const noise: string = [
      ...Array.from({ length: 20 }, (_v, i) => `${i + 1} warning generated.`),
      ...Array.from({ length: 10 }, (_v, i) => `In file included from header_${i}.h:1:`),
    ].join("\n");
    const output: string = [
      noise,
      "src/foo.cpp:5:3: warning: use after free [clang-analyzer-cplusplus.NewDelete]",
      "  bad();",
      "  ^",
    ].join("\n");
    const result = new ClangTidyFilter().apply(output, "", 0, ["clang-tidy", "src/foo.cpp"]);
    expect(result.compressed_bytes).toBeLessThan(result.original_bytes);
  });

  it("test_no_diagnostics_clean_run", () => {
    const output = "2 warnings generated.\n";
    const result = _apply(new ClangTidyFilter(), { stdout: output });
    // Collapsed — but no diagnostic content so nothing else kept.
    expect(result).not.toContain("2 warnings generated.");
    expect(result.toLowerCase()).toContain("collapsed");
  });

  it("test_context_lines_partially_kept", () => {
    // The first context line (source code) after a diagnostic should be kept,
    // subsequent caret/source lines should be dropped.
    const output: string = [
      "src/foo.cpp:5:3: warning: some warning [some-check]",
      "  bad_code();", // first context line — should be kept
      "  ^~~~~~~~~~", // caret line — may be dropped (second context)
      "  more_context();", // additional context — dropped
      "1 warning generated.",
    ].join("\n");
    const result = _apply(new ClangTidyFilter(), { stdout: output });
    // The diagnostic header must always be present.
    expect(result).toContain("src/foo.cpp:5:3: warning: some warning");
    // Some context lines are dropped (context_dropped counter fires).
    expect(
      result.toLowerCase().includes("dropped") ||
        result.toLowerCase().includes("context") ||
        result.toLowerCase().includes("caret"),
    ).toBe(true);
  });
});
