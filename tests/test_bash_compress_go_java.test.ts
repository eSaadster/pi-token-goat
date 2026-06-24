/**
 * Tests for GoFilter, JavacFilter, and SbtFilter.
 *
 * 1:1 port of tests/test_bash_compress_go_java.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name.
 *
 * Covers (per the Python module docstring):
 *  - Filter dispatch: correct filter selected for each command shape.
 *  - Compression correctness: signal preserved, noise collapsed.
 *  - Savings ratio: meaningful compression on realistic output.
 *  - Edge cases: empty output, exit_code != 0, subcommand routing.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _apply`
 *      -> local `_apply(filter, opts?)` helper below. The Python helper runs
 *        `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *        to `[filter_.name]`; the TS port mirrors that exactly.
 *  - `from filter_test_helpers import savings_ratio as _savings_ratio`
 *      -> local `_savings_ratio(filter, stdout, opts?)` helper returning
 *        `filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0`.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`.
 *  - Class-body `GO = bc.GoFilter()` (a class attribute shared by the methods)
 *      -> a `const GO = new GoFilter()` inside the describe block.
 *
 * Deferral: NONE. JavacFilter, SbtFilter, and MakeFilter are all ported (the
 * bash_compress/jvm.ts module, re-exported via the barrel and registered in
 * FILTERS), so every TestJavac* / TestSbt* test and the MakeFilter-ordering
 * test (`test_go_filter_before_make_filter`) is a live `it()` with the same
 * name + assertion polarity as the Python source.
 *
 * Byte-exactness: the savings-ratio assertions exercise `percent_saved`, which
 * the framework computes from UTF-8 byte lengths; the helper divides by 100.0
 * exactly as Python does. The substring `in` / `not in` checks translate to
 * `toContain` / `not.toContain`. Where a glyph is asserted it is the same
 * Unicode codepoint as the Python source.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { GoFilter, JavacFilter, SbtFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter / savings_ratio helpers (ports of
// filter_test_helpers.apply_filter / .savings_ratio, aliased as `_apply` /
// `_savings_ratio` at the Python import site).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element — the minimum needed for these structural-compression tests.
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

function _savings_ratio(
  filter_: Filter,
  stdout: string,
  opts?: { stderr?: string; argv?: string[] },
): number {
  const stderr = opts?.stderr ?? "";
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0;
}

// ===========================================================================
// GoFilter
// ===========================================================================

describe("TestGoFilterMatches", () => {
  // GoFilter matches the expected go subcommands and rejects others.
  const GO = new GoFilter();

  it("test_go_build_matches", () => {
    expect(GO.matches(["go", "build", "./..."])).toBe(true);
  });

  it("test_go_build_exe_matches", () => {
    expect(GO.matches(["go.exe", "build", "./..."])).toBe(true);
  });

  it("test_go_install_matches", () => {
    expect(GO.matches(["go", "install", "./..."])).toBe(true);
  });

  it("test_go_get_matches", () => {
    expect(GO.matches(["go", "get", "github.com/foo/bar@v1.2.3"])).toBe(true);
  });

  it("test_go_mod_tidy_matches", () => {
    expect(GO.matches(["go", "mod", "tidy"])).toBe(true);
  });

  it("test_go_mod_download_matches", () => {
    expect(GO.matches(["go", "mod", "download"])).toBe(true);
  });

  it("test_go_run_matches", () => {
    expect(GO.matches(["go", "run", "main.go"])).toBe(true);
  });

  it("test_go_vet_matches", () => {
    expect(GO.matches(["go", "vet", "./..."])).toBe(true);
  });

  it("test_go_generate_matches", () => {
    expect(GO.matches(["go", "generate", "./..."])).toBe(true);
  });

  it("test_go_clean_matches", () => {
    expect(GO.matches(["go", "clean"])).toBe(true);
  });

  it("test_go_test_does_not_match", () => {
    // go test must route to GoTestFilter, not GoFilter.
    expect(GO.matches(["go", "test", "./..."])).toBe(false);
  });

  it("test_bare_go_does_not_match", () => {
    expect(GO.matches(["go"])).toBe(false);
  });

  it("test_empty_does_not_match", () => {
    expect(GO.matches([])).toBe(false);
  });

  it("test_non_go_binary_does_not_match", () => {
    expect(GO.matches(["goimports", "build"])).toBe(false);
  });
});

describe("TestGoFilterDispatch", () => {
  // select_filter routes go subcommands correctly.
  it("test_go_build_routes_to_go", () => {
    const f = bc.select_filter(["go", "build", "./..."]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("go");
  });

  it("test_go_get_routes_to_go", () => {
    const f = bc.select_filter(["go", "get", "golang.org/x/tools@latest"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("go");
  });

  it("test_go_mod_routes_to_go", () => {
    const f = bc.select_filter(["go", "mod", "tidy"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("go");
  });

  it("test_go_test_routes_to_go_test", () => {
    // go test must remain in GoTestFilter.
    const f = bc.select_filter(["go", "test", "./..."]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("go-test");
  });

  it("test_go_filter_before_make_filter", () => {
    // GoFilter must be registered before MakeFilter.
    const names = bc.FILTERS.map((f) => f.name);
    const go_idx = names.indexOf("go");
    const make_idx = names.indexOf("make");
    expect(
      go_idx < make_idx,
      "GoFilter must be registered before MakeFilter so `go build` routes " +
        "to GoFilter instead of MakeFilter's generic build compression.",
    ).toBe(true);
  });

  it("test_go_test_before_go_filter", () => {
    // GoTestFilter must precede GoFilter.
    const names = bc.FILTERS.map((f) => f.name);
    const go_test_idx = names.indexOf("go-test");
    const go_idx = names.indexOf("go");
    expect(
      go_test_idx < go_idx,
      "GoTestFilter must be registered before GoFilter.",
    ).toBe(true);
  });
});

const _GO_BUILD_CLEAN_OUTPUT =
  "# github.com/example/myapp/cmd\n" +
  "# github.com/example/myapp/internal/db\n" +
  "# github.com/example/myapp/internal/server\n";

const _GO_BUILD_ERROR_OUTPUT =
  "# github.com/example/myapp/cmd\n" +
  "cmd/main.go:12:5: undefined: badFunc\n" +
  "cmd/main.go:15:3: too many arguments in call to fmt.Println\n" +
  "# github.com/example/myapp/internal/db\n" +
  'internal/db/conn.go:8:2: imported and not used: "fmt"\n';

const _GO_BUILD_DOWNLOAD_OUTPUT =
  "go: downloading github.com/pkg/errors v0.9.1\n" +
  "go: downloading github.com/stretchr/testify v1.8.4\n" +
  "go: downloading github.com/gorilla/mux v1.8.0\n" +
  "go: extracting github.com/pkg/errors v0.9.1\n";

describe("TestGoFilterGoBuild", () => {
  // GoFilter compresses `go build` output correctly.
  const GO = new GoFilter();

  function _apply_build(stdout: string, exit_code = 0): string {
    return _apply(GO, { stdout, exit_code, argv: ["go", "build", "./..."] });
  }

  it("test_clean_build_headers_collapsed", () => {
    const out = _apply_build(_GO_BUILD_CLEAN_OUTPUT);
    // Package headers should be collapsed to a note.
    expect(out).not.toContain("# github.com/example/myapp/cmd");
    expect(out.includes("suppressed") || out.includes("package header")).toBe(true);
  });

  it("test_error_lines_kept", () => {
    const out = _apply_build(_GO_BUILD_ERROR_OUTPUT, 1);
    expect(out).toContain("cmd/main.go:12:5: undefined: badFunc");
    expect(out).toContain("internal/db/conn.go:8:2: imported and not used");
  });

  it("test_error_headers_still_collapsed", () => {
    // Package headers are dropped even on failure — the error lines provide context.
    const out = _apply_build(_GO_BUILD_ERROR_OUTPUT, 1);
    expect(out).not.toContain("# github.com/example/myapp/cmd\n");
  });

  it("test_download_lines_collapsed_during_build", () => {
    const out = _apply_build(_GO_BUILD_DOWNLOAD_OUTPUT);
    expect(out).not.toContain("go: downloading github.com/pkg/errors");
    expect(out).toContain("collapsed");
  });

  it("test_savings_on_large_successful_build", () => {
    const lines = Array.from(
      { length: 80 },
      (_, i) => `# github.com/example/pkg${i}/internal`,
    );
    const output = lines.join("\n") + "\n";
    const ratio = _savings_ratio(GO, output, { argv: ["go", "build", "./..."] });
    expect(
      ratio >= 0.7,
      `Expected >= 70% savings on header-only build, got ${(ratio * 100).toFixed(0)}%`,
    ).toBe(true);
  });
});

const _GO_GET_OUTPUT =
  "go: downloading github.com/spf13/cobra v1.7.0\n" +
  "go: downloading github.com/spf13/pflag v1.0.5\n" +
  "go: downloading github.com/spf13/viper v1.16.0\n" +
  "go: downloading github.com/fsnotify/fsnotify v1.6.0\n" +
  "go: downloading github.com/hashicorp/hcl v1.0.0\n" +
  "go: extracting github.com/spf13/cobra v1.7.0\n" +
  "go: extracting github.com/spf13/pflag v1.0.5\n" +
  "go: finding module for package github.com/example/dep\n";

describe("TestGoFilterGoGet", () => {
  // GoFilter compresses `go get` download spam.
  const GO = new GoFilter();

  function _apply_get(stdout: string): string {
    return _apply(GO, { stdout, argv: ["go", "get", "github.com/spf13/cobra@latest"] });
  }

  it("test_download_lines_collapsed", () => {
    const out = _apply_get(_GO_GET_OUTPUT);
    expect(out).not.toContain("go: downloading github.com/spf13/cobra");
  });

  it("test_download_count_noted", () => {
    const out = _apply_get(_GO_GET_OUTPUT);
    expect(out).toContain("collapsed");
    expect(out.includes("downloading") || out.includes("extracting")).toBe(true);
  });

  it("test_savings_on_large_download", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `go: downloading github.com/example/dep${i} v1.${i}.0`,
    );
    const output = lines.join("\n");
    const ratio = _savings_ratio(GO, output, { argv: ["go", "get", "..."] });
    expect(
      ratio >= 0.8,
      `Expected >= 80% savings on download-only output, got ${(ratio * 100).toFixed(0)}%`,
    ).toBe(true);
  });
});

const _GO_MOD_TIDY_OUTPUT =
  "go: downloading github.com/pkg/errors v0.9.1\n" +
  "go: downloading github.com/stretchr/testify v1.8.4\n" +
  "go: found github.com/pkg/errors in github.com/pkg/errors v0.9.1\n" +
  "go: added golang.org/x/net v0.12.0\n" +
  "go: upgraded github.com/stretchr/testify v1.8.0 => v1.8.4\n" +
  "go: removed github.com/obsolete/pkg v0.1.0\n";

describe("TestGoFilterGoMod", () => {
  // GoFilter compresses `go mod tidy` output.
  const GO = new GoFilter();

  function _apply_mod(stdout: string): string {
    return _apply(GO, { stdout, argv: ["go", "mod", "tidy"] });
  }

  it("test_download_lines_collapsed", () => {
    const out = _apply_mod(_GO_MOD_TIDY_OUTPUT);
    expect(out).not.toContain("go: downloading github.com/pkg/errors");
  });

  it("test_module_change_lines_kept", () => {
    const out = _apply_mod(_GO_MOD_TIDY_OUTPUT);
    expect(out).toContain("go: added golang.org/x/net");
    expect(out).toContain("go: upgraded github.com/stretchr/testify");
    expect(out).toContain("go: removed github.com/obsolete/pkg");
  });

  it("test_found_line_kept", () => {
    const out = _apply_mod(_GO_MOD_TIDY_OUTPUT);
    expect(out).toContain("go: found github.com/pkg/errors");
  });
});

// ===========================================================================
// JavacFilter
// ===========================================================================

describe("TestJavacFilterMatches", () => {
  // JavacFilter matches javac and rejects other binaries.
  const JAVAC = new JavacFilter();

  it("test_javac_matches", () => {
    expect(JAVAC.matches(["javac", "Main.java"])).toBe(true);
  });

  it("test_javac_exe_matches", () => {
    expect(JAVAC.matches(["javac.exe", "Main.java"])).toBe(true);
  });

  it("test_javac_with_flags_matches", () => {
    expect(JAVAC.matches(["javac", "-cp", "lib/*", "-d", "out", "Main.java"])).toBe(true);
  });

  it("test_non_javac_no_match", () => {
    expect(JAVAC.matches(["java", "-jar", "app.jar"])).toBe(false);
    expect(JAVAC.matches(["javadoc", "Main.java"])).toBe(false);
    expect(JAVAC.matches(["ant", "compile"])).toBe(false);
  });

  it("test_empty_no_match", () => {
    expect(JAVAC.matches([])).toBe(false);
  });
});

describe("TestJavacFilterDispatch", () => {
  // select_filter routes javac correctly.
  it("test_javac_routes_to_javac", () => {
    const f = bc.select_filter(["javac", "-d", "out", "Main.java"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("javac");
  });

  it("test_javac_with_path_routes_correctly", () => {
    const f = bc.select_filter(["/usr/lib/jvm/java-17/bin/javac", "Main.java"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("javac");
  });
});

const _JAVAC_NOTE_HEAVY_OUTPUT =
  "Note: src/Main.java uses unchecked or unsafe operations.\n" +
  "Note: src/Util.java uses unchecked or unsafe operations.\n" +
  "Note: src/Parser.java uses unchecked or unsafe operations.\n" +
  "Note: src/Handler.java uses unchecked or unsafe operations.\n" +
  "Note: src/Controller.java uses unchecked or unsafe operations.\n" +
  "Note: Some input files use unchecked or unsafe operations.\n" +
  "Note: Recompile with -Xlint:unchecked for details.\n";

const _JAVAC_ERROR_OUTPUT =
  "src/Main.java:12: error: ';' expected\n" +
  "    int x = 5\n" +
  "            ^\n" +
  "src/Main.java:25: error: cannot find symbol\n" +
  "    foo.bar();\n" +
  "        ^\n" +
  "  symbol:   method bar()\n" +
  "  location: variable foo of type Foo\n" +
  "2 errors\n";

const _JAVAC_WARNING_OUTPUT =
  "src/Legacy.java:8: warning: [deprecation] OldClass in com.example has been deprecated\n" +
  "    OldClass obj = new OldClass();\n" +
  "                   ^\n" +
  "1 warning\n";

const _JAVAC_MIXED_OUTPUT =
  "Note: src/TypeA.java uses unchecked or unsafe operations.\n" +
  "Note: src/TypeB.java uses unchecked or unsafe operations.\n" +
  "Note: src/TypeC.java uses unchecked or unsafe operations.\n" +
  "Note: Some input files use unchecked or unsafe operations.\n" +
  "Note: Recompile with -Xlint:unchecked for details.\n" +
  "src/Main.java:10: error: incompatible types: int cannot be converted to String\n" +
  "    String s = 42;\n" +
  "               ^\n" +
  "1 error\n";

describe("TestJavacFilterNoteLines", () => {
  // JavacFilter collapses Note: unchecked lines.
  const JAVAC = new JavacFilter();

  it("test_per_file_notes_collapsed", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_NOTE_HEAVY_OUTPUT });
    // Individual file-specific Note lines should be collapsed.
    expect(out).not.toContain("Note: src/Main.java uses unchecked");
    expect(out).not.toContain("Note: src/Util.java uses unchecked");
  });

  it("test_collapse_note_in_output", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_NOTE_HEAVY_OUTPUT });
    expect(out).toContain("collapsed");
    expect(out.toLowerCase().includes("unchecked") || out.toLowerCase().includes("unsafe")).toBe(true);
  });

  it("test_summary_notes_dropped", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_NOTE_HEAVY_OUTPUT });
    expect(out).not.toContain("Note: Some input files use unchecked");
    expect(out).not.toContain("Recompile with -Xlint");
  });

  it("test_savings_on_note_heavy_output", () => {
    let lines = Array.from(
      { length: 60 },
      (_, i) =>
        `Note: src/File${String(i).padStart(3, "0")}.java uses unchecked or unsafe operations.`,
    );
    lines = lines.concat([
      "Note: Some input files use unchecked or unsafe operations.",
      "Note: Recompile with -Xlint:unchecked for details.",
    ]);
    const output = lines.join("\n");
    const ratio = _savings_ratio(JAVAC, output);
    expect(
      ratio >= 0.8,
      `Expected >= 80% savings on note-heavy output, got ${(ratio * 100).toFixed(0)}%`,
    ).toBe(true);
  });
});

describe("TestJavacFilterErrors", () => {
  // JavacFilter keeps error and warning diagnostic lines.
  const JAVAC = new JavacFilter();

  it("test_error_lines_kept", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_ERROR_OUTPUT, exit_code: 1 });
    expect(out).toContain("src/Main.java:12: error: ';' expected");
    expect(out).toContain("src/Main.java:25: error: cannot find symbol");
  });

  it("test_summary_line_kept", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_ERROR_OUTPUT, exit_code: 1 });
    expect(out).toContain("2 errors");
  });

  it("test_warning_line_kept", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_WARNING_OUTPUT });
    expect(out).toContain("warning: [deprecation]");
  });

  it("test_warning_summary_kept", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_WARNING_OUTPUT });
    expect(out).toContain("1 warning");
  });

  it("test_notes_collapsed_errors_kept_mixed", () => {
    const out = _apply(JAVAC, { stdout: _JAVAC_MIXED_OUTPUT, exit_code: 1 });
    // Notes collapsed.
    expect(out).not.toContain("Note: src/TypeA.java");
    expect(out).toContain("collapsed");
    // Error kept.
    expect(out).toContain("error: incompatible types");
    expect(out).toContain("1 error");
  });
});

// ===========================================================================
// SbtFilter
// ===========================================================================

describe("TestSbtFilterMatches", () => {
  // SbtFilter matches sbt binary forms.
  const SBT = new SbtFilter();

  it("test_sbt_matches", () => {
    expect(SBT.matches(["sbt", "compile"])).toBe(true);
  });

  it("test_sbt_wrapper_matches", () => {
    expect(SBT.matches(["./sbt", "test"])).toBe(true);
  });

  it("test_sbt_no_subcommand_matches", () => {
    expect(SBT.matches(["sbt"])).toBe(true);
  });

  it("test_non_sbt_no_match", () => {
    expect(SBT.matches(["mvn", "compile"])).toBe(false);
    expect(SBT.matches(["gradle", "build"])).toBe(false);
    expect(SBT.matches([])).toBe(false);
  });
});

describe("TestSbtFilterDispatch", () => {
  // select_filter routes sbt correctly.
  it("test_sbt_routes_to_sbt", () => {
    const f = bc.select_filter(["sbt", "test"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("sbt");
  });

  it("test_sbt_wrapper_routes_to_sbt", () => {
    const f = bc.select_filter(["./sbt", "compile"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("sbt");
  });
});

const _SBT_LOADING_OUTPUT =
  "[info] Loading global plugins from /home/user/.sbt/1.0/plugins\n" +
  "[info] Loading settings for project my-build from plugins.sbt ...\n" +
  "[info] Loading project definition from /home/user/myproject/project\n" +
  "[info] Loading settings for project myproject from build.sbt ...\n" +
  "[info] Set current project to myproject (in build file:/home/user/myproject/)\n" +
  "[info] Compiling 12 Scala sources to /home/user/myproject/target/scala-2.13/classes ...\n" +
  "[info] Done compiling.\n" +
  "[success] Total time: 8 s, completed 30 May 2026\n";

const _SBT_WARN_OUTPUT =
  "[info] Compiling 5 Scala sources to /home/user/myproject/target/scala-2.13/classes ...\n" +
  "[warn] /home/user/myproject/src/main/scala/App.scala:12:5: method `foo` is deprecated\n" +
  "[warn] /home/user/myproject/src/main/scala/App.scala:15:5: method `bar` is deprecated\n" +
  "[warn] /home/user/myproject/src/main/scala/App.scala:18:5: method `baz` is deprecated\n" +
  "[warn] /home/user/myproject/src/main/scala/App.scala:21:5: method `qux` is deprecated\n" +
  "[warn] /home/user/myproject/src/main/scala/App.scala:24:5: method `quux` is deprecated\n" +
  "[warn] /home/user/myproject/src/main/scala/App.scala:27:5: method `corge` is deprecated\n" +
  "[warn] /home/user/myproject/src/main/scala/App.scala:30:5: method `grault` is deprecated\n" +
  "[info] Done compiling.\n" +
  "[success] Total time: 3 s\n";

const _SBT_ERROR_OUTPUT =
  "[info] Compiling 3 Scala sources ...\n" +
  "[error] /home/user/myproject/src/main/scala/App.scala:10:5: not found: value undefinedVar\n" +
  "[error]     val x = undefinedVar\n" +
  "[error]             ^\n" +
  "[error] one error found\n" +
  "[error] (Compile / compileIncremental) Compilation failed\n";

const _SBT_TEST_OUTPUT =
  "[info] Loading project definition from /home/user/myproject/project\n" +
  "[info] Set current project to myproject\n" +
  "[info] Compiling 8 Scala test sources ...\n" +
  "[info] Done compiling.\n" +
  "[info] MySpec:\n" +
  "[info] - test addition\n" +
  "[info] - test subtraction\n" +
  "[info] Run completed in 234 milliseconds.\n" +
  "[info] Total number of tests run: 2\n" +
  "[info] Suites: completed 1, aborted 0\n" +
  "[info] Tests: succeeded 2, failed 0, canceled 0, ignored 0, pending 0\n" +
  "[info] All tests passed.\n" +
  "[success] Total time: 5 s\n";

const _SBT_FAILED_TEST_OUTPUT =
  "[info] Loading project definition from /home/user/myproject/project\n" +
  "[info] Set current project to myproject\n" +
  "[info] Compiling 4 Scala test sources ...\n" +
  "[info] Done compiling.\n" +
  "[info] MySpec:\n" +
  "[info] - test addition\n" +
  "[info] - test subtraction *** FAILED ***\n" +
  "[info]   2 did not equal 3 (MySpec.scala:15)\n" +
  "[info] Tests: succeeded 1, failed 1, canceled 0, ignored 0, pending 0\n" +
  "[info] 1 test failed.\n" +
  "[error] Failed tests:\n" +
  "[error] \tcom.example.MySpec\n" +
  "[error] (Test / test) sbt.TestsFailedException: Tests unsuccessful\n";

describe("TestSbtFilterLoadingNoise", () => {
  // SbtFilter collapses [info] loading/resolution lines.
  const SBT = new SbtFilter();

  it("test_loading_lines_collapsed", () => {
    const out = _apply(SBT, { stdout: _SBT_LOADING_OUTPUT, argv: ["sbt", "compile"] });
    expect(out).not.toContain("[info] Loading global plugins");
    expect(out).not.toContain("[info] Loading settings");
    expect(out).not.toContain("[info] Set current project");
  });

  it("test_compiling_line_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_LOADING_OUTPUT, argv: ["sbt", "compile"] });
    expect(out).toContain("[info] Compiling 12 Scala sources");
  });

  it("test_done_compiling_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_LOADING_OUTPUT, argv: ["sbt", "compile"] });
    expect(out).toContain("[info] Done compiling.");
  });

  it("test_success_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_LOADING_OUTPUT, argv: ["sbt", "compile"] });
    expect(out).toContain("[success] Total time:");
  });

  it("test_loading_collapse_noted", () => {
    const out = _apply(SBT, { stdout: _SBT_LOADING_OUTPUT, argv: ["sbt", "compile"] });
    expect(out).toContain("collapsed");
    expect(out.toLowerCase().includes("loading") || out.toLowerCase().includes("resolution")).toBe(true);
  });

  it("test_savings_on_loading_heavy_output", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`[info] Loading settings for project sub${i} from build.sbt ...`);
    }
    lines.push("[info] Compiling 10 Scala sources ...");
    lines.push("[info] Done compiling.");
    lines.push("[success] Total time: 12 s");
    const output = lines.join("\n");
    const ratio = _savings_ratio(new SbtFilter(), output, { argv: ["sbt", "compile"] });
    expect(
      ratio >= 0.7,
      `Expected >= 70% savings on loading-heavy sbt, got ${(ratio * 100).toFixed(0)}%`,
    ).toBe(true);
  });
});

describe("TestSbtFilterWarnLines", () => {
  // SbtFilter keeps first N [warn] lines per category, collapses extras.
  const SBT = new SbtFilter();

  it("test_first_five_warnings_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_WARN_OUTPUT, argv: ["sbt", "compile"] });
    // The 5 first warnings are unique by 60-char prefix → all kept.
    // (The 6th and 7th have different line text so may vary by category logic.)
    // At minimum the compiling + done lines must survive.
    expect(out).toContain("[info] Compiling 5 Scala sources");
    expect(out).toContain("[info] Done compiling.");
  });

  it("test_warn_lines_present_in_output", () => {
    const out = _apply(SBT, { stdout: _SBT_WARN_OUTPUT, argv: ["sbt", "compile"] });
    // At least some warn lines must survive.
    expect(out).toContain("[warn]");
  });

  it("test_duplicate_warn_collapsed_to_note", () => {
    // When the same warning fires >5 times it must be collapsed.
    // Build output with 10 identical [warn] lines.
    const lines: string[] = ["[info] Compiling 1 Scala sources ..."];
    for (let _i = 0; _i < 10; _i++) {
      lines.push("[warn] /src/Foo.scala:1:1: implicit numeric widening");
    }
    lines.push("[info] Done compiling.");
    lines.push("[success] Total time: 1 s");
    const output = lines.join("\n");
    const out = _apply(SBT, { stdout: output, argv: ["sbt", "compile"] });
    expect(out).toContain("collapsed");
    // Not all 10 warn lines should appear verbatim.
    const verbatim_count = out.split("[warn] /src/Foo.scala:1:1: implicit numeric widening").length - 1;
    expect(
      verbatim_count <= 5,
      `Expected <= 5 verbatim warn lines, got ${verbatim_count}`,
    ).toBe(true);
  });
});

describe("TestSbtFilterErrors", () => {
  // SbtFilter always keeps [error] lines.
  const SBT = new SbtFilter();

  it("test_error_lines_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_ERROR_OUTPUT, exit_code: 1, argv: ["sbt", "compile"] });
    expect(out).toContain("[error] /home/user/myproject/src/main/scala/App.scala:10:5: not found");
    expect(out).toContain("[error] one error found");
  });

  it("test_compilation_line_kept_on_error", () => {
    const out = _apply(SBT, { stdout: _SBT_ERROR_OUTPUT, exit_code: 1, argv: ["sbt", "compile"] });
    expect(out).toContain("[info] Compiling 3 Scala sources");
  });

  it("test_loading_noise_on_error_collapsed", () => {
    // Python str.splitlines() on a "\n"-terminated string drops the trailing
    // empty element; emulate by stripping a single trailing "\n" before split.
    const _err_lines = _SBT_ERROR_OUTPUT.replace(/\n$/, "").split("\n");
    const lines = [
      "[info] Loading project definition from /home/user/myproject/project",
      "[info] Set current project to myproject",
    ].concat(_err_lines);
    const output = lines.join("\n");
    const out = _apply(SBT, { stdout: output, exit_code: 1, argv: ["sbt", "compile"] });
    expect(out).not.toContain("[info] Loading project definition");
    expect(out).toContain("[error] one error found");
  });
});

describe("TestSbtFilterTestOutput", () => {
  // SbtFilter handles sbt test output.
  const SBT = new SbtFilter();

  it("test_test_summary_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_TEST_OUTPUT, argv: ["sbt", "test"] });
    expect(out).toContain("[info] Tests: succeeded 2, failed 0");
    expect(out).toContain("[info] All tests passed.");
  });

  it("test_loading_collapsed_in_test", () => {
    const out = _apply(SBT, { stdout: _SBT_TEST_OUTPUT, argv: ["sbt", "test"] });
    expect(out).not.toContain("[info] Loading project definition");
    expect(out).not.toContain("[info] Set current project");
  });

  it("test_failed_test_block_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_FAILED_TEST_OUTPUT, exit_code: 1, argv: ["sbt", "test"] });
    expect(out).toContain("[error] Failed tests:");
    expect(out).toContain("[error] \tcom.example.MySpec");
  });

  it("test_failed_test_summary_kept", () => {
    const out = _apply(SBT, { stdout: _SBT_FAILED_TEST_OUTPUT, exit_code: 1, argv: ["sbt", "test"] });
    expect(out).toContain("[info] Tests: succeeded 1, failed 1");
  });
});

describe("TestSbtFilterScalaTestVerbose", () => {
  // SbtFilter collapses ScalaTest/Specs2/MUnit verbose passing-test lines.
  const SBT = new SbtFilter();

  it("test_scalatest_passing_lines_collapsed", () => {
    // [info]   - test name (N ms) lines are collapsed to a count.
    const lines = [
      "[info] MySpec:",
      "[info] - test addition (5 ms)",
      "[info] - test subtraction (3 ms)",
      "[info] - test multiplication (4 ms)",
      "[info] Tests: succeeded 3, failed 0, canceled 0, ignored 0, pending 0",
      "[info] All tests passed.",
      "[success] Total time: 2 s",
    ];
    const out = _apply(SBT, { stdout: lines.join("\n"), argv: ["sbt", "test"] });
    // Passing test lines should be collapsed.
    expect(out).not.toContain("[info] - test addition");
    expect(out.includes("collapsed") && out.includes("passing-test")).toBe(true);
    // Summary must be kept.
    expect(out).toContain("All tests passed");
  });

  it("test_scalatest_failed_line_kept", () => {
    // [info]   - test name *** FAILED *** lines are never collapsed.
    const lines = [
      "[info] - passing test (2 ms)",
      "[info] - failing test *** FAILED ***",
      "[info]   expected 1 but was 2",
      "[info] Tests: succeeded 1, failed 1, canceled 0, ignored 0, pending 0",
    ];
    const out = _apply(SBT, { stdout: lines.join("\n"), exit_code: 1, argv: ["sbt", "test"] });
    // The failed line must survive.
    expect(out).toContain("*** FAILED ***");
    // The passing line must be collapsed.
    expect(out).not.toContain("[info] - passing test");
  });

  it("test_specs2_plus_style_passing_line_collapsed", () => {
    // [info]   + test name (Specs2 style) passing lines are collapsed.
    const lines = [
      "[info] + feature works correctly",
      "[info] + another feature works",
      "[info] Tests: succeeded 2, failed 0, canceled 0, ignored 0, pending 0",
      "[success] Total time: 1 s",
    ];
    const out = _apply(SBT, { stdout: lines.join("\n"), argv: ["sbt", "test"] });
    expect(out).not.toContain("[info] + feature works correctly");
    expect(out.includes("collapsed") && out.includes("passing-test")).toBe(true);
  });

  it("test_munit_checkmark_style_passing_line_collapsed", () => {
    // [info]   ✓ test name (MUnit style) passing lines are collapsed.
    const lines = [
      "[info] ✓ test one (45 ms)",
      "[info] ✓ test two (12 ms)",
      "[info] Passed: Total 2, Failed 0, Errors 0, Passed 2",
    ];
    const out = _apply(SBT, { stdout: lines.join("\n"), argv: ["sbt", "test"] });
    expect(out).not.toContain("[info] ✓ test one");
    expect(out.includes("collapsed") && out.includes("passing-test")).toBe(true);
  });
});
