/**
 * Tests for RubyFilter, BundlerFilter, and CmakeFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_ruby_cmake.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports RubyFilter / BundlerFilter / CmakeFilter + select_filter).
 *  - `from filter_test_helpers import apply_filter as _apply`
 *      -> local `_apply(filter, stdout, opts?)` helper below; runs
 *         `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *         to `[filter_.name]` (matching the Python helper exactly).
 *
 * Byte-exactness: the assertions here are substring `in` / `not in` checks and
 * `percent_saved` ratio comparisons. The fixtures are pure ASCII so Python `len`
 * (code points) equals JS `.length` equals the UTF-8 byte count — no Buffer
 * arithmetic is needed for these inputs.
 */
import { describe, expect, it } from "vitest";

import {
  BundlerFilter,
  CmakeFilter,
  RubyFilter,
  select_filter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_apply` at the Python import site). When argv is omitted the filter's own
// `.name` is used as the sole argv element.
// ---------------------------------------------------------------------------
function _apply(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ===========================================================================
// RubyFilter — matches()
// ===========================================================================

describe("TestRubyFilterMatches", () => {
  it("test_rspec_matches", () => {
    const f = new RubyFilter();
    expect(f.matches(["rspec"])).toBeTruthy();
  });

  it("test_rspec_with_args_matches", () => {
    const f = new RubyFilter();
    expect(f.matches(["rspec", "spec/", "--format", "progress"])).toBeTruthy();
  });

  it("test_minitest_matches", () => {
    const f = new RubyFilter();
    expect(f.matches(["minitest"])).toBeTruthy();
  });

  it("test_ruby_matches", () => {
    const f = new RubyFilter();
    expect(f.matches(["ruby", "test/test_foo.rb"])).toBeTruthy();
  });

  it("test_rake_matches", () => {
    const f = new RubyFilter();
    expect(f.matches(["rake", "spec"])).toBeTruthy();
  });

  it("test_unrelated_command_does_not_match", () => {
    const f = new RubyFilter();
    expect(f.matches(["python", "test.py"])).toBeFalsy();
    expect(f.matches(["cargo", "test"])).toBeFalsy();
    expect(f.matches(["jest"])).toBeFalsy();
  });

  it("test_dispatch_routes_rspec", () => {
    const result = select_filter(["rspec"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("ruby");
  });

  it("test_dispatch_routes_rake", () => {
    const result = select_filter(["rake", "spec"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("ruby");
  });
});

// ===========================================================================
// RubyFilter — RSpec dot-progress compression
// ===========================================================================

const _RSPEC_ALL_PASSING = `Run options: include {:focus=>true}

All examples were skipped!

...................................................................................................

Finished in 0.5 seconds (files took 1.2 seconds to load)
100 examples, 0 failures
`;

const _RSPEC_WITH_FAILURES = `Run options: include {:focus=>true}

.....F..E...

Failures:

  1) MyClass#my_method does something
     Failure/Error: expect(result).to eq(42)

       expected: 42
            got: 0

     # ./spec/my_class_spec.rb:15:in \`block (2 levels) in <top (required)>'

  2) MyClass#other_method raises an error
     Failure/Error: raise "unexpected"

     RuntimeError:
       unexpected

