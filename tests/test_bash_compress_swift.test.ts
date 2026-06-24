/**
 * Tests for SwiftFilter and XcodeFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_swift.py. Every Python `def test_*` maps
 * to a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes (TestSwiftFilterApplies, TestSwiftFilterBuild, TestSwiftFilterTests,
 * TestXcodeFilterApplies, TestXcodeFilterBuild) map to `describe()` blocks of the
 * same name. Module-level `def test_*` functions map to top-level `it()`s.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + SwiftFilter/XcodeFilter from
 *        ./bash_compress/mobile.js, plus FILTERS / select_filter / filter_by_name).
 *  - `f.matches(argv)` -> `f.matches(argv)` (framework method).
 *  - `f.apply(stdout, stderr, exit_code, argv).text` -> identical; `.text` is a
 *    field and `.percent_saved` is a getter on CompressedOutput.
 *
 * Byte-exactness: the fixtures are pure ASCII (incl. literal `\t` tabs), so
 * Python `len` (code points) equals JS `.length` for the savings math; the
 * filters compute their own ratios via UTF-8 Buffer arithmetic internally and we
 * only read `percent_saved`, so no Buffer math is needed in this test.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// SwiftFilter — applies()
// ---------------------------------------------------------------------------

describe("TestSwiftFilterApplies", () => {
  it("test_swift_build_matches", () => {
    const f = new bc.SwiftFilter();
    expect(f.matches(["swift", "build"])).toBe(true);
  });

  it("test_swift_test_matches", () => {
    const f = new bc.SwiftFilter();
    expect(f.matches(["swift", "test"])).toBe(true);
  });

  it("test_swift_run_matches", () => {
    const f = new bc.SwiftFilter();
    expect(f.matches(["swift", "run"])).toBe(true);
  });

  it("test_swift_package_matches", () => {
    const f = new bc.SwiftFilter();
    expect(f.matches(["swift", "package", "resolve"])).toBe(true);
  });

  it("test_swiftc_does_not_match", () => {
    // swiftc is not the swift CLI; SwiftFilter only matches 'swift'.
    const f = new bc.SwiftFilter();
    // swiftc is a separate binary — no subcommand; SwiftFilter requires one
    // of build/test/run/package as subcommand.
    expect(f.matches(["swiftc", "main.swift"])).toBe(false);
  });

  it("test_swift_without_subcommand_does_not_match", () => {
    const f = new bc.SwiftFilter();
    expect(f.matches(["swift"])).toBe(false);
  });

  it("test_unrelated_command_does_not_match", () => {
    const f = new bc.SwiftFilter();
    expect(f.matches(["python", "script.py"])).toBe(false);
    expect(f.matches(["cargo", "build"])).toBe(false);
  });

  it("test_dispatch_routes_swift_build", () => {
    const result = bc.select_filter(["swift", "build"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("swift");
  });

  it("test_dispatch_routes_swift_test", () => {
    const result = bc.select_filter(["swift", "test"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("swift");
  });
});

// ---------------------------------------------------------------------------
// SwiftFilter — build output compression
// ---------------------------------------------------------------------------

const _SWIFT_BUILD_OUTPUT =
  "Build complete!\n" +
  "CompileSwift normal arm64 /path/to/Sources/MyApp/main.swift\n" +
  "CompileSwift normal arm64 /path/to/Sources/MyApp/Model.swift\n" +
  "CompileSwift normal arm64 /path/to/Sources/MyApp/Network.swift\n" +
  "CompileSwift normal arm64 /path/to/Sources/MyApp/Utils.swift\n" +
  "MergeSwiftModule normal arm64 /path/to/.build/arm64-apple-macosx/debug/MyApp.swiftmodule\n" +
  "Ld /path/to/.build/arm64-apple-macosx/debug/MyApp normal arm64\n" +
  "/path/to/Sources/MyApp/Network.swift:42:5: warning: result of 'send' is unused\n" +
  "Build complete!\n";

const _SWIFT_BUILD_ERRORS =
  "CompileSwift normal arm64 /path/to/Sources/MyApp/main.swift\n" +
  "/path/to/Sources/MyApp/main.swift:10:12: error: use of unresolved identifier 'Foo'\n" +
  "/path/to/Sources/MyApp/main.swift:15:8: warning: variable 'x' was never used\n" +
  "CompileSwift normal arm64 /path/to/Sources/MyApp/Model.swift\n" +
  "/path/to/Sources/MyApp/Model.swift:5:1: error: expected declaration\n";

describe("TestSwiftFilterBuild", () => {
  it("test_build_complete_preserved", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_BUILD_OUTPUT, "", 0, ["swift", "build"]).text;
    expect(out).toContain("Build complete!");
  });

  it("test_compile_lines_collapsed", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_BUILD_OUTPUT, "", 0, ["swift", "build"]).text;
    // Individual CompileSwift lines should be gone.
    expect(out).not.toContain("CompileSwift normal arm64 /path/to/Sources/MyApp/main.swift");
    expect(out).not.toContain("CompileSwift normal arm64 /path/to/Sources/MyApp/Model.swift");
    // A collapse marker must appear.
    expect(out).toContain("collapsed");
    expect(out).toContain("Swift build-phase lines");
  });

  it("test_warning_preserved", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_BUILD_OUTPUT, "", 0, ["swift", "build"]).text;
    expect(out).toContain("warning: result of 'send' is unused");
  });

  it("test_error_lines_preserved", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_BUILD_ERRORS, "", 1, ["swift", "build"]).text;
    expect(out).toContain("error: use of unresolved identifier 'Foo'");
    expect(out).toContain("error: expected declaration");
  });

  it("test_savings_ratio", () => {
    const f = new bc.SwiftFilter();
    let big = "Build complete!\n";
    for (let i = 0; i < 100; i++) {
      big += `CompileSwift normal arm64 /path/to/Sources/App/File${i}.swift\n`;
    }
    big += "Build complete!\n";
    const result = f.apply(big, "", 0, ["swift", "build"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });
});

// ---------------------------------------------------------------------------
// SwiftFilter — test output compression
// ---------------------------------------------------------------------------

const _SWIFT_TEST_PASSING =
  "Test Suite 'All tests' started at 2026-05-30 12:00:00.000\n" +
  "Test Suite 'MyAppTests.xctest' started at 2026-05-30 12:00:00.001\n" +
  "Test Suite 'MyAppTests' started at 2026-05-30 12:00:00.002\n" +
  "Test Case '-[MyAppTests.MyAppTests testAddition]' started.\n" +
  "Test Case '-[MyAppTests.MyAppTests testAddition]' passed (0.001 seconds).\n" +
  "Test Case '-[MyAppTests.MyAppTests testSubtraction]' started.\n" +
  "Test Case '-[MyAppTests.MyAppTests testSubtraction]' passed (0.001 seconds).\n" +
  "Test Case '-[MyAppTests.MyAppTests testMultiplication]' started.\n" +
  "Test Case '-[MyAppTests.MyAppTests testMultiplication]' passed (0.001 seconds).\n" +
  "Test Suite 'MyAppTests' passed at 2026-05-30 12:00:00.010.\n" +
  "\t Executed 3 tests, with 0 failures (0 unexpected) in 0.003 (0.009) seconds\n" +
  "Test Suite 'MyAppTests.xctest' passed at 2026-05-30 12:00:00.011.\n" +
  "\t Executed 3 tests, with 0 failures (0 unexpected) in 0.003 (0.010) seconds\n" +
  "Test Suite 'All tests' passed at 2026-05-30 12:00:00.012.\n" +
  "\t Executed 3 tests, with 0 failures (0 unexpected) in 0.003 (0.011) seconds\n";

const _SWIFT_TEST_WITH_FAILURE =
  "Test Suite 'All tests' started at 2026-05-30 12:00:00.000\n" +
  "Test Case '-[MyAppTests.MyAppTests testPassing]' started.\n" +
  "Test Case '-[MyAppTests.MyAppTests testPassing]' passed (0.001 seconds).\n" +
  "Test Case '-[MyAppTests.MyAppTests testFailing]' started.\n" +
  "/path/to/Tests/MyAppTests/MyAppTests.swift:25: error: -[MyAppTests.MyAppTests testFailing] : XCTAssertEqual failed: (\"1\") is not equal to (\"2\")\n" +
  "Test Case '-[MyAppTests.MyAppTests testFailing]' failed (0.002 seconds).\n" +
  "Test Case '-[MyAppTests.MyAppTests testAnotherPassing]' started.\n" +
  "Test Case '-[MyAppTests.MyAppTests testAnotherPassing]' passed (0.001 seconds).\n" +
  "Test Suite 'All tests' failed at 2026-05-30 12:00:00.020.\n" +
  "\t Executed 3 tests, with 1 failure (0 unexpected) in 0.004 (0.020) seconds\n";

describe("TestSwiftFilterTests", () => {
  it("test_passing_tests_collapsed", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_TEST_PASSING, "", 0, ["swift", "test"]).text;
    expect(out).not.toContain("Test Case '-[MyAppTests.MyAppTests testAddition]' passed");
    expect(out).not.toContain("Test Case '-[MyAppTests.MyAppTests testSubtraction]' passed");
    expect(out).toContain("collapsed");
    expect(out).toContain("passing Swift test cases");
  });

  it("test_suite_summary_preserved", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_TEST_PASSING, "", 0, ["swift", "test"]).text;
    // "Executed N tests" lines should survive.
    expect(out).toContain("Executed 3 tests");
  });

  it("test_failure_preserved", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_TEST_WITH_FAILURE, "", 1, ["swift", "test"]).text;
    expect(out).toContain("testFailing");
    expect(out).toContain("failed");
  });

  it("test_failure_body_preserved", () => {
    // The XCTAssertEqual error line after a failing test must survive.
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_TEST_WITH_FAILURE, "", 1, ["swift", "test"]).text;
    expect(out).toContain("XCTAssertEqual failed");
  });

  it("test_passing_tests_before_failure_collapsed", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply(_SWIFT_TEST_WITH_FAILURE, "", 1, ["swift", "test"]).text;
    // The two passing test cases should be collapsed to a count.
    expect(out).not.toContain("testPassing]' passed");
    expect(out).not.toContain("testAnotherPassing]' passed");
    expect(out).toContain("collapsed 2 passing Swift test cases");
  });

  it("test_savings_ratio_all_passing", () => {
    const f = new bc.SwiftFilter();
    const lines: string[] = ["Test Suite 'All tests' started at 2026-05-30 12:00:00.000"];
    for (let i = 0; i < 200; i++) {
      lines.push(`Test Case '-[MyTests.TestClass test${i}]' started.`);
      lines.push(`Test Case '-[MyTests.TestClass test${i}]' passed (0.001 seconds).`);
    }
    lines.push("Test Suite 'All tests' passed at 2026-05-30 12:00:00.999.");
    lines.push("\t Executed 200 tests, with 0 failures in 0.200 (0.999) seconds");
    const big = lines.join("\n") + "\n";
    const result = f.apply(big, "", 0, ["swift", "test"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });

  it("test_empty_input_no_crash", () => {
    const f = new bc.SwiftFilter();
    const out = f.apply("", "", 0, ["swift", "test"]).text;
    expect(out === "" || out.trim() === "").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// XcodeFilter — applies()
// ---------------------------------------------------------------------------

describe("TestXcodeFilterApplies", () => {
  it("test_xcodebuild_matches", () => {
    const f = new bc.XcodeFilter();
    expect(f.matches(["xcodebuild", "-scheme", "MyApp", "-configuration", "Debug"])).toBe(true);
  });

  it("test_xcodebuild_test_matches", () => {
    const f = new bc.XcodeFilter();
    expect(f.matches(["xcodebuild", "test", "-scheme", "MyApp"])).toBe(true);
  });

  it("test_xcodebuild_plain_matches", () => {
    const f = new bc.XcodeFilter();
    expect(f.matches(["xcodebuild"])).toBe(true);
  });

  it("test_unrelated_does_not_match", () => {
    const f = new bc.XcodeFilter();
    expect(f.matches(["swift", "build"])).toBe(false);
    expect(f.matches(["cargo", "build"])).toBe(false);
    expect(f.matches(["gradle", "build"])).toBe(false);
  });

  it("test_dispatch_routes_xcodebuild", () => {
    const result = bc.select_filter(["xcodebuild", "-scheme", "MyApp"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("xcode");
  });
});

// ---------------------------------------------------------------------------
// XcodeFilter — build output compression
// ---------------------------------------------------------------------------

const _XCODE_BUILD_OUTPUT =
  "=== BUILD TARGET MyApp OF PROJECT MyApp WITH CONFIGURATION Debug ===\n" +
  "\n" +
  "Check dependencies\n" +
  "\n" +
  "CompileSwiftSources normal arm64 com.apple.xcode.tools.swift.compiler\n" +
  "    /path/to/Sources/MyApp/main.swift\n" +
  "    /path/to/Sources/MyApp/Model.swift\n" +
  "\n" +
  "CompileSwift normal arm64 /path/to/Sources/MyApp/ContentView.swift (in target 'MyApp' from project 'MyApp')\n" +
  "    cd /path/to\n" +
  "    /usr/bin/swiftc ... -c /path/to/Sources/MyApp/ContentView.swift\n" +
  "\n" +
  "CpHeader /path/to/build/MyApp.build/Debug/MyApp.hmap /path/to/Sources/MyApp/include/MyApp.h\n" +
  "    cd /path/to\n" +
  "    builtin-copy -exclude .DS_Store ...\n" +
  "\n" +
  "ProcessInfoPlistFile /path/to/build/Debug-iphonesimulator/MyApp.app/Info.plist\n" +
  "\n" +
  "/path/to/Sources/MyApp/ContentView.swift:42:5: warning: unused variable 'tmp'\n" +
  "\n" +
  "Ld /path/to/build/Debug-iphonesimulator/MyApp.app/MyApp normal arm64\n" +
  "    cd /path/to\n" +
  "\n" +
  "CodeSign /path/to/build/Debug-iphonesimulator/MyApp.app\n" +
  "\n" +
  "** BUILD SUCCEEDED **\n";

const _XCODE_FAILED_OUTPUT =
  "=== BUILD TARGET MyApp OF PROJECT MyApp WITH CONFIGURATION Debug ===\n" +
  "\n" +
  "CompileSwiftSources normal arm64 com.apple.xcode.tools.swift.compiler\n" +
  "\n" +
  "/path/to/Sources/MyApp/main.swift:10:5: error: use of unresolved identifier 'Bar'\n" +
  "/path/to/Sources/MyApp/main.swift:15:1: error: expected declaration\n" +
  "\n" +
  "** BUILD FAILED **\n";

describe("TestXcodeFilterBuild", () => {
  it("test_section_header_preserved", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text;
    expect(out).toContain("=== BUILD TARGET MyApp");
  });

  it("test_build_succeeded_preserved", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text;
    expect(out).toContain("BUILD SUCCEEDED");
  });

  it("test_build_failed_preserved", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_FAILED_OUTPUT, "", 1, ["xcodebuild"]).text;
    expect(out).toContain("BUILD FAILED");
  });

  it("test_compile_swift_sources_collapsed", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text;
    // CompileSwiftSources line should be gone.
    expect(out).not.toContain("CompileSwiftSources normal arm64");
    // A collapse marker must appear.
    expect(out).toContain("collapsed");
    expect(out).toContain("xcodebuild build-phase lines");
  });

  it("test_cp_header_collapsed", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text;
    expect(out).not.toContain("CpHeader /path/to/build");
  });

  it("test_process_info_plist_collapsed", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text;
    expect(out).not.toContain("ProcessInfoPlistFile");
  });

  it("test_warning_preserved", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_BUILD_OUTPUT, "", 0, ["xcodebuild"]).text;
    expect(out).toContain("warning: unused variable 'tmp'");
  });

  it("test_errors_preserved_on_failure", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply(_XCODE_FAILED_OUTPUT, "", 1, ["xcodebuild"]).text;
    expect(out).toContain("error: use of unresolved identifier 'Bar'");
    expect(out).toContain("error: expected declaration");
  });

  it("test_savings_ratio", () => {
    const f = new bc.XcodeFilter();
    const lines: string[] = [
      "=== BUILD TARGET App OF PROJECT App WITH CONFIGURATION Debug ===",
      "",
    ];
    for (let i = 0; i < 150; i++) {
      lines.push(`CompileSwiftSources normal arm64 file${i}.swift`);
      lines.push(`    /path/to/Sources/App/File${i}.swift`);
    }
    for (let i = 0; i < 50; i++) {
      lines.push(`CpHeader /path/to/build/App.build/Debug/header${i}.h`);
    }
    lines.push("** BUILD SUCCEEDED **");
    const big = lines.join("\n") + "\n";
    const result = f.apply(big, "", 0, ["xcodebuild"]);
    const ratio = result.percent_saved / 100.0;
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });

  it("test_empty_input_no_crash", () => {
    const f = new bc.XcodeFilter();
    const out = f.apply("", "", 0, ["xcodebuild"]).text;
    expect(out === "" || out.trim() === "").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry guards
// ---------------------------------------------------------------------------

it("test_swift_and_xcode_in_registry", () => {
  // Both new filters are registered exactly once and reachable by name.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.filter((n) => n === "swift").length).toBe(1);
  expect(names.filter((n) => n === "xcode").length).toBe(1);
  expect(bc.filter_by_name("swift")).not.toBeNull();
  expect(bc.filter_by_name("xcode")).not.toBeNull();
});

it("test_swift_routes_correctly", () => {
  // select_filter(['swift', 'build']) → SwiftFilter.
  const f = bc.select_filter(["swift", "build"]);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("swift");
});

it("test_xcode_routes_correctly", () => {
  // select_filter(['xcodebuild', ...]) → XcodeFilter.
  const f = bc.select_filter(["xcodebuild", "-scheme", "MyApp"]);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("xcode");
});

it("test_swift_precedes_python_in_registry", () => {
  // SwiftFilter must precede PythonFilter (the catch-all) in FILTERS.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.includes("swift") && names.includes("python")).toBe(true);
  expect(names.indexOf("swift")).toBeLessThan(names.indexOf("python"));
});

it("test_xcode_precedes_python_in_registry", () => {
  // XcodeFilter must precede PythonFilter in FILTERS.
  const names = bc.FILTERS.map((f) => f.name);
  expect(names.includes("xcode") && names.includes("python")).toBe(true);
  expect(names.indexOf("xcode")).toBeLessThan(names.indexOf("python"));
});
