/**
 * Tests for GradleFilter (extended), AntFilter, and BazelFilter.
 *
 * 1:1 port of tests/test_bash_compress_build.py. Every Python `def test_*` maps
 * to a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, stdout, opts?)` helper below. The Python
 *        helper runs `filter_.apply(stdout, stderr, exit_code, argv).text`,
 *        defaulting argv to `[filter_.name]`; the TS port mirrors that exactly.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the JVM filter classes + select_filter).
 *  - Class-body `GRADLE = bc.GradleFilter()` (a class attribute shared by the
 *    methods) -> a `const GRADLE = new GradleFilter()` inside the describe block.
 *  - The Python tests that call `f.apply(stdout, stderr, exit_code, argv)`
 *    directly and read `.text` / `.percent_saved` are ported to the same calls
 *    on the TS CompressedOutput (`.text` is the body; `percent_saved` is a getter
 *    returning a percentage number).
 *
 * Byte-exactness: these filters operate on whole lines and on substring markers
 * ("collapsed N dependency download lines", "[echo]", "× ", "collapsed N PASSED
 * test targets", ...). The assertions are substring `in` / `not in` checks plus
 * a `.lower()` comparison and `percent_saved` numeric thresholds, matching the
 * Python checks. The `×` glyph asserted in test_echo_lines_collapsed is the same
 * Unicode codepoint (U+00D7) as the Python source. Fixtures are pure ASCII (apart
 * from that glyph), so no Buffer arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { AntFilter, BazelFilter, GradleFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element — the minimum needed for these structural-compression tests.
// ---------------------------------------------------------------------------
function _compress(
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
// GradleFilter — extended: download progress + daemon messages
// ---------------------------------------------------------------------------

describe("TestGradleFilterDownloadProgress", () => {
  // GradleFilter collapses download-progress lines into a count summary.
  const GRADLE = new GradleFilter();

  function _build_output(extra_lines: string[]): string {
    const lines = [
      "> Configure project :app",
      "> Task :app:compileJava",
      "Download https://repo.maven.apache.org/maven2/org/foo/foo-1.0.jar",
      "Download https://repo.maven.apache.org/maven2/org/bar/bar-2.0.jar",
      "Download https://repo.maven.apache.org/maven2/org/baz/baz-3.0.jar",
      ...extra_lines,
      "BUILD SUCCESSFUL in 12s",
    ];
    return lines.join("\n");
  }

  it("test_download_lines_collapsed_to_note", () => {
    const output = _build_output([]);
    const argv = ["./gradlew", "build"];
    const result = GRADLE.apply(output, "", 0, argv);
    expect(result.text).toContain("collapsed 3 dependency download lines");
    // None of the raw Download URLs should appear
    expect(result.text).not.toContain("https://repo.maven.apache.org");
  });

  it("test_build_successful_preserved", () => {
    const output = _build_output([]);
    const argv = ["./gradlew", "build"];
    const result = GRADLE.apply(output, "", 0, argv);
    expect(result.text).toContain("BUILD SUCCESSFUL");
  });

  it("test_no_download_lines_no_note", () => {
    const output = ["> Task :app:compileJava", "BUILD SUCCESSFUL in 1s"].join("\n");
    const argv = ["./gradlew", "build"];
    const result = GRADLE.apply(output, "", 0, argv);
    expect(result.text.toLowerCase()).not.toContain("download");
  });

  it("test_downloading_prefix_also_collapsed", () => {
    // 'Downloading https://...' (progressive participle) is also collapsed.
    const output = [
      "Downloading https://plugins.gradle.org/m2/com/foo/foo.jar",
      "Downloading https://plugins.gradle.org/m2/com/bar/bar.jar",
      "BUILD SUCCESSFUL in 5s",
    ].join("\n");
    const argv = ["gradle", "build"];
    const result = GRADLE.apply(output, "", 0, argv);
    expect(result.text).toContain("collapsed 2 dependency download lines");
    expect(result.text).not.toContain("plugins.gradle.org");
  });
});

describe("TestGradleFilterDaemonMessages", () => {
  // GradleFilter drops Gradle Daemon start messages on success.
  const GRADLE = new GradleFilter();

  it("test_daemon_started_dropped_on_success", () => {
    const output = [
      "Starting Gradle Daemon...",
      "Gradle Daemon started in 1 s",
      "> Task :app:test",
      "BUILD SUCCESSFUL in 8s",
    ].join("\n");
    const argv = ["./gradlew", "build"];
    const result = GRADLE.apply(output, "", 0, argv);
    expect(result.text).not.toContain("Starting Gradle Daemon");
    expect(result.text).not.toContain("Daemon started");
    expect(result.text.toLowerCase()).toContain("dropped");
  });

  it("test_daemon_on_failure_preserved_in_last_20", () => {
    // On failure (exit_code != 0), last 20 lines are kept verbatim.
    const output = [
      "Starting Gradle Daemon...",
      "Daemon started in 2 s",
      "BUILD FAILED",
    ].join("\n");
    const argv = ["./gradlew", "build"];
    const result = GRADLE.apply(output, "", 1, argv);
    // Failure path: last 20 lines are returned; daemon line may appear
    expect(result.text).toContain("BUILD FAILED");
  });
});

describe("TestGradleFilterTestTask", () => {
  // GradleFilter handles test task output correctly.
  const GRADLE = new GradleFilter();

  it("test_test_task_progress_lines_dropped", () => {
    const output = [
      "> Task :app:compileTestJava",
      "> Task :app:test",
      "3 tests completed, 0 failed",
      "BUILD SUCCESSFUL in 4s",
    ].join("\n");
    const argv = ["./gradlew", "test"];
    const result = GRADLE.apply(output, "", 0, argv);
    // Task progress lines should be dropped
    expect(result.text).not.toContain("> Task :app:test");
    // Test summary and build result should be kept (in last-30 tail)
    expect(result.text).toContain("BUILD SUCCESSFUL");
  });
});

// ---------------------------------------------------------------------------
// AntFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe("TestAntFilterMatches", () => {
  const ANT = new AntFilter();

  it("test_ant_matches", () => {
    expect(ANT.matches(["ant"])).toBeTruthy();
    expect(ANT.matches(["ant", "compile"])).toBeTruthy();
    expect(ANT.matches(["ant", "clean", "build"])).toBeTruthy();
  });

  it("test_ant_exe_matches", () => {
    expect(ANT.matches(["ant.exe"])).toBeTruthy();
  });

  it("test_non_ant_no_match", () => {
    expect(ANT.matches(["maven"])).toBeFalsy();
    expect(ANT.matches(["gradle"])).toBeFalsy();
    expect(ANT.matches([])).toBeFalsy();
  });

  it("test_dispatch_routes_to_ant", () => {
    const f = bc.select_filter(["ant", "compile"]);
    expect(f).not.toBeNull();
    expect(f?.name).toBe("ant");
  });
});

const _ANT_LONG_OUTPUT = `Buildfile: build.xml

init:
   [mkdir] Created dir: /project/build
   [mkdir] Created dir: /project/dist

compile:
   [echo] Compiling sources...
   [javac] Compiling 42 source files to /project/build
   [echo] Done compiling.
   [copy] Copying 10 files to /project/build
   [copy] Copying 5 files to /project/dist

BUILD SUCCESSFUL
Total time: 3 seconds
`;

describe("TestAntFilterBuildSuccessful", () => {
  const ANT = new AntFilter();

  it("test_build_successful_preserved", () => {
    const result = _compress(ANT, _ANT_LONG_OUTPUT);
    expect(result).toContain("BUILD SUCCESSFUL");
  });

  it("test_echo_lines_collapsed", () => {
    const result = _compress(ANT, _ANT_LONG_OUTPUT);
    // Raw [echo] lines should not appear; they're collapsed to a count
    expect(result).not.toContain("[echo] Compiling sources...");
    expect(result).not.toContain("[echo] Done compiling.");
    expect(
      !result.includes("[echo]") || result.includes("×") || result.includes("collapsed"),
    ).toBeTruthy();
  });

  it("test_mkdir_lines_collapsed", () => {
    const result = _compress(ANT, _ANT_LONG_OUTPUT);
    expect(result).not.toContain("[mkdir] Created dir: /project/build");
    // Should have a count note
    expect(result).toContain("mkdir");
  });

  it("test_copy_lines_collapsed", () => {
    const result = _compress(ANT, _ANT_LONG_OUTPUT);
    expect(result).not.toContain("[copy] Copying 10 files");
  });

  it("test_javac_non_diag_passed_through", () => {
    // [javac] lines that are not error/warning pass through (they carry info).
    const result = _compress(ANT, _ANT_LONG_OUTPUT);
    // The [javac] compilation line is not a diagnostic — passes through
    expect(result).toContain("[javac] Compiling 42 source files");
  });

  it("test_total_time_preserved", () => {
    const result = _compress(ANT, _ANT_LONG_OUTPUT);
    expect(result).toContain("Total time");
  });
});

const _ANT_FAIL_OUTPUT = `compile:
   [echo] Compiling...
   [javac] Compiling 5 source files
   [javac] /project/src/Main.java:10: error: ';' expected
   [javac] /project/src/Main.java:15: warning: unchecked cast

BUILD FAILED
/project/build.xml:25: Compile failed; see the compiler error output for details.

Total time: 1 second
`;

describe("TestAntFilterBuildFailed", () => {
  const ANT = new AntFilter();

  it("test_build_failed_preserved", () => {
    const result = _compress(ANT, _ANT_FAIL_OUTPUT);
    expect(result).toContain("BUILD FAILED");
  });

  it("test_javac_error_preserved", () => {
    const result = _compress(ANT, _ANT_FAIL_OUTPUT);
    expect(result).toContain("error: ';' expected");
  });

  it("test_javac_warning_preserved", () => {
    const result = _compress(ANT, _ANT_FAIL_OUTPUT);
    expect(result).toContain("warning: unchecked cast");
  });

  it("test_echo_lines_still_collapsed_on_failure", () => {
    const result = _compress(ANT, _ANT_FAIL_OUTPUT);
    // Even on failure the echo lines are collapsed (not in path through filter)
    expect(result).not.toContain("[echo] Compiling...");
  });
});

describe("TestAntFilterSavings", () => {
  const ANT = new AntFilter();

  it("test_savings_on_verbose_build", () => {
    // Build with 50 [echo] and 50 [copy] lines — should compress well
    const echo_lines = Array.from({ length: 50 }, (_, i) => `   [echo] Processing file ${i}`);
    const copy_lines = Array.from({ length: 50 }, (_, i) => `   [copy] Copying file${i}.jar`);
    const output = ["compile:", ...echo_lines, ...copy_lines, "BUILD SUCCESSFUL"].join("\n");
    const result = ANT.apply(output, "", 0, ["ant", "compile"]);
    expect(result.percent_saved).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// BazelFilter — dispatch + compression
// ---------------------------------------------------------------------------

describe("TestBazelFilterMatches", () => {
  const BAZEL = new BazelFilter();

  it("test_bazel_build_matches", () => {
    expect(BAZEL.matches(["bazel", "build", "//..."])).toBeTruthy();
  });

  it("test_bazel_test_matches", () => {
    expect(BAZEL.matches(["bazel", "test", "//..."])).toBeTruthy();
  });

  it("test_bazel_run_matches", () => {
    expect(BAZEL.matches(["bazel", "run", "//app:main"])).toBeTruthy();
  });

  it("test_bazelisk_matches", () => {
    expect(BAZEL.matches(["bazelisk", "build", "//..."])).toBeTruthy();
  });

  it("test_non_bazel_no_match", () => {
    expect(BAZEL.matches(["gradle"])).toBeFalsy();
    expect(BAZEL.matches(["make"])).toBeFalsy();
    expect(BAZEL.matches([])).toBeFalsy();
  });

  it("test_dispatch_routes_to_bazel", () => {
    const f = bc.select_filter(["bazel", "build", "//..."]);
    expect(f).not.toBeNull();
    expect(f?.name).toBe("bazel");
  });

  it("test_bazelisk_dispatch", () => {
    const f = bc.select_filter(["bazelisk", "test", "//..."]);
    expect(f).not.toBeNull();
    expect(f?.name).toBe("bazel");
  });
});

const _BAZEL_BUILD_OUTPUT = `INFO: Analyzed 42 targets (120 packages loaded, 3400 targets configured).
INFO: Found 42 targets...
INFO: From Compiling src/main/java/com/example/Foo.java:
INFO: From Compiling src/main/java/com/example/Bar.java:
INFO: From Compiling src/main/java/com/example/Baz.java:
INFO: From Linking //src/main:app:
INFO: Build option --compilation_mode has changed, discarding analysis cache.
Build completed successfully, 45 total actions
Elapsed time: 15.234s, Critical Path: 8.5s
`;

describe("TestBazelFilterBuildOutput", () => {
  const BAZEL = new BazelFilter();

  it("test_analyzed_targets_kept", () => {
    const result = _compress(BAZEL, _BAZEL_BUILD_OUTPUT);
    expect(result).toContain("INFO: Analyzed 42 targets");
  });

  it("test_found_targets_kept", () => {
    const result = _compress(BAZEL, _BAZEL_BUILD_OUTPUT);
    expect(result).toContain("INFO: Found 42 targets");
  });

  it("test_compile_actions_collapsed", () => {
    const result = _compress(BAZEL, _BAZEL_BUILD_OUTPUT);
    expect(result).not.toContain("INFO: From Compiling src/main/java/com/example/Foo.java");
    expect(result.toLowerCase().includes("collapsed") && result.toLowerCase().includes("compile")).toBeTruthy();
  });

  it("test_elapsed_time_kept", () => {
    const result = _compress(BAZEL, _BAZEL_BUILD_OUTPUT);
    expect(result).toContain("Elapsed time: 15.234s");
  });

  it("test_build_completed_kept", () => {
    const result = _compress(BAZEL, _BAZEL_BUILD_OUTPUT);
    expect(result).toContain("Build completed successfully");
  });

  it("test_misc_info_progress_collapsed", () => {
    const result = _compress(BAZEL, _BAZEL_BUILD_OUTPUT);
    // "Build option --compilation_mode has changed..." is a misc INFO line
    expect(result).not.toContain("compilation_mode");
  });
});

const _BAZEL_TEST_OUTPUT = `INFO: Analyzed 10 targets (5 packages loaded, 200 targets configured).
INFO: Found 10 test targets...
//com/example:FooTest                                        PASSED in 0.5s
//com/example:BarTest                                        PASSED in 1.2s
//com/example:BazTest                                        PASSED in 0.3s
//com/example:QuxTest                                        FAILED in 2.1s
  /tmp/bazel-test/_objs/BazTest/test.log
//com/example:QuuxTest                                       PASSED in 0.8s
Elapsed time: 5.6s, Critical Path: 2.1s
INFO: Build completed, 1 test FAILED, 10 total actions
`;

describe("TestBazelFilterTestOutput", () => {
  const BAZEL = new BazelFilter();

  it("test_passing_tests_collapsed", () => {
    const result = _compress(BAZEL, _BAZEL_TEST_OUTPUT);
    expect(result).not.toContain("//com/example:FooTest");
    expect(result).not.toContain("//com/example:BarTest");
    expect(result).not.toContain("//com/example:QuuxTest");
    expect(result).toContain("collapsed 4 PASSED test targets");
  });

  it("test_failed_test_kept", () => {
    const result = _compress(BAZEL, _BAZEL_TEST_OUTPUT);
    expect(result).toContain("//com/example:QuxTest");
    expect(result).toContain("FAILED in 2.1s");
  });

  it("test_elapsed_time_kept", () => {
    const result = _compress(BAZEL, _BAZEL_TEST_OUTPUT);
    expect(result).toContain("Elapsed time: 5.6s");
  });

  it("test_analyzed_kept", () => {
    const result = _compress(BAZEL, _BAZEL_TEST_OUTPUT);
    expect(result).toContain("INFO: Analyzed 10 targets");
  });
});

const _BAZEL_FAIL_OUTPUT = `INFO: Analyzed 5 targets.
INFO: From Compiling src/main.cc:
ERROR: /workspace/BUILD:10:5: CppCompile src/main.cc failed: (Exit 1): bash failed
src/main.cc:25:3: error: use of undeclared identifier 'foo'
FAILED: Build did NOT complete successfully
Elapsed time: 3.2s, Critical Path: 3.2s
`;

describe("TestBazelFilterBuildFailed", () => {
  const BAZEL = new BazelFilter();

  it("test_failed_banner_kept", () => {
    const result = _compress(BAZEL, _BAZEL_FAIL_OUTPUT);
    expect(result).toContain("FAILED: Build did NOT complete successfully");
  });

  it("test_error_line_kept", () => {
    const result = _compress(BAZEL, _BAZEL_FAIL_OUTPUT);
    expect(result).toContain("ERROR:");
  });

  it("test_elapsed_time_kept", () => {
    const result = _compress(BAZEL, _BAZEL_FAIL_OUTPUT);
    expect(result).toContain("Elapsed time: 3.2s");
  });

  it("test_compile_action_still_collapsed", () => {
    const result = _compress(BAZEL, _BAZEL_FAIL_OUTPUT);
    expect(result).not.toContain("INFO: From Compiling src/main.cc:");
  });
});

describe("TestBazelFilterSavings", () => {
  const BAZEL = new BazelFilter();

  it("test_savings_on_large_build", () => {
    const compile_lines = Array.from(
      { length: 100 },
      (_, i) => `INFO: From Compiling src/module_${i}/file.cc:`,
    );
    const info_lines = Array.from({ length: 50 }, (_, i) => `INFO: Running action ${i}...`);
    const pass_lines = Array.from(
      { length: 30 },
      (_, i) => `//test:Test${i}                              PASSED in 0.${i}s`,
    );
    const output = [
      "INFO: Analyzed 130 targets.",
      "INFO: Found 130 targets...",
      ...compile_lines,
      ...info_lines,
      ...pass_lines,
      "Elapsed time: 120.5s",
      "Build completed successfully, 180 total actions",
    ].join("\n");
    const result = BAZEL.apply(output, "", 0, ["bazel", "build", "//..."]);
    expect(result.percent_saved).toBeGreaterThan(70);
  });
});