Finished in 0.3 seconds (files took 0.8 seconds to load)
12 examples, 2 failures
`;

const _RSPEC_LONG_PASSING =
  ".".repeat(200).concat("\n").repeat(5) + "Finished in 2.1 seconds\n1000 examples, 0 failures\n";

describe("TestRubyFilterRSpec", () => {
  it("test_all_passing_dots_collapsed", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RSPEC_ALL_PASSING, argv: ["rspec"] });
    // Individual dot lines should not remain verbatim (the long dot string is gone).
    expect(out).not.toContain(".".repeat(50));
    expect(out).toContain("collapsed");
  });

  it("test_summary_line_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RSPEC_ALL_PASSING, argv: ["rspec"] });
    expect(out).toContain("100 examples, 0 failures");
  });

  it("test_finished_line_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RSPEC_ALL_PASSING, argv: ["rspec"] });
    expect(out).toContain("Finished in");
  });

  it("test_failure_section_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RSPEC_WITH_FAILURES, argv: ["rspec"] });
    expect(out).toContain("Failures:");
  });

  it("test_failure_message_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RSPEC_WITH_FAILURES, argv: ["rspec"] });
    expect(out).toContain("expected: 42");
    expect(out).toContain("got: 0");
  });

  it("test_failure_summary_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RSPEC_WITH_FAILURES, argv: ["rspec"] });
    expect(out).toContain("12 examples, 2 failures");
  });

  it("test_failure_chars_noted", () => {
    // F and E chars in the dot-progress line should trigger a visible note.
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RSPEC_WITH_FAILURES, argv: ["rspec"] });
    // The F and E chars should be signalled somehow.
    expect(out.includes("F") || out.includes("E")).toBeTruthy();
  });

  it("test_savings_ratio_large_run", () => {
    const f = new RubyFilter();
    const result = f.apply(_RSPEC_LONG_PASSING, "", 0, ["rspec"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });
});

// ===========================================================================
// RubyFilter — Minitest compression
// ===========================================================================

const _MINITEST_ALL_PASSING = `Run options: --seed 12345

# Running:

..............................................

Finished in 0.123456s, 365.3 runs/s, 730.7 assertions/s.

45 runs, 90 assertions, 0 failures, 0 errors, 0 skips
`;

const _MINITEST_WITH_FAILURE = `Run options: --seed 99999

# Running:

.F..

Failure:
MyTest#test_something [test/my_test.rb:10]:
Expected false to be truthy.

4 runs, 4 assertions, 1 failures, 0 errors, 0 skips
`;

describe("TestRubyFilterMinitest", () => {
  it("test_minitest_summary_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _MINITEST_ALL_PASSING, argv: ["ruby", "test/test_suite.rb"] });
    expect(out).toContain("45 runs");
    expect(out).toContain("0 failures");
  });

  it("test_minitest_dots_collapsed", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _MINITEST_ALL_PASSING, argv: ["ruby", "test/test_suite.rb"] });
    // The 46-char dot line should not pass through verbatim.
    expect(out).not.toContain(".".repeat(30));
  });

  it("test_minitest_failure_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _MINITEST_WITH_FAILURE, argv: ["ruby", "test/my_test.rb"] });
    expect(out).toContain("Expected false to be truthy");
  });

  it("test_minitest_failure_summary_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _MINITEST_WITH_FAILURE, argv: ["ruby", "test/my_test.rb"] });
    expect(out).toContain("1 failures");
  });
});

// ===========================================================================
// RubyFilter — rake pass-through
// ===========================================================================

const _RAKE_OUTPUT = `/path/to/file.rb:10:in \`foo': undefined method 'bar' (NoMethodError)
rake aborted!
`;

describe("TestRubyFilterRake", () => {
  it("test_rake_error_preserved", () => {
    const f = new RubyFilter();
    const out = _apply(f, { stdout: _RAKE_OUTPUT, argv: ["rake", "test"], exit_code: 1 });
    expect(out).toContain("NoMethodError");
    expect(out).toContain("rake aborted!");
  });
});

// ===========================================================================
// BundlerFilter — matches()
// ===========================================================================

