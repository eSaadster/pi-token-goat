/**
 * Enhanced MavenFilter tests covering compression behaviours not in the baseline suite.
 *
 * 1:1 port of tests/test_bash_compress_maven_enhanced.py. Every Python `def
 * test_*` maps to a vitest `it()` with the SAME name and assertion polarity;
 * the Python test classes (TestMavenSeparatorLines, TestMavenBoilerplateLines,
 * TestMavenReactorLines, TestMavenWarningLines, TestMavenMultiModuleBuild,
 * TestMavenCompressionRatio) map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the JVM filter classes incl. MavenFilter).
 *  - module-level `F = bc.MavenFilter()` and the `_compress(stdout, ...)` helper
 *    -> a module-level `const F = new MavenFilter()` and a `_compress()` helper
 *       that calls `apply_filter(F, ...)` with argv `["mvn", subcmd]`.
 *  - `from filter_test_helpers import apply_filter as _apply`
 *      -> local `apply_filter(filter, stdout, opts?)` helper below; runs
 *         `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *         to `[filter_.name]` (matching the Python helper exactly).
 *  - `class TestX(FilterTestMixin): F = bc.MavenFilter()` — the mixin injects
 *    two inherited tests, `test_empty_input` and `test_empty_output`, into every
 *    subclass's pytest collection. The TS port reproduces them with a shared
 *    `filterTestMixin(describeName)` helper that emits both `it()`s using a
 *    per-class fresh `new MavenFilter()` (matching the class-level `F`), so each
 *    describe block carries the same two extra tests with the same names.
 *
 * Byte-exactness: the assertions here are substring `in` / `not in` checks and
 * `len()` comparisons on the returned string. The Python helper compares
 * `len(out) < len(stdout)` / `1.0 - len(out)/len(stdout)`; the fixtures are pure
 * ASCII so Python `len` (code points) equals JS `.length` (UTF-16 code units)
 * equals the byte count for these inputs — no Buffer arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import { MavenFilter } from "../src/token_goat/bash_compress.js";

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
// Shared fixture
// ---------------------------------------------------------------------------

const F = new MavenFilter();

function _compress(
  stdout: string,
  opts?: { stderr?: string; exit_code?: number; subcmd?: string },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const subcmd = opts?.subcmd ?? "test";
  return apply_filter(F, stdout, { stderr, exit_code, argv: ["mvn", subcmd] });
}

// ---------------------------------------------------------------------------
// FilterTestMixin — two inherited tests injected into every subclass. Each
// subclass defines its own class-level `F = bc.MavenFilter()`; reproduce with a
// fresh instance per describe block.
// ---------------------------------------------------------------------------
function filterTestMixin(): void {
  it("test_empty_input", () => {
    const mixinF = new MavenFilter();
    const out = apply_filter(mixinF, "");
    expect(typeof out).toBe("string");
  });

  it("test_empty_output", () => {
    const mixinF = new MavenFilter();
    const result = apply_filter(mixinF, "");
    expect(typeof result).toBe("string");
  });
}

// ---------------------------------------------------------------------------
// Separator lines
// ---------------------------------------------------------------------------

const _SEPARATOR_LINES =
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] Building my-app 1.0-SNAPSHOT\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] BUILD SUCCESS\n" +
  "[INFO] ------------------------------------------------------------------------\n";

describe("TestMavenSeparatorLines", () => {
  filterTestMixin();

  it("test_separator_lines_not_in_output", () => {
    const out = _compress(_SEPARATOR_LINES);
    expect(out).not.toContain("--------");
  });

  it("test_build_success_kept_when_separators_dropped", () => {
    const out = _compress(_SEPARATOR_LINES);
    expect(out).toContain("BUILD SUCCESS");
  });

  it("test_boilerplate_note_emitted", () => {
    const out = _compress(_SEPARATOR_LINES);
    expect(out).toContain("[INFO] boilerplate/separator lines");
  });

  it("test_separator_count_in_note", () => {
    const out = _compress(_SEPARATOR_LINES);
    // 4 separator + 1 Building boilerplate = 5 noise lines; filter groups them as 4 collapsed
    expect(out).toContain("collapsed 4");
  });
});

// ---------------------------------------------------------------------------
// INFO boilerplate lines
// ---------------------------------------------------------------------------

const _BOILERPLATE_LINES =
  "[INFO] Scanning for projects...\n" +
  "[INFO] Building mylib 2.3.0\n" +
  "[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ mylib ---\n" +
  "[INFO] skip non existing resourceDirectory /src/main/resources\n" +
  "[INFO] Compiling 12 source files to /target/classes\n" +
  "[INFO] No sources to compile\n" +
  "[INFO] Nothing to compile - all classes are up to date\n" +
  "[INFO] Changes detected - recompiling the module!\n" +
  "[INFO] BUILD SUCCESS\n";

describe("TestMavenBoilerplateLines", () => {
  filterTestMixin();

  it("test_scanning_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("Scanning for projects");
  });

  it("test_building_artifact_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("Building mylib");
  });

  it("test_plugin_header_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("maven-compiler-plugin");
  });

  it("test_skip_non_existing_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("skip non existing");
  });

  it("test_compiling_n_source_files_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("Compiling 12 source files");
  });

  it("test_no_sources_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("No sources to compile");
  });

  it("test_nothing_to_compile_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("Nothing to compile");
  });

  it("test_changes_detected_dropped", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).not.toContain("Changes detected");
  });

  it("test_build_success_still_kept", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).toContain("BUILD SUCCESS");
  });

  it("test_boilerplate_note_emitted", () => {
    const out = _compress(_BOILERPLATE_LINES);
    expect(out).toContain("[INFO] boilerplate/separator lines");
  });
});

// ---------------------------------------------------------------------------
// Reactor lines (multi-module build)
// ---------------------------------------------------------------------------

const _REACTOR_LINES =
  "[INFO] Reactor Build Order:\n" +
  "[INFO]   module-a\n" +
  "[INFO]   module-b\n" +
  "[INFO]\n" +
  "[INFO] BUILD SUCCESS\n" +
  "[INFO] Reactor Summary for myproject 1.0:\n" +
  "[INFO] module-a ........ SUCCESS [  1.234 s]\n" +
  "[INFO] module-b ........ SUCCESS [  2.567 s]\n";

describe("TestMavenReactorLines", () => {
  filterTestMixin();

  it("test_reactor_build_order_dropped", () => {
    const out = _compress(_REACTOR_LINES);
    expect(out).not.toContain("Reactor Build Order");
  });

  it("test_reactor_summary_dropped", () => {
    const out = _compress(_REACTOR_LINES);
    expect(out).not.toContain("Reactor Summary");
  });

  it("test_build_success_kept_with_reactor", () => {
    const out = _compress(_REACTOR_LINES);
    expect(out).toContain("BUILD SUCCESS");
  });

  it("test_note_emitted_for_reactor_drop", () => {
    const out = _compress(_REACTOR_LINES);
    expect(out).toContain("collapsed");
  });
});

// ---------------------------------------------------------------------------
// [WARNING] lines kept (not only [WARN])
// ---------------------------------------------------------------------------

const _WARNING_LINES =
  "[INFO] Scanning for projects...\n" +
  "[WARNING] The POM for com.example:foo:jar:1.0 is invalid\n" +
  "[WARNING] 'build.plugins.plugin.version' for org.apache.maven.plugins:maven-jar-plugin\n" +
  "[WARN] Using platform encoding (UTF-8 actually) to copy filtered resources\n" +
  "[INFO] BUILD SUCCESS\n";

describe("TestMavenWarningLines", () => {
  filterTestMixin();

  it("test_warning_prefix_kept", () => {
    const out = _compress(_WARNING_LINES);
    expect(out).toContain("The POM for com.example:foo:jar:1.0 is invalid");
  });

  it("test_second_warning_kept", () => {
    const out = _compress(_WARNING_LINES);
    expect(out).toContain("build.plugins.plugin.version");
  });

  it("test_warn_prefix_kept", () => {
    const out = _compress(_WARNING_LINES);
    expect(out).toContain("Using platform encoding");
  });

  it("test_scanning_noise_still_dropped", () => {
    const out = _compress(_WARNING_LINES);
    expect(out).not.toContain("Scanning for projects");
  });
});

// ---------------------------------------------------------------------------
// Realistic multi-module build (integration scenario)
// ---------------------------------------------------------------------------

const _MULTIMODULE_BUILD =
  "[INFO] Scanning for projects...\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] Reactor Build Order:\n" +
  "[INFO]   core\n" +
  "[INFO]   api\n" +
  "[INFO]   app\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] Building core 1.0-SNAPSHOT\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] --- maven-resources-plugin:3.3.0:resources ---\n" +
  "[INFO] Downloading: https://repo1.maven.org/maven2/commons-lang3/3.12.0.jar\n" +
  "[INFO] Downloaded: https://repo1.maven.org/maven2/commons-lang3/3.12.0.jar\n" +
  "[INFO] --- maven-compiler-plugin:3.11.0:compile ---\n" +
  "[INFO] Compiling 42 source files to /core/target/classes\n" +
  "[INFO] --- maven-surefire-plugin:3.0.0:test ---\n" +
  "[INFO] Tests run: 18, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.23 s\n" +
  "[INFO] Building api 1.0-SNAPSHOT\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] Compiling 15 source files to /api/target/classes\n" +
  "[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.45 s\n" +
  "[INFO] Building app 1.0-SNAPSHOT\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] Tests run: 32, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.11 s\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] Reactor Summary for myproject 1.0:\n" +
  "[INFO] core ..... SUCCESS [  2.5 s]\n" +
  "[INFO] api ...... SUCCESS [  1.2 s]\n" +
  "[INFO] app ...... SUCCESS [  4.3 s]\n" +
  "[INFO] ------------------------------------------------------------------------\n" +
  "[INFO] BUILD SUCCESS\n" +
  "[INFO] ------------------------------------------------------------------------\n";

describe("TestMavenMultiModuleBuild", () => {
  filterTestMixin();

  it("test_all_test_summaries_kept", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out).toContain("Tests run: 18");
    expect(out).toContain("Tests run: 7");
    expect(out).toContain("Tests run: 32");
  });

  it("test_build_success_kept", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out).toContain("BUILD SUCCESS");
  });

  it("test_separator_lines_removed", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out).not.toContain("--------");
  });

  it("test_download_lines_removed", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out).not.toContain("Downloading:");
    expect(out).not.toContain("Downloaded:");
  });

  it("test_boilerplate_lines_removed", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out).not.toContain("Scanning for projects");
    expect(out).not.toContain("maven-compiler-plugin");
  });

  it("test_reactor_lines_removed", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out).not.toContain("Reactor Build Order");
    expect(out).not.toContain("Reactor Summary");
  });

  it("test_output_shorter_than_input", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out.length).toBeLessThan(_MULTIMODULE_BUILD.length);
  });

  it("test_compression_note_emitted", () => {
    const out = _compress(_MULTIMODULE_BUILD);
    expect(out.includes("[token-goat:") && out.includes("collapsed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compression ratio
// ---------------------------------------------------------------------------

function _savings_ratio(stdout: string, subcmd = "test"): number {
  const out = _compress(stdout, { subcmd });
  if (!stdout) {
    return 0.0;
  }
  return 1.0 - out.length / stdout.length;
}

describe("TestMavenCompressionRatio", () => {
  filterTestMixin();

  it("test_ratio_on_noisy_build", () => {
    // Build output dominated by separators, boilerplate, and downloads.
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        "[INFO] ------------------------------------------------------------------------",
      );
      lines.push(`[INFO] Building module-${i} 1.0-SNAPSHOT`);
      lines.push("[INFO] --- maven-compiler-plugin:3.11.0:compile ---");
      lines.push(`[INFO] Downloading: https://repo1.example.com/dep-${i}.jar`);
      lines.push(`[INFO] Downloaded: https://repo1.example.com/dep-${i}.jar`);
      lines.push(`[INFO] Tests run: ${i + 1}, Failures: 0, Errors: 0, Skipped: 0`);
    }
    lines.push("[INFO] BUILD SUCCESS");
    const text = lines.join("\n");
    const ratio = _savings_ratio(text);
    expect(ratio).toBeGreaterThanOrEqual(0.6);
  });

  it("test_ratio_on_separator_heavy_output", () => {
    // Every other line is a separator — should compress heavily.
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(
        "[INFO] ------------------------------------------------------------------------",
      );
      lines.push(`[INFO] --- some-plugin:goal @ module-${i} ---`);
    }
    lines.push("[INFO] BUILD SUCCESS");
    const text = lines.join("\n");
    const ratio = _savings_ratio(text);
    expect(ratio).toBeGreaterThanOrEqual(0.9);
  });
});
