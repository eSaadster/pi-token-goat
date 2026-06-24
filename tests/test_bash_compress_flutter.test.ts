/**
 * Tests for FlutterFilter, DartFilter, and PubFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_flutter.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes (TestFlutterFilterMatches, TestFlutterFilterBuild, ...) map to
 * `describe()` blocks of the same name. The module-level registry-guard `def
 * test_*` functions land in a trailing top-level `describe`.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import FlutterFilter / DartFilter / PubFilter + the dispatch surface
 *         (FILTERS, filter_by_name, select_filter) from the barrel
 *         "../src/token_goat/bash_compress.js".
 *  - `from filter_test_helpers import apply_filter as _apply`
 *      -> local `apply_filter(filter_, stdout, opts?)` helper below; runs
 *         `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *         to `[filter_.name]` (matching the Python helper exactly).
 *
 * Byte-exactness: assertions here are substring `in` / `not in` checks and
 * `percent_saved` comparisons. The fixtures are ASCII apart from the "✓" prefix
 * on Flutter build "Built" lines and the "→"-free pub markers; substring checks
 * over JS strings match Python substring checks 1:1, and percent_saved is
 * computed inside the filter (UTF-8 Buffer math), so no test-side Buffer
 * arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import {
  DartFilter,
  FlutterFilter,
  PubFilter,
  FILTERS,
  filter_by_name,
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

// ---------------------------------------------------------------------------
// FlutterFilter — matches()
// ---------------------------------------------------------------------------

describe("TestFlutterFilterMatches", () => {
  it("test_flutter_build_matches", () => {
    const f = new FlutterFilter();
    expect(f.matches(["flutter", "build", "apk"])).toBeTruthy();
  });

  it("test_flutter_test_matches", () => {
    const f = new FlutterFilter();
    expect(f.matches(["flutter", "test"])).toBeTruthy();
  });

  it("test_flutter_run_matches", () => {
    const f = new FlutterFilter();
    expect(f.matches(["flutter", "run"])).toBeTruthy();
  });

  it("test_flutter_pub_get_matches", () => {
    const f = new FlutterFilter();
    expect(f.matches(["flutter", "pub", "get"])).toBeTruthy();
  });

  it("test_flutter_without_subcommand_does_not_match", () => {
    const f = new FlutterFilter();
    expect(f.matches(["flutter"])).toBeFalsy();
  });

  it("test_flutter_version_does_not_match", () => {
    const f = new FlutterFilter();
    // "flutter --version" has no subcommand in our set
    expect(f.matches(["flutter", "--version"])).toBeFalsy();
  });

  it("test_unrelated_command_does_not_match", () => {
    const f = new FlutterFilter();
    expect(f.matches(["dart", "test"])).toBeFalsy();
    expect(f.matches(["cargo", "build"])).toBeFalsy();
  });

  it("test_dispatch_routes_flutter_build", () => {
    const result = select_filter(["flutter", "build", "apk"]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("flutter");
  });

  it("test_dispatch_routes_flutter_test", () => {
    const result = select_filter(["flutter", "test"]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("flutter");
  });
});

// ---------------------------------------------------------------------------
// FlutterFilter — build output compression
// ---------------------------------------------------------------------------

const _FLUTTER_BUILD_OUTPUT = `Running Gradle task 'assembleRelease'...
Compiling lib/main.dart for target platform android-arm64...
Compiling lib/screens/home.dart for target platform android-arm64...
Compiling lib/screens/settings.dart for target platform android-arm64...
Compiling lib/widgets/button.dart for target platform android-arm64...
Font asset "assets/fonts/Roboto-Regular.ttf"
Font asset "assets/fonts/Roboto-Bold.ttf"
✓ Built build/app/outputs/flutter-apk/app-release.apk (17.2MB)
`;

const _FLUTTER_BUILD_WITH_ERROR = `Running Gradle task 'assembleDebug'...
Compiling lib/main.dart for target platform android-arm64...
Compiling lib/broken.dart for target platform android-arm64...
Error: lib/broken.dart:10:5: Error: Member not found: 'Foo'.
✓ Built build/app/outputs/flutter-apk/app-debug.apk (12.1MB)
`;

describe("TestFlutterFilterBuild", () => {
  it("test_gradle_line_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_BUILD_OUTPUT, { argv: ["flutter", "build", "apk"] });
    expect(out).toContain("Running Gradle task");
  });

  it("test_built_line_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_BUILD_OUTPUT, { argv: ["flutter", "build", "apk"] });
    expect(out).toContain("Built build/app");
  });

  it("test_compiling_lines_collapsed", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_BUILD_OUTPUT, { argv: ["flutter", "build", "apk"] });
    expect(out).not.toContain("Compiling lib/main.dart");
    expect(out).not.toContain("Compiling lib/screens/home.dart");
    expect(out).toContain("collapsed");
    expect(out).toContain("'Compiling lib/'");
  });

  it("test_font_asset_lines_collapsed", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_BUILD_OUTPUT, { argv: ["flutter", "build", "apk"] });
    expect(!out.includes("Font asset") || out.includes("collapsed")).toBeTruthy();
    expect(out.toLowerCase()).toContain("font asset");
  });

  it("test_error_line_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_BUILD_WITH_ERROR, {
      exit_code: 1,
      argv: ["flutter", "build", "apk"],
    });
    expect(out).toContain("Error:");
    expect(out).toContain("Member not found");
  });

  it("test_savings_on_large_build", () => {
    const lines: string[] = ["Running Gradle task 'assembleRelease'..."];
    for (let i = 0; i < 100; i++) {
      lines.push(`Compiling lib/src/file_${i}.dart for target platform android-arm64...`);
    }
    for (let i = 0; i < 20; i++) {
      lines.push(`Font asset "assets/fonts/Font${i}.ttf"`);
    }
    lines.push("✓ Built build/app/outputs/flutter-apk/app-release.apk (18.0MB)");
    const stdout = lines.join("\n") + "\n";
    const f = new FlutterFilter();
    const result = f.apply(stdout, "", 0, ["flutter", "build", "apk"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(70.0);
  });

  it("test_empty_input_no_crash", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, "", { argv: ["flutter", "build", "apk"] });
    expect(out === "" || out.trim() === "").toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// FlutterFilter — test output compression
// ---------------------------------------------------------------------------

const _FLUTTER_TEST_PASSING = `00:01 +0: loading /path/to/test/widget_test.dart
00:02 +1: widget renders correctly
00:03 +2: widget handles tap
00:04 +3: All tests passed!
`;

const _FLUTTER_TEST_WITH_FAILURES = `00:01 +0: loading /path/to/test/widget_test.dart
00:02 +1: widget renders correctly
00:03 +1 -1: Some tests failed.
Error: Test failed. See exception above.
  Expected: <true>
  Actual: <false>
00:04 +1 -1: 1 tests failed.
`;

describe("TestFlutterFilterTest", () => {
  it("test_progress_lines_collapsed", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_TEST_PASSING, { argv: ["flutter", "test"] });
    expect(out).not.toContain("00:01 +0:");
    expect(out).not.toContain("00:02 +1:");
    expect(out).toContain("collapsed");
  });

  it("test_summary_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_TEST_PASSING, { argv: ["flutter", "test"] });
    expect(out).toContain("All tests passed!");
  });

  it("test_failure_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_TEST_WITH_FAILURES, {
      exit_code: 1,
      argv: ["flutter", "test"],
    });
    expect(out.includes("Error:") || out.includes("failed")).toBeTruthy();
  });

  it("test_savings_on_large_test_run", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`00:${String(Math.floor(i / 60)).padStart(2, "0")} +${i}: test_${i} passes`);
    }
    lines.push("00:03 +200: All tests passed!");
    const stdout = lines.join("\n") + "\n";
    const f = new FlutterFilter();
    const result = f.apply(stdout, "", 0, ["flutter", "test"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(70.0);
  });
});

// ---------------------------------------------------------------------------
// FlutterFilter — pub get output compression
// ---------------------------------------------------------------------------

const _FLUTTER_PUB_OUTPUT = `Resolving dependencies...
+ http 1.2.0 (1.3.0 available)
+ path 1.8.3
+ meta 1.9.0
+ collection 1.17.0
+ intl 0.18.0
Changed 5 dependencies.
`;

const _FLUTTER_PUB_NO_CHANGE = `Resolving dependencies...
No dependencies changed.
`;

describe("TestFlutterFilterPub", () => {
  it("test_resolving_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_PUB_OUTPUT, { argv: ["flutter", "pub", "get"] });
    expect(out).toContain("Resolving dependencies");
  });

  it("test_package_lines_collapsed", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_PUB_OUTPUT, { argv: ["flutter", "pub", "get"] });
    expect(out).not.toContain("+ http 1.2.0");
    expect(out).toContain("collapsed");
    expect(out).toContain("package");
  });

  it("test_changed_summary_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_PUB_OUTPUT, { argv: ["flutter", "pub", "get"] });
    expect(out).toContain("Changed 5 dependencies");
  });

  it("test_no_change_preserved", () => {
    const f = new FlutterFilter();
    const out = apply_filter(f, _FLUTTER_PUB_NO_CHANGE, { argv: ["flutter", "pub", "get"] });
    expect(out).toContain("No dependencies changed");
  });

  it("test_savings_on_large_pub_get", () => {
    const lines: string[] = ["Resolving dependencies..."];
    for (let i = 0; i < 100; i++) {
      lines.push(`+ package_${i} 1.0.${i}`);
    }
    lines.push("Changed 100 dependencies.");
    const stdout = lines.join("\n") + "\n";
    const f = new FlutterFilter();
    const result = f.apply(stdout, "", 0, ["flutter", "pub", "get"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(70.0);
  });
});

// ---------------------------------------------------------------------------
// DartFilter — matches()
// ---------------------------------------------------------------------------

describe("TestDartFilterMatches", () => {
  it("test_dart_compile_matches", () => {
    const f = new DartFilter();
    expect(f.matches(["dart", "compile", "exe", "bin/main.dart"])).toBeTruthy();
  });

  it("test_dart_test_matches", () => {
    const f = new DartFilter();
    expect(f.matches(["dart", "test"])).toBeTruthy();
  });

  it("test_dart_pub_matches", () => {
    const f = new DartFilter();
    expect(f.matches(["dart", "pub", "get"])).toBeTruthy();
  });

  it("test_dart_analyze_matches", () => {
    const f = new DartFilter();
    expect(f.matches(["dart", "analyze"])).toBeTruthy();
  });

  it("test_dart_run_matches", () => {
    const f = new DartFilter();
    expect(f.matches(["dart", "run"])).toBeTruthy();
  });

  it("test_dart_without_subcommand_does_not_match", () => {
    const f = new DartFilter();
    expect(f.matches(["dart"])).toBeFalsy();
  });

  it("test_flutter_does_not_match_dart", () => {
    const f = new DartFilter();
    expect(f.matches(["flutter", "test"])).toBeFalsy();
  });

  it("test_dispatch_routes_dart_analyze", () => {
    const result = select_filter(["dart", "analyze"]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("dart");
  });

  it("test_dispatch_routes_dart_test", () => {
    const result = select_filter(["dart", "test"]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("dart");
  });

  it("test_dispatch_routes_dart_pub", () => {
    const result = select_filter(["dart", "pub", "get"]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("dart");
  });
});

// ---------------------------------------------------------------------------
// DartFilter — analyze output
// ---------------------------------------------------------------------------

const _DART_ANALYZE_CLEAN = `Analyzing lib...
No issues found!
`;

const _DART_ANALYZE_WITH_ISSUES = `Analyzing lib...
error - lib/src/broken.dart:10:5 - Undefined class 'Foo'. - undefined_class
warning - lib/src/helper.dart:22:3 - Dead code. - dead_code
2 issues found.
`;

describe("TestDartFilterAnalyze", () => {
  it("test_analyzing_header_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_ANALYZE_CLEAN, { argv: ["dart", "analyze"] });
    expect(out).toContain("Analyzing");
  });

  it("test_no_issues_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_ANALYZE_CLEAN, { argv: ["dart", "analyze"] });
    expect(out).toContain("No issues found!");
  });

  it("test_issue_lines_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_ANALYZE_WITH_ISSUES, { argv: ["dart", "analyze"] });
    expect(out).toContain("Undefined class 'Foo'");
    expect(out).toContain("Dead code");
  });

  it("test_summary_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_ANALYZE_WITH_ISSUES, { argv: ["dart", "analyze"] });
    expect(out).toContain("2 issues found");
  });
});

// ---------------------------------------------------------------------------
// DartFilter — test output compression
// ---------------------------------------------------------------------------

const _DART_TEST_PASSING = `00:00 +0: loading test/widget_test.dart
00:01 +1: example test passes
00:02 +2: another test passes
00:03 +3: All tests passed.
`;

const _DART_TEST_WITH_FAILURE = `00:00 +0: loading test/widget_test.dart
00:01 +1: passing test
00:02 +1 -1: failing test
Error: Expected: <42>
  Actual: <0>
00:03 +1 -1: 1 test failed.
`;

describe("TestDartFilterTest", () => {
  it("test_progress_lines_collapsed", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_TEST_PASSING, { argv: ["dart", "test"] });
    expect(out).not.toContain("00:00 +0:");
    expect(out).not.toContain("00:01 +1:");
    expect(out).toContain("collapsed");
  });

  it("test_summary_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_TEST_PASSING, { argv: ["dart", "test"] });
    expect(out).toContain("All tests passed");
  });

  it("test_failure_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_TEST_WITH_FAILURE, {
      exit_code: 1,
      argv: ["dart", "test"],
    });
    expect(out).toContain("Error:");
  });

  it("test_savings_on_large_test_run", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`00:${String(Math.floor(i / 60)).padStart(2, "0")} +${i}: test_${i} passes`);
    }
    lines.push("00:03 +200: All tests passed.");
    const stdout = lines.join("\n") + "\n";
    const f = new DartFilter();
    const result = f.apply(stdout, "", 0, ["dart", "test"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(70.0);
  });
});

// ---------------------------------------------------------------------------
// DartFilter — compile output
// ---------------------------------------------------------------------------

const _DART_COMPILE_OUTPUT = `Compiling bin/main.dart to bin/main...
Generated: /path/to/project/bin/main
`;

const _DART_COMPILE_WITH_ERROR = `Compiling bin/main.dart to bin/main...
Error: bin/main.dart:5:3: Error: 'Bar' is not a type.
`;

describe("TestDartFilterCompile", () => {
  it("test_compiling_line_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_COMPILE_OUTPUT, {
      argv: ["dart", "compile", "exe", "bin/main.dart"],
    });
    expect(out).toContain("Compiling");
  });

  it("test_generated_line_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_COMPILE_OUTPUT, {
      argv: ["dart", "compile", "exe", "bin/main.dart"],
    });
    expect(out).toContain("Generated:");
  });

  it("test_error_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_COMPILE_WITH_ERROR, {
      exit_code: 1,
      argv: ["dart", "compile", "exe", "bin/main.dart"],
    });
    expect(out).toContain("Error:");
    expect(out).toContain("'Bar' is not a type");
  });
});

// ---------------------------------------------------------------------------
// DartFilter — pub output compression
// ---------------------------------------------------------------------------

const _DART_PUB_OUTPUT = `Resolving dependencies...
+ http 1.2.0 (1.3.0 available)
+ path 1.8.3
+ meta 1.9.0
Changed 3 dependencies.
`;

describe("TestDartFilterPub", () => {
  it("test_resolving_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_PUB_OUTPUT, { argv: ["dart", "pub", "get"] });
    expect(out).toContain("Resolving dependencies");
  });

  it("test_package_lines_collapsed", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_PUB_OUTPUT, { argv: ["dart", "pub", "get"] });
    expect(out).not.toContain("+ http 1.2.0");
    expect(out).toContain("collapsed");
  });

  it("test_changed_summary_preserved", () => {
    const f = new DartFilter();
    const out = apply_filter(f, _DART_PUB_OUTPUT, { argv: ["dart", "pub", "get"] });
    expect(out).toContain("Changed 3 dependencies");
  });
});

// ---------------------------------------------------------------------------
// PubFilter — matches()
// ---------------------------------------------------------------------------

describe("TestPubFilterMatches", () => {
  it("test_pub_get_matches", () => {
    const f = new PubFilter();
    expect(f.matches(["pub", "get"])).toBeTruthy();
  });

  it("test_pub_upgrade_matches", () => {
    const f = new PubFilter();
    expect(f.matches(["pub", "upgrade"])).toBeTruthy();
  });

  it("test_pub_publish_matches", () => {
    const f = new PubFilter();
    expect(f.matches(["pub", "publish"])).toBeTruthy();
  });

  it("test_pub_add_matches", () => {
    const f = new PubFilter();
    expect(f.matches(["pub", "add", "http"])).toBeTruthy();
  });

  it("test_pub_without_subcommand_does_not_match", () => {
    const f = new PubFilter();
    expect(f.matches(["pub"])).toBeFalsy();
  });

  it("test_dart_pub_does_not_match_pub_filter", () => {
    // dart pub get routes to DartFilter, not PubFilter.
    const f = new PubFilter();
    expect(f.matches(["dart", "pub", "get"])).toBeFalsy();
  });

  it("test_dispatch_routes_pub_get", () => {
    const result = select_filter(["pub", "get"]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("pub");
  });

  it("test_dispatch_routes_pub_upgrade", () => {
    const result = select_filter(["pub", "upgrade"]);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("pub");
  });
});

// ---------------------------------------------------------------------------
// PubFilter — compression
// ---------------------------------------------------------------------------

const _PUB_GET_OUTPUT = `Resolving dependencies...
Downloading http 1.2.0...
Downloading path 1.8.3...
Downloading meta 1.9.0...
+ http 1.2.0 (1.3.0 available)
+ path 1.8.3
+ meta 1.9.0
> collection 1.17.2 (was 1.17.0)
Changed 4 dependencies.
`;

const _PUB_GET_NO_CHANGE = `Resolving dependencies...
No dependencies changed.
`;

const _PUB_GET_WITH_ERROR = `Resolving dependencies...
Error: Package http has no versions that match >=2.0.0.
`;

describe("TestPubFilterCompression", () => {
  it("test_resolving_preserved", () => {
    const f = new PubFilter();
    const out = apply_filter(f, _PUB_GET_OUTPUT, { argv: ["pub", "get"] });
    expect(out).toContain("Resolving dependencies");
  });

  it("test_download_lines_collapsed", () => {
    const f = new PubFilter();
    const out = apply_filter(f, _PUB_GET_OUTPUT, { argv: ["pub", "get"] });
    expect(out).not.toContain("Downloading http 1.2.0");
    expect(out).toContain("collapsed");
    expect(out).toContain("download");
  });

  it("test_package_add_lines_collapsed", () => {
    const f = new PubFilter();
    const out = apply_filter(f, _PUB_GET_OUTPUT, { argv: ["pub", "get"] });
    expect(out).not.toContain("+ http 1.2.0");
    expect(out).not.toContain("+ path 1.8.3");
  });

  it("test_changed_summary_preserved", () => {
    const f = new PubFilter();
    const out = apply_filter(f, _PUB_GET_OUTPUT, { argv: ["pub", "get"] });
    expect(out).toContain("Changed 4 dependencies");
  });

  it("test_no_change_preserved", () => {
    const f = new PubFilter();
    const out = apply_filter(f, _PUB_GET_NO_CHANGE, { argv: ["pub", "get"] });
    expect(out).toContain("No dependencies changed");
  });

  it("test_error_preserved", () => {
    const f = new PubFilter();
    const out = apply_filter(f, _PUB_GET_WITH_ERROR, { exit_code: 1, argv: ["pub", "get"] });
    expect(out).toContain("Error:");
    expect(out).toContain("no versions that match");
  });

  it("test_savings_on_large_pub_get", () => {
    const lines: string[] = ["Resolving dependencies..."];
    for (let i = 0; i < 50; i++) {
      lines.push(`Downloading package_${i} 1.0.${i}...`);
    }
    for (let i = 0; i < 50; i++) {
      lines.push(`+ package_${i} 1.0.${i}`);
    }
    lines.push("Changed 50 dependencies.");
    const stdout = lines.join("\n") + "\n";
    const f = new PubFilter();
    const result = f.apply(stdout, "", 0, ["pub", "get"]);
    expect(result.percent_saved).toBeGreaterThanOrEqual(70.0);
  });

  it("test_empty_input_no_crash", () => {
    const f = new PubFilter();
    const out = apply_filter(f, "", { argv: ["pub", "get"] });
    expect(out === "" || out.trim() === "").toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Registry guards
// ---------------------------------------------------------------------------

describe("registry guards", () => {
  it("test_flutter_dart_pub_in_registry", () => {
    // All three new filters are registered and reachable by name.
    const names = FILTERS.map((f) => f.name);
    expect(names.filter((n) => n === "flutter").length).toBe(1);
    expect(names.filter((n) => n === "dart").length).toBe(1);
    expect(names.filter((n) => n === "pub").length).toBe(1);
    expect(filter_by_name("flutter")).not.toBeNull();
    expect(filter_by_name("dart")).not.toBeNull();
    expect(filter_by_name("pub")).not.toBeNull();
  });

  it("test_flutter_precedes_python_in_registry", () => {
    const names = FILTERS.map((f) => f.name);
    expect(names.includes("flutter") && names.includes("python")).toBeTruthy();
    expect(names.indexOf("flutter")).toBeLessThan(names.indexOf("python"));
  });

  it("test_dart_precedes_python_in_registry", () => {
    const names = FILTERS.map((f) => f.name);
    expect(names.includes("dart") && names.includes("python")).toBeTruthy();
    expect(names.indexOf("dart")).toBeLessThan(names.indexOf("python"));
  });

  it("test_pub_precedes_python_in_registry", () => {
    const names = FILTERS.map((f) => f.name);
    expect(names.includes("pub") && names.includes("python")).toBeTruthy();
    expect(names.indexOf("pub")).toBeLessThan(names.indexOf("python"));
  });

  it("test_flutter_routes_correctly", () => {
    const f = select_filter(["flutter", "build", "apk"]);
    expect(f).not.toBeNull();
    expect(f?.name).toBe("flutter");
  });

  it("test_dart_routes_correctly", () => {
    const f = select_filter(["dart", "analyze"]);
    expect(f).not.toBeNull();
    expect(f?.name).toBe("dart");
  });

  it("test_pub_routes_correctly", () => {
    const f = select_filter(["pub", "get"]);
    expect(f).not.toBeNull();
    expect(f?.name).toBe("pub");
  });
});