describe("TestBundlerFilterMatches", () => {
  it("test_bundle_matches", () => {
    const f = new BundlerFilter();
    expect(f.matches(["bundle", "install"])).toBeTruthy();
  });

  it("test_bundler_matches", () => {
    const f = new BundlerFilter();
    expect(f.matches(["bundler"])).toBeTruthy();
  });

  it("test_bundle_update_matches", () => {
    const f = new BundlerFilter();
    expect(f.matches(["bundle", "update"])).toBeTruthy();
  });

  it("test_unrelated_does_not_match", () => {
    const f = new BundlerFilter();
    expect(f.matches(["npm", "install"])).toBeFalsy();
    expect(f.matches(["pip", "install"])).toBeFalsy();
  });

  it("test_dispatch_routes_bundle", () => {
    const result = select_filter(["bundle", "install"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("bundler");
  });
});

// ===========================================================================
// BundlerFilter — compression
// ===========================================================================

const _BUNDLE_INSTALL_OUTPUT = `Fetching gem metadata from https://rubygems.org/...........
Resolving dependencies...
Using rake 13.0.6
Using concurrent-ruby 1.1.10
Using i18n 1.12.0
Using minitest 5.15.0
Using tzinfo 2.0.5
Using activesupport 7.0.4
Using builder 3.2.4
Using erubi 1.11.0
Using rails-dom-testing 2.0.3
Using rack 2.2.5
Fetching rails 7.0.4
Fetching actionpack 7.0.4
Installing rails 7.0.4
Installing actionpack 7.0.4
Bundle complete! 5 Gemfile dependencies, 62 gems now installed.
Use \`bundle info [gemname]\` to see where a bundled gem is installed.
`;

const _BUNDLE_INSTALL_WITH_ERROR = `Using rake 13.0.6
Using concurrent-ruby 1.1.10
Fetching foo 1.0.0
Gem::RemoteFetcher::FetchError: bad response Forbidden 403 (https://rubygems.org/gems/foo-1.0.0.gem)
An error occurred while installing foo (1.0.0), and Bundler cannot continue.
`;

const _BUNDLE_BIG_INSTALL =
  Array.from({ length: 80 }, (_v, i) => `Using gem-${i} ${i}.0.0`).join("\n") +
  "\nBundle complete! 5 Gemfile dependencies, 80 gems now installed.\n";

describe("TestBundlerFilterCompress", () => {
  it("test_using_lines_collapsed", () => {
    const f = new BundlerFilter();
    const out = _apply(f, { stdout: _BUNDLE_INSTALL_OUTPUT, argv: ["bundle", "install"] });
    // No individual "Using <gem> <version>" lines should remain.
    expect(out).not.toContain("Using rake 13.0.6");
    expect(out).not.toContain("Using activesupport 7.0.4");
    // Collapse summary must appear.
    expect(out).toContain("collapsed");
    expect(out).toContain("Using gem");
  });

  it("test_fetching_installing_collapsed", () => {
    const f = new BundlerFilter();
    const out = _apply(f, { stdout: _BUNDLE_INSTALL_OUTPUT, argv: ["bundle", "install"] });
    expect(out).not.toContain("Fetching rails 7.0.4");
    expect(out).not.toContain("Installing rails 7.0.4");
    expect(out).toContain("Fetching/Installing gem");
  });

  it("test_bundle_complete_preserved", () => {
    const f = new BundlerFilter();
    const out = _apply(f, { stdout: _BUNDLE_INSTALL_OUTPUT, argv: ["bundle", "install"] });
    expect(out).toContain("Bundle complete!");
  });

  it("test_error_line_preserved", () => {
    const f = new BundlerFilter();
    const out = _apply(f, {
      stdout: _BUNDLE_INSTALL_WITH_ERROR,
      argv: ["bundle", "install"],
      exit_code: 1,
    });
    expect(out.includes("FetchError") || out.includes("Forbidden 403")).toBeTruthy();
  });

  it("test_bundler_error_install_line_preserved", () => {
    const f = new BundlerFilter();
    const out = _apply(f, {
      stdout: _BUNDLE_INSTALL_WITH_ERROR,
      argv: ["bundle", "install"],
      exit_code: 1,
    });
    expect(out).toContain("Bundler cannot continue");
  });

  it("test_savings_ratio_large_install", () => {
    const f = new BundlerFilter();
    const result = f.apply(_BUNDLE_BIG_INSTALL, "", 0, ["bundle", "install"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });
});

// ===========================================================================
// CmakeFilter — matches()
// ===========================================================================

describe("TestCmakeFilterMatches", () => {
  it("test_cmake_matches", () => {
    const f = new CmakeFilter();
    expect(f.matches(["cmake", "-S", ".", "-B", "build"])).toBeTruthy();
  });

  it("test_cmake_build_matches", () => {
    const f = new CmakeFilter();
    expect(f.matches(["cmake", "--build", "build"])).toBeTruthy();
  });

  it("test_ctest_matches", () => {
    const f = new CmakeFilter();
    expect(f.matches(["ctest", "--test-dir", "build"])).toBeTruthy();
  });

  it("test_cpack_matches", () => {
    const f = new CmakeFilter();
    expect(f.matches(["cpack"])).toBeTruthy();
  });

  it("test_unrelated_does_not_match", () => {
    const f = new CmakeFilter();
    expect(f.matches(["make"])).toBeFalsy();
    expect(f.matches(["ninja"])).toBeFalsy();
  });

  it("test_dispatch_routes_cmake", () => {
    const result = select_filter(["cmake", "--build", "."]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("cmake");
  });

  it("test_dispatch_routes_ctest", () => {
    const result = select_filter(["ctest"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("cmake");
  });
});

// ===========================================================================
// CmakeFilter — configure-phase compression
// ===========================================================================

const _CMAKE_CONFIGURE_OUTPUT = `-- The C compiler identification is GNU 11.4.0
-- The CXX compiler identification is GNU 11.4.0
-- Detecting C compiler ABI info
-- Detecting C compiler ABI info - done
-- Check for working C compiler: /usr/bin/cc - skipped
-- Detecting C compile features
-- Detecting C compile features - done
-- Found PkgConfig: /usr/bin/pkg-config (found version "0.29.2")
-- Found OpenSSL: /usr/lib/x86_64-linux-gnu/libcrypto.so (found version "3.0.2")
-- Found ZLIB: /usr/lib/x86_64-linux-gnu/libz.so (found version "1.2.11")
-- Found Threads: TRUE
-- Found Boost: /usr/include (found version "1.74.0")
-- Configuring done (1.5s)
-- Generating done (0.2s)
-- Build files have been written to: /path/to/build
`;

const _CMAKE_CONFIGURE_LARGE =
  '-- The CXX compiler identification is Clang 14.0\n' +
  Array.from({ length: 30 }, (_v, i) => `-- Found Pkg${i}: /usr/lib/libpkg${i}.so`).join("\n") +
  "\n-- Configuring done (3.2s)\n" +
  "-- Build files have been written to: /path/to/build\n";

describe("TestCmakeFilterConfigure", () => {
  it("test_configuring_done_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, {
      stdout: _CMAKE_CONFIGURE_OUTPUT,
      argv: ["cmake", "-S", ".", "-B", "build"],
    });
    expect(out).toContain("Configuring done");
  });

  it("test_build_files_written_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, {
      stdout: _CMAKE_CONFIGURE_OUTPUT,
      argv: ["cmake", "-S", ".", "-B", "build"],
    });
    expect(out).toContain("Build files have been written");
  });

  it("test_found_packages_collapsed", () => {
    const f = new CmakeFilter();
    const out = _apply(f, {
      stdout: _CMAKE_CONFIGURE_OUTPUT,
      argv: ["cmake", "-S", ".", "-B", "build"],
    });
    // Individual "-- Found X: ..." lines should be collapsed.
    expect(out).not.toContain("-- Found OpenSSL");
    expect(out).not.toContain("-- Found ZLIB");
    expect(out.includes("Found") && out.includes("packages")).toBeTruthy();
  });

  it("test_found_packages_count", () => {
    const f = new CmakeFilter();
    const out = _apply(f, {
      stdout: _CMAKE_CONFIGURE_OUTPUT,
      argv: ["cmake", "-S", ".", "-B", "build"],
    });
    // 5 Found lines: PkgConfig, OpenSSL, ZLIB, Threads, Boost
    expect(out).toContain("5");
  });

  it("test_first_probe_lines_kept", () => {
    const f = new CmakeFilter();
    const out = _apply(f, {
      stdout: _CMAKE_CONFIGURE_OUTPUT,
      argv: ["cmake", "-S", ".", "-B", "build"],
    });
    // The first compiler identification line should still be there.
    expect(out).toContain("C compiler identification");
  });

  it("test_large_configure_collapses_found", () => {
    const f = new CmakeFilter();
    const out = _apply(f, {
      stdout: _CMAKE_CONFIGURE_LARGE,
      argv: ["cmake", "-S", ".", "-B", "build"],
    });
    // 30 "Found Pkg..." lines should be collapsed to a single count note.
    expect(out.includes("30") || out.includes("packages")).toBeTruthy();
    expect(out).not.toContain("-- Found Pkg0");
  });

  it("test_savings_ratio_configure", () => {
    const f = new CmakeFilter();
    const result = f.apply(_CMAKE_CONFIGURE_LARGE, "", 0, ["cmake", "-S", ".", "-B", "build"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });
});

// ===========================================================================
// CmakeFilter — build-phase compression
// ===========================================================================

const _CMAKE_BUILD_OUTPUT = `[  5%] Building CXX object CMakeFiles/myapp.dir/src/main.cpp.o
[ 10%] Building CXX object CMakeFiles/myapp.dir/src/foo.cpp.o
[ 15%] Building CXX object CMakeFiles/myapp.dir/src/bar.cpp.o
[ 20%] Building CXX object CMakeFiles/myapp.dir/src/baz.cpp.o
[ 50%] Building CXX object CMakeFiles/myapp.dir/src/qux.cpp.o
[ 75%] Linking CXX executable myapp
[ 80%] Building CXX object CMakeFiles/tests.dir/test/test_foo.cpp.o
[100%] Linking CXX executable tests
[100%] Built target myapp
[100%] Built target tests
`;

const _CMAKE_BUILD_WITH_ERROR = `[  5%] Building CXX object CMakeFiles/myapp.dir/src/main.cpp.o
/path/to/src/main.cpp:10:5: error: 'undefined_var' was not declared in this scope
[ 10%] Building CXX object CMakeFiles/myapp.dir/src/foo.cpp.o
`;

describe("TestCmakeFilterBuild", () => {
  it("test_building_lines_collapsed", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CMAKE_BUILD_OUTPUT, argv: ["cmake", "--build", "build"] });
    // Individual "[N%] Building CXX object ..." lines should be collapsed.
    expect(out).not.toContain("[  5%] Building CXX object");
    expect(out).not.toContain("[ 10%] Building CXX object");
    expect(out).toContain("collapsed");
  });

  it("test_linking_lines_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CMAKE_BUILD_OUTPUT, argv: ["cmake", "--build", "build"] });
    expect(out).toContain("Linking CXX executable myapp");
  });

  it("test_built_target_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CMAKE_BUILD_OUTPUT, argv: ["cmake", "--build", "build"] });
    expect(out).toContain("Built target myapp");
    expect(out).toContain("Built target tests");
  });

  it("test_error_line_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, {
      stdout: _CMAKE_BUILD_WITH_ERROR,
      argv: ["cmake", "--build", "build"],
      exit_code: 1,
    });
    expect(out).toContain("error: 'undefined_var' was not declared");
  });

  it("test_last_percent_line_noted", () => {
    // The last [N%] Building line should appear in the compression note.
    const f = new CmakeFilter();
    const result = f.apply(_CMAKE_BUILD_OUTPUT, "", 0, ["cmake", "--build", "build"]);
    // The note should reference the last "[N%] Building" line we saw.
    expect(result.text.includes("[ 50%]") || result.text.includes("5")).toBeTruthy(); // at least one number present
  });

  it("test_savings_ratio_build", () => {
    const ranges: number[] = [];
    for (let pct = 1; pct <= 100; pct += 1) {
      ranges.push(pct);
    }
    let big_build = ranges
      .map(
        (pct, i) =>
          `[${String(pct).padStart(3, " ")}%] Building CXX object CMakeFiles/myapp.dir/src/file${i}.cpp.o`,
      )
      .join("\n");
    big_build += "\n[100%] Built target myapp\n";
    const f = new CmakeFilter();
    const result = f.apply(big_build, "", 0, ["cmake", "--build", "build"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });
});

// ===========================================================================
// CmakeFilter — ctest compression
// ===========================================================================

const _CTEST_ALL_PASSING = `Test project /path/to/build
    Start 1: TestAddition
1/4 Test #1: TestAddition ........................   Passed    0.01 sec
    Start 2: TestSubtraction
2/4 Test #2: TestSubtraction .....................   Passed    0.02 sec
    Start 3: TestMultiplication
3/4 Test #3: TestMultiplication ..................   Passed    0.01 sec
    Start 4: TestDivision
4/4 Test #4: TestDivision ........................   Passed    0.03 sec

100% tests passed, 0 tests failed out of 4

Total Test time (real) =   0.07 sec
`;

const _CTEST_WITH_FAILURE = `Test project /path/to/build
    Start 1: TestAddition
1/3 Test #1: TestAddition ........................   Passed    0.01 sec
    Start 2: TestBadMath
2/3 Test #2: TestBadMath .........................***Failed    0.05 sec
    Start 3: TestSubtraction
3/3 Test #3: TestSubtraction .....................   Passed    0.02 sec

67% tests passed, 1 tests failed out of 3

The following tests FAILED:
\t  2 - TestBadMath (Failed)
Errors while running CTest
`;

describe("TestCmakeFilterCtest", () => {
  it("test_all_passing_collapsed", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CTEST_ALL_PASSING, argv: ["ctest"] });
    // Individual "N/N Test #N: ... Passed" result lines should be collapsed.
    expect(out).not.toContain("1/4 Test #1: TestAddition");
    expect(out).toContain("collapsed");
    expect(out).toContain("passing");
  });

  it("test_ctest_summary_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CTEST_ALL_PASSING, argv: ["ctest"] });
    expect(out).toContain("100% tests passed");
  });

  it("test_failing_test_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CTEST_WITH_FAILURE, argv: ["ctest"], exit_code: 8 });
    expect(out).toContain("TestBadMath");
    expect(out).toContain("Failed");
  });

  it("test_failure_summary_preserved", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CTEST_WITH_FAILURE, argv: ["ctest"], exit_code: 8 });
    expect(out).toContain("67% tests passed");
  });

  it("test_passing_tests_before_failure_not_individually_shown", () => {
    const f = new CmakeFilter();
    const out = _apply(f, { stdout: _CTEST_WITH_FAILURE, argv: ["ctest"], exit_code: 8 });
    // TestAddition passed and should be in the collapsed count, not shown individually.
    expect(out).not.toContain("1/3 Test #1: TestAddition");
  });

  it("test_savings_ratio_large_ctest", () => {
    const lines = Array.from(
      { length: 50 },
      (_v, i) => `1/${i + 1} Test #${i + 1}: TestFoo${i} ...... Passed    0.01 sec`,
    );
    const big_ctest =
      "Test project /path/to/build\n" +
      lines.join("\n") +
      "\n100% tests passed, 0 tests failed out of 50\n";
    const f = new CmakeFilter();
    const result = f.apply(big_ctest, "", 0, ["ctest"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });
});
