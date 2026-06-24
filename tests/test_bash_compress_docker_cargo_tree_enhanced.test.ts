/**
 * Enhanced coverage tests for DockerFilter, CargoFilter, TreeFilter,
 * BinaryInspectFilter (+ FileTypeFilter batch truncation).
 *
 * 1:1 port of tests/test_bash_compress_docker_cargo_tree_enhanced.py. Each
 * Python test class maps to a vitest `describe()` of the same name; each
 * `def test_*` maps to an `it()` with the SAME name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *   - `from token_goat import bash_compress as bc`
 *       -> import the barrel "../src/token_goat/bash_compress.js" as `bc`.
 *   - `from filter_test_helpers import apply_filter, savings_ratio`
 *       -> local `apply_filter` / `savings_ratio` helpers reproducing the
 *         Python shims: apply_filter returns `filter_.apply(...).text`;
 *         savings_ratio returns `filter_.apply(...).percent_saved / 100.0`.
 *         When argv is omitted Python uses `[filter_.name]`; the local helpers
 *         do the same.
 *   - The module-level `_docker` / `_cargo` helpers map directly onto the
 *     Python module helpers (same default argv).
 *
 * Byte-exactness: every assertion here is a substring / count / equality check
 * on the returned text (pure-ASCII fixtures), so the TS `.includes` / `.toBe`
 * checks are the faithful twins of the Python `in` / `not in` / `==` checks.
 *
 * Deferral: TreeFilter, BinaryInspectFilter, and FileTypeFilter are NOT yet
 * ported (no TS module; the barrel does not export them). Python instantiates
 * `_TREE = bc.TreeFilter()`, `_BIN = bc.BinaryInspectFilter()`,
 * `_FILE = bc.FileTypeFilter()` at module scope, but in TS that would crash the
 * import, so those instances are created lazily inside `it.skip`-ed tests that
 * never run. Every Tree / BinaryInspect / FileType test is therefore `it.skip`-ed
 * with a "// PORT: deferred" marker and counted in tests_skipped. The Docker and
 * Cargo classes (DockerFilter + CargoFilter both ported) are fully exercised.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Helpers (port of filter_test_helpers.apply_filter / savings_ratio)
// ---------------------------------------------------------------------------

function apply_filter(
  filter_: Filter,
  opts: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    argv?: string[] | null;
  } = {},
): string {
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  const exit_code = opts.exit_code ?? 0;
  const argv = opts.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

function savings_ratio(
  filter_: Filter,
  opts: { stdout: string; stderr?: string; argv?: string[] | null },
): number {
  const stderr = opts.stderr ?? "";
  const argv = opts.argv ?? [filter_.name];
  return filter_.apply(opts.stdout, stderr, 0, argv).percent_saved / 100.0;
}

const _DOCKER = new bc.DockerFilter();
const _CARGO = new bc.CargoFilter();

function _docker(
  opts: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] | null } = {},
): string {
  return apply_filter(_DOCKER, {
    stdout: opts.stdout ?? "",
    stderr: opts.stderr ?? "",
    exit_code: opts.exit_code ?? 0,
    argv: opts.argv ?? ["docker", "build", "."],
  });
}

function _cargo(
  opts: { stdout?: string; stderr?: string; subcommand?: string; exit_code?: number } = {},
): string {
  return apply_filter(_CARGO, {
    stdout: opts.stdout ?? "",
    stderr: opts.stderr ?? "",
    exit_code: opts.exit_code ?? 0,
    argv: ["cargo", opts.subcommand ?? "build"],
  });
}

// ---------------------------------------------------------------------------
// Deferred-filter helpers (TreeFilter / BinaryInspectFilter / FileTypeFilter).
// Instances are created lazily so the module loads even though the barrel does
// not export these classes yet; every consumer is inside an it.skip below.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _bcAny = bc as any;

function _tree(stdout: string, argv: string[] | null = null): string {
  // PORT: deferred — TreeFilter not yet ported; only runs in skipped tests.
  return apply_filter(new _bcAny.TreeFilter() as Filter, {
    stdout,
    argv: argv ?? ["tree"],
  });
}

function _bin(stdout: string, argv: string[] | null = null): string {
  // PORT: deferred — BinaryInspectFilter not yet ported; only runs in skipped tests.
  return apply_filter(new _bcAny.BinaryInspectFilter() as Filter, {
    stdout,
    argv: argv ?? ["xxd"],
  });
}

function _file(stdout: string): string {
  // PORT: deferred — FileTypeFilter not yet ported; only runs in skipped tests.
  return apply_filter(new _bcAny.FileTypeFilter() as Filter, {
    stdout,
    argv: ["file"],
  });
}

function _make_xxd(magic_hex: string, n_extra = 10): string {
  // Build a minimal xxd-format dump; first line has the magic bytes.
  const padded = (magic_hex + "00".repeat(16)).slice(0, 32);
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(padded.slice(i, i + 4));
  }
  const first = `00000000: ${groups.join(" ")}  ................`;
  const rest: string[] = [];
  for (let i = 0; i < n_extra; i++) {
    const offset = ((i + 1) * 16).toString(16).padStart(8, "0");
    rest.push(`${offset}: ${"0000 ".repeat(7) + "0000"}  ................`);
  }
  return [first, ...rest].join("\n") + "\n";
}

function _make_tree(
  top_dirs: number,
  subs: number,
  files_each: number,
  opts: { summary?: boolean } = {},
): string {
  const summary = opts.summary ?? true;
  // Produce a synthetic tree output matching the real _make_tree helper.
  const lines: string[] = ["."];
  for (let t = 0; t < top_dirs; t++) {
    const last_top = t === top_dirs - 1;
    const tc = last_top ? "└── " : "├── ";
    const tp = last_top ? "    " : "│   ";
    lines.push(`${tc}topdir${t}/`);
    for (let s = 0; s < subs; s++) {
      const last_sub = s === subs - 1;
      const sc = last_sub ? "└── " : "├── ";
      const sp = last_sub ? "    " : "│   ";
      lines.push(`${tp}${sc}subdir${s}/`);
      for (let f = 0; f < files_each; f++) {
        const last_f = f === files_each - 1;
        const fc = last_f ? "└── " : "├── ";
        lines.push(`${tp}${sp}${fc}file${f}.txt`);
      }
    }
  }
  const total_dirs = top_dirs * (1 + subs);
  const total_files = top_dirs * subs * files_each;
  if (summary) {
    lines.push(`\n${total_dirs} directories, ${total_files} files`);
  }
  return lines.join("\n");
}

// ===========================================================================
// DockerFilter — BuildKit format
// ===========================================================================

describe("TestDockerBuildKit", () => {
  it("test_buildkit_sha256_digest_dropped", () => {
    // Lines matching "#N sha256:..." are digest noise and must be suppressed.
    const inp =
      "#1 sha256:abc123def456abc123def456abc123def456\n#2 [internal] load build definition\n#2 DONE 0.1s";
    const out = _docker({ stderr: inp });
    expect(out).not.toContain("sha256:");
  });

  it("test_buildkit_transfer_progress_dropped", () => {
    // "#N 12.3MB / 50.0MB" transfer lines are noise.
    const inp = "#3 [1/2] FROM ubuntu\n#3 12.3MB / 50.0MB 0.5s\n#3 DONE 1.2s";
    const out = _docker({ stderr: inp });
    expect(out).not.toContain("12.3MB");
  });

  it("test_buildkit_cached_lines_dropped", () => {
    // "#N CACHED" raw step lines are suppressed; only the count sentinel remains.
    const inp = [
      "#1 [internal] load build definition",
      "#1 CACHED",
      "#2 [internal] load .dockerignore",
      "#2 CACHED",
      "#3 [1/1] FROM ubuntu",
      "#3 DONE 0.1s",
    ].join("\n");
    const out = _docker({ stderr: inp });
    // Raw "#N CACHED" lines should not appear; count appears only in the sentinel.
    for (const line of out.split("\n")) {
      if (line.startsWith("[token-goat:")) {
        continue;
      }
      expect(line, `Raw CACHED line leaked: ${JSON.stringify(line)}`).not.toContain("CACHED");
    }
  });

  it("test_buildkit_cached_count_in_summary", () => {
    // Dropped CACHED count appears in the [token-goat: dropped ... CACHED lines] summary.
    const inp = [
      "#1 CACHED",
      "#2 CACHED",
      "#3 CACHED",
      "#4 [1/1] RUN echo done",
      "#4 DONE 0.5s",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).toContain("CACHED"); // appears in the summary sentinel, not as raw lines
  });

  it("test_buildkit_error_block_kept", () => {
    // Lines containing "ERROR" keyword in body are kept; final ERROR summary is kept.
    const inp = [
      "#5 [2/3] RUN apt-get install nosuchpkg",
      "#5 0.123 ERROR: process exited with code 100",
      "#5 ERROR: process failed with exit code 100",
      "ERROR: failed to solve: process failed",
    ].join("\n");
    const out = _docker({ stderr: inp });
    // The ERROR body line and the final ERROR line must both survive.
    expect(out).toContain("ERROR: process exited with code 100");
    expect(out).toContain("ERROR: failed to solve");
  });

  it("test_buildkit_summary_sentinel_present_when_noise_dropped", () => {
    // When any lines are dropped, a [token-goat: dropped ...] sentinel must appear.
    const inp = [
      "#1 sha256:deadbeef1234",
      "#2 [internal] load build definition",
      "#2 DONE 0.1s",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).toContain("[token-goat: dropped");
  });

  it("test_empty_docker_output", () => {
    const out = _docker();
    expect(out).toBe("");
  });

  it("test_buildkit_body_lines_dropped_on_success", () => {
    // Step body lines (#N <timestamp> <content>) dropped when no ERROR.
    const inp = ["#5 [2/3] RUN echo hello", "#5 0.123 hello", "#5 DONE 0.5s"].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).not.toContain("#5 0.123 hello");
  });
});

// ===========================================================================
// DockerFilter — docker push / pull noise
// ===========================================================================

describe("TestDockerPushPullNoise", () => {
  it("test_layer_already_exists_dropped", () => {
    const inp = [
      "abc123def456: Layer already exists",
      "def456abc123: Layer already exists",
      "latest: digest: sha256:abc123 size: 1234",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).not.toContain("Layer already exists");
  });

  it("test_mounted_from_dropped", () => {
    const inp =
      "abc123def456: Mounted from library/ubuntu\nlatest: digest: sha256:abc123 size: 1234";
    const out = _docker({ stderr: inp });
    expect(out).not.toContain("Mounted from");
  });

  it("test_pull_layer_status_dropped", () => {
    // Per-layer pull status lines (Pull complete, Waiting, etc.) are noise.
    const inp = [
      "abc123def456: Pull complete",
      "def456abc123: Verifying Checksum",
      "fedcba987654: Download complete",
      "aabbccddeeff: Already exists",
      "Status: Downloaded newer image for ubuntu:latest",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).not.toContain("Pull complete");
    expect(out).not.toContain("Verifying Checksum");
    // Status line is signal — must be kept.
    expect(out).toContain("Status: Downloaded newer image");
  });

  it("test_push_noise_count_in_sentinel", () => {
    // push-layer count appears in the dropped sentinel.
    const inp = [
      "abc123def456: Layer already exists",
      "def456abc123: Layer already exists",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).toContain("push-layer");
  });
});

// ===========================================================================
// DockerFilter — dispatch: podman, buildah, nerdctl
// ===========================================================================

describe("TestDockerDispatch", () => {
  it.each(["docker", "buildah", "podman", "nerdctl"])(
    "test_dispatch_to_docker_filter[%s]",
    (binary) => {
      const flt = bc.select_filter([binary, "build", "."]);
      expect(flt !== null && flt.name === "docker").toBe(true);
      expect(flt!.matches([binary, "build", "."])).toBe(true);
    },
  );
});

// ===========================================================================
// DockerFilter — old-format: building/cached preamble
// ===========================================================================

describe("TestDockerOldFormatPreamble", () => {
  it("test_old_format_cached_preamble_inserted", () => {
    // When old-format output has cached steps, a [building N layers, M cached] preamble is added.
    const inp = [
      "Step 1/3 : FROM ubuntu",
      " ---> Using cache",
      "Step 2/3 : RUN apt-get update",
      " ---> Using cache",
      "Step 3/3 : CMD bash",
      " ---> abc123def456",
      "Successfully built abc123def456",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).toContain("building");
    expect(out).toContain("cached");
  });

  it("test_old_format_no_cached_no_preamble", () => {
    // When no steps are cached, the [building N layers, M cached] preamble is absent.
    const inp = [
      "Step 1/2 : FROM ubuntu",
      " ---> abc123",
      "Step 2/2 : CMD bash",
      " ---> def456",
      "Successfully built def456",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).not.toContain("building");
    expect(out).not.toContain("0 cached");
  });

  it("test_old_format_error_step_header_kept", () => {
    // When a step produces an error, its header line must be kept.
    const inp = [
      "Step 1/2 : RUN false",
      "error: command returned non-zero exit status 1",
      "Step 2/2 : CMD bash",
      "Successfully built abc123",
    ].join("\n");
    const out = _docker({ stderr: inp });
    expect(out).toContain("Step 1/2");
  });
});

// ===========================================================================
// CargoFilter — build subcommand
// ===========================================================================

describe("TestCargoBuild", () => {
  it("test_two_compiling_lines_kept_verbatim", () => {
    // Fewer than 3 Compiling lines pass through without a sentinel.
    const inp = [
      "   Compiling foo v0.1.0 (/tmp/foo)",
      "   Compiling bar v0.1.0 (/tmp/bar)",
      "    Finished dev [unoptimized] target(s) in 1.0s",
    ].join("\n");
    const out = _cargo({ stderr: inp });
    expect(out).toContain("Compiling foo");
    expect(out).toContain("Compiling bar");
    expect(out).not.toContain("[compiling");
  });

  it("test_three_compiling_lines_collapsed_to_sentinel", () => {
    // Exactly 3 Compiling lines trigger the sentinel.
    const inp = [
      "   Compiling a v0.1.0 (/tmp)",
      "   Compiling b v0.1.0 (/tmp)",
      "   Compiling c v0.1.0 (/tmp)",
      "    Finished dev [unoptimized] target(s) in 2.0s",
    ].join("\n");
    const out = _cargo({ stderr: inp });
    expect(out).toContain("[compiling 3 crates");
    expect(out).not.toContain("Compiling a");
  });

  it("test_progress_lines_dropped_with_count", () => {
    // Downloading/Fetching/Updating lines are dropped; count in sentinel.
    const inp = [
      "  Downloading crates ...",
      "  Fetching registry",
      "  Updating crates.io index",
      "   Compiling foo v0.1.0 (/tmp)",
      "   Compiling bar v0.1.0 (/tmp)",
      "   Compiling baz v0.1.0 (/tmp)",
      "    Finished dev [unoptimized] target(s) in 5.0s",
    ].join("\n");
    const out = _cargo({ stderr: inp });
    expect(out).toContain("dropped");
    expect(out).toContain("cargo progress lines");
  });

  it("test_error_line_always_kept", () => {
    // error[E0001] lines are never suppressed even with many Compiling lines.
    const lines = Array.from(
      { length: 8 },
      (_, i) => `   Compiling crate_${i} v0.1.${i} (/tmp)`,
    );
    lines.push("error[E0308]: mismatched types");
    const out = _cargo({ stderr: lines.join("\n"), exit_code: 1 });
    expect(out).toContain("error[E0308]: mismatched types");
  });

  it("test_warning_line_always_kept", () => {
    // warning: lines are preserved regardless of how many Compiling lines there are.
    const lines = Array.from(
      { length: 5 },
      (_, i) => `   Compiling c${i} v0.1.0 (/tmp)`,
    );
    lines.push("warning: unused variable `x`");
    const out = _cargo({ stderr: lines.join("\n") });
    expect(out).toContain("warning: unused variable `x`");
  });

  it("test_empty_build_output", () => {
    const out = _cargo();
    expect(out).toBe("");
  });

  it("test_check_subcommand_routed_through_build_path", () => {
    // cargo check uses the same build path; Compiling sentinel still fires at >=3.
    const lines = Array.from(
      { length: 4 },
      (_, i) => `   Compiling c${i} v0.1.0 (/tmp)`,
    );
    lines.push("    Finished check [unoptimized] target(s) in 1.0s");
    const out = _cargo({ stderr: lines.join("\n"), subcommand: "check" });
    expect(out).toContain("[compiling 4 crates");
  });
});

// ===========================================================================
// CargoFilter — test subcommand
// ===========================================================================

describe("TestCargoTest", () => {
  it("test_passing_tests_suppressed", () => {
    const stdout = [
      "running 3 tests",
      "test a::b ... ok",
      "test a::c ... ok",
      "test a::d ... ok",
      "",
      "test result: ok. 3 passed; 0 failed; 0 ignored",
    ].join("\n");
    const out = _cargo({ stdout, subcommand: "test" });
    expect(out).not.toContain("test a::b ... ok");
    expect(out).toContain("test result: ok. 3 passed");
  });

  it("test_failing_test_lines_kept", () => {
    const stdout = [
      "running 2 tests",
      "test passes ... ok",
      "test fails ... FAILED",
      "",
      "failures:",
      "    fails",
      "",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored",
    ].join("\n");
    const out = _cargo({ stdout, subcommand: "test", exit_code: 101 });
    expect(out).toContain("test fails ... FAILED");
    expect(out).toContain("failures:");
  });

  it("test_pass_count_sentinel_injected", () => {
    // When tests pass, a "[N tests passed]" sentinel replaces the ok lines.
    const stdout = [
      "running 5 tests",
      "test t1 ... ok",
      "test t2 ... ok",
      "test t3 ... ok",
      "test t4 ... ok",
      "test t5 ... ok",
      "",
      "test result: ok. 5 passed; 0 failed",
    ].join("\n");
    const out = _cargo({ stdout, subcommand: "test" });
    expect(out).toContain("5 tests passed");
  });

  it("test_build_and_test_merged_with_separator", () => {
    // When stderr has compiler output and stdout has test output, they are joined with ---.
    const stderr = Array.from(
      { length: 4 },
      (_, i) => `   Compiling c${i} v0.1.0 (/tmp)`,
    ).join("\n");
    const stdout = [
      "running 1 tests",
      "test it_works ... ok",
      "",
      "test result: ok. 1 passed; 0 failed",
    ].join("\n");
    const out = _cargo({ stdout, stderr, subcommand: "test" });
    expect(out).toContain("---");
    expect(out).toContain("test result");
  });

  it("test_empty_test_output", () => {
    const out = _cargo({ subcommand: "test" });
    expect(out).toBe("");
  });

  it("test_multiple_running_sections_each_get_sentinel", () => {
    // Two "Running" headers -> two separate pass sentinels.
    const stdout = [
      "Running unittests src/lib.rs (target/debug/deps/lib-abc)",
      "running 2 tests",
      "test a ... ok",
      "test b ... ok",
      "",
      "test result: ok. 2 passed; 0 failed",
      "Running tests/integration.rs (target/debug/deps/integration-def)",
      "running 1 tests",
      "test c ... ok",
      "",
      "test result: ok. 1 passed; 0 failed",
    ].join("\n");
    const out = _cargo({ stdout, subcommand: "test" });
    // Both sections should inject sentinels; test names should be suppressed.
    expect(out).not.toContain("test a ... ok");
    expect(out).not.toContain("test c ... ok");
  });
});

// ===========================================================================
// CargoFilter — clippy subcommand
// ===========================================================================

describe("TestCargoClippy", () => {
  it("test_clippy_checking_lines_dropped", () => {
    // "Checking foo v0.1.0" lines are noise for clippy and are dropped.
    const inp = [
      "    Checking foo v0.1.0 (/tmp/foo)",
      "    Checking bar v0.1.0 (/tmp/bar)",
      "    Checking baz v0.1.0 (/tmp/baz)",
      "warning: unused import: `std::collections::HashMap`",
    ].join("\n");
    const out = _cargo({ stderr: inp, subcommand: "clippy" });
    expect(out).not.toContain("Checking foo");
    expect(out).not.toContain("Checking bar");
    expect(out).toContain("dropped");
  });

  it("test_clippy_few_compiling_kept_verbatim", () => {
    // <=4 Compiling lines pass through for clippy (not sentinel-ised).
    const inp = [
      "   Compiling proc-macro v0.1.0 (/tmp)",
      "   Compiling dep v0.1.0 (/tmp)",
      "warning: something",
    ].join("\n");
    const out = _cargo({ stderr: inp, subcommand: "clippy" });
    expect(out).toContain("Compiling proc-macro");
    expect(out).toContain("Compiling dep");
  });

  it("test_clippy_many_compiling_collapsed_with_head_tail", () => {
    // >4 Compiling lines: first 2 + last 2 kept, middle collapsed.
    const lines = Array.from(
      { length: 8 },
      (_, i) => `   Compiling crate${i} v0.1.0 (/tmp)`,
    );
    lines.push("warning: lint triggered");
    const inp = lines.join("\n");
    const out = _cargo({ stderr: inp, subcommand: "clippy" });
    expect(out).toContain("Compiling crate0");
    expect(out).toContain("Compiling crate7");
    expect(out).toContain("collapsed");
    expect(out).not.toContain("Compiling crate3");
  });

  it("test_clippy_error_always_kept", () => {
    const inp = [
      "    Checking foo v0.1.0 (/tmp)",
      "error[E0308]: mismatched types",
      "  --> src/main.rs:5:14",
    ].join("\n");
    const out = _cargo({ stderr: inp, subcommand: "clippy", exit_code: 1 });
    expect(out).toContain("error[E0308]");
  });

  it("test_clippy_empty_output", () => {
    const out = _cargo({ subcommand: "clippy" });
    expect(out).toBe("");
  });
});

// ===========================================================================
// CargoFilter — bench subcommand
// ===========================================================================

describe("TestCargoBench", () => {
  it("test_bench_results_kept_verbatim", () => {
    const stdout = [
      "running 2 tests",
      "test bench_foo ... bench:       1,234 ns/iter (+/- 56)",
      "test bench_bar ... bench:       5,678 ns/iter (+/- 89)",
      "",
      "test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured",
    ].join("\n");
    const out = _cargo({ stdout, subcommand: "bench" });
    expect(out).toContain("bench:       1,234 ns/iter");
    expect(out).toContain("bench:       5,678 ns/iter");
    expect(out).toContain("test result: ok.");
  });

  it("test_bench_compiler_noise_stripped_from_stderr", () => {
    // Compiler progress on stderr is collapsed; bench results on stdout intact.
    const stderr = Array.from(
      { length: 5 },
      (_, i) => `   Compiling c${i} v0.1.0 (/tmp)`,
    ).join("\n");
    const stdout = [
      "running 1 tests",
      "test bench_x ... bench:         100 ns/iter (+/- 5)",
      "",
      "test result: ok. 0 passed; 0 failed; 0 ignored; 1 measured",
    ].join("\n");
    const out = _cargo({ stdout, stderr, subcommand: "bench" });
    expect(out).toContain("bench:         100 ns/iter");
    expect(out).toContain("[compiling 5 crates");
  });

  it("test_bench_empty_output", () => {
    const out = _cargo({ subcommand: "bench" });
    expect(out).toBe("");
  });
});

// ===========================================================================
// TreeFilter — passthrough boundary
// ===========================================================================

describe("TestTreePassthrough", () => {
  it.skip("test_31_lines_triggers_compression", () => {
    // PORT: deferred — TreeFilter not yet ported.
    // A tree over 30 lines triggers compression.
    // top_dirs=2, subs=3, files_each=5 -> 1 + 2 + 6 + 30 + 1(summary) = 40 lines
    const out_text = _make_tree(2, 3, 5);
    const lines = out_text.split("\n");
    expect(lines.length, `Expected >30 lines, got ${lines.length}`).toBeGreaterThan(30);
    const result = _tree(out_text);
    // Depth-3 files are collapsed — file names must not appear verbatim.
    expect(result).not.toContain("file0.txt");
    expect(result).toContain("items]");
  });

  it.skip("test_30_lines_passes_through", () => {
    // PORT: deferred — TreeFilter not yet ported.
    // Exactly 30 lines -> no compression.
    // Build a tree that produces exactly 30 connector lines.
    const lines = ["."];
    for (let i = 0; i < 14; i++) {
      const conn = i === 13 ? "└── " : "├── ";
      lines.push(`${conn}item${i}/`);
    }
    for (let j = 0; j < 14; j++) {
      const conn = j === 13 ? "└── " : "├── ";
      lines.push(`    ${conn}sub${j}.txt`);
    }
    // 1 root + 14 top + 14 sub = 29; add summary to reach 30.
    lines.push("\n14 directories, 14 files");
    const text = lines.join("\n");
    const result = _tree(text);
    // No [N items] markers should appear.
    expect(result).not.toContain("[");
    expect(result).not.toContain("items]");
  });

  it.skip("test_empty_tree_returns_empty", () => {
    // PORT: deferred — TreeFilter not yet ported.
    const result = _tree("");
    expect(result).toBe("");
  });
});

// ===========================================================================
// TreeFilter — detect heuristic
// ===========================================================================

describe("TestTreeDetect", () => {
  it.skip("test_detect_requires_box_drawing_chars", () => {
    // PORT: deferred — TreeFilter not yet ported.
    // Output without box-drawing connectors should not be compressed even if long.
    const plain: string[] = [];
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 5; j++) {
        plain.push(`dir${i}/subdir/file${j}.txt`);
      }
    }
    const f = new _bcAny.TreeFilter();
    const lines = plain.join("\n").split("\n");
    expect(f.detect(lines)).toBeFalsy();
  });

  it.skip("test_detect_true_for_real_tree_output", () => {
    // PORT: deferred — TreeFilter not yet ported.
    const text = _make_tree(2, 2, 3);
    const f = new _bcAny.TreeFilter();
    const lines = text.split("\n");
    expect(f.detect(lines)).toBeTruthy();
  });
});

// ===========================================================================
// TreeFilter — compression specifics
// ===========================================================================

describe("TestTreeCompression", () => {
  it.skip("test_depth3_items_collapsed_per_parent", () => {
    // PORT: deferred — TreeFilter not yet ported.
    // Each depth-2 parent gets its own [N items] marker.
    // top_dirs=2, subs=4, files_each=5 -> 1+2+8+40+1 = 52 lines (>30 threshold)
    const text = _make_tree(2, 4, 5);
    const result = _tree(text);
    // 8 total subdirs x 5 depth-3 files each -> 8 markers of [5 items].
    expect(result).toContain("[5 items]");
    expect(result.split("[5 items]").length - 1).toBe(8);
  });

  it.skip("test_depth1_and_depth2_entries_kept", () => {
    // PORT: deferred — TreeFilter not yet ported.
    const text = _make_tree(2, 2, 4);
    const result = _tree(text);
    expect(result).toContain("topdir0/");
    expect(result).toContain("subdir0/");
  });

  it.skip("test_summary_line_always_preserved", () => {
    // PORT: deferred — TreeFilter not yet ported.
    const text = _make_tree(2, 2, 6);
    const result = _tree(text);
    expect(result).toContain("directories,");
    expect(result).toContain("files");
  });

  it.skip("test_no_summary_line_still_compresses", () => {
    // PORT: deferred — TreeFilter not yet ported.
    const text = _make_tree(2, 2, 6, { summary: false });
    const result = _tree(text);
    expect(result).toContain("items]");
  });

  it.skip("test_savings_ratio_positive_for_deep_tree", () => {
    // PORT: deferred — TreeFilter not yet ported.
    // Deep tree should achieve meaningful savings (observed ~65% for top=3,subs=3,files=5).
    const text = _make_tree(3, 3, 5);
    const ratio = savings_ratio(new _bcAny.TreeFilter() as Filter, { stdout: text });
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });

  it.skip("test_only_depth3_items_are_removed", () => {
    // PORT: deferred — TreeFilter not yet ported.
    // Depth-1 and depth-2 items must never appear in an [N items] marker.
    const text = _make_tree(2, 2, 4);
    const result = _tree(text);
    for (let t = 0; t < 2; t++) {
      expect(result).toContain(`topdir${t}/`);
    }
    for (let s = 0; s < 2; s++) {
      expect(result).toContain(`subdir${s}/`);
    }
  });
});

// ===========================================================================
// BinaryInspectFilter — additional magic types
// ===========================================================================

describe("TestBinaryInspectMagic", () => {
  it.skip("test_pdf_magic_detected", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // PDF magic bytes: 25 50 44 46 = "%PDF"
    const dump = _make_xxd("255044462d312e350a0a", 15);
    const result = _bin(dump);
    expect(result).toContain("PDF");
  });

  it.skip("test_7z_magic_detected", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // 7z magic: 37 7a bc af 27 1c — detected as "7-zip archive"
    const dump = _make_xxd("377abcaf271c000000000000", 15);
    const result = _bin(dump);
    expect(result.toLowerCase()).toContain("7-zip");
  });

  it.skip("test_summary_line_contains_total_line_count", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // The [token-goat: hex dump of N lines ...] sentinel must include the line count.
    const n_extra = 20;
    const dump = _make_xxd("89504e470d0a1a0a", n_extra);
    const total = 1 + n_extra;
    const result = _bin(dump);
    expect(result).toContain(`hex dump of ${total} lines`);
  });

  it.skip("test_magic_bytes_appear_in_summary", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // The detected magic hex prefix must appear in the summary line.
    const dump = _make_xxd("ffd8ffe000104a464946", 10);
    const result = _bin(dump);
    expect(result).toContain("ffd8ff");
  });

  it.skip("test_passthrough_at_boundary", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // Exactly 4 lines (the passthrough threshold) -> no compression.
    const dump = [
      "00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  ....IHDR",
      "00000010: 0000 0001 0000 0001 0806 0000 001f 15c4  ................",
      "00000020: 8900 0000 0a49 4441 5478 9c62 0000 0002  .....IDATx.b....",
      "00000030: 0001 e221 bc33 0000 0000 4945 4e44 ae42  ...!.3....IEND.B",
    ].join("\n");
    const result = _bin(dump);
    expect(result).not.toContain("[token-goat:");
  });

  it.skip("test_5_lines_triggers_compression", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // 5 lines exceeds the 4-line threshold -> summary inserted.
    const dump = _make_xxd("89504e470d0a1a0a", 4); // 1 + 4 = 5 lines
    const result = _bin(dump);
    expect(result).toContain("[token-goat:");
  });

  it.skip("test_first_two_hex_lines_always_present", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    const dump = _make_xxd("7f454c46020101000000000000000000", 12);
    const result = _bin(dump);
    const input_lines = dump.split("\n");
    expect(result).toContain(input_lines[0]!);
    expect(result).toContain(input_lines[1]!);
  });

  it.skip("test_unknown_binary_shows_unknown_description", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // Non-matching magic -> "unknown binary type" in summary.
    const dump = _make_xxd("cafebabe000000000000000000000000", 10);
    const result = _bin(dump);
    // May or may not match a known type; but sentinel must always appear.
    expect(result).toContain("[token-goat:");
  });

  it.skip("test_gzip_magic_in_summary", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // gzip magic: 1f 8b
    const dump = _make_xxd("1f8b080800000000000003", 10);
    const result = _bin(dump);
    expect(result).toContain("gzip");
  });

  it.skip("test_empty_input", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    const result = _bin("");
    expect(result).toBe("");
  });
});

// ===========================================================================
// BinaryInspectFilter — savings ratio
// ===========================================================================

describe("TestBinaryInspectSavings", () => {
  it.skip("test_savings_positive_for_large_dump", () => {
    // PORT: deferred — BinaryInspectFilter not yet ported.
    // BinaryInspectFilter with a 51-line dump should achieve meaningful savings (observed ~94%).
    const dump = _make_xxd("89504e470d0a1a0a", 50);
    const ratio = savings_ratio(new _bcAny.BinaryInspectFilter() as Filter, {
      stdout: dump,
      argv: ["xxd"],
    });
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });
});

// ===========================================================================
// FileTypeFilter — batch truncation specifics
// ===========================================================================

describe("TestFileTypeFilter", () => {
  it.skip("test_exactly_20_lines_passes_through", () => {
    // PORT: deferred — FileTypeFilter not yet ported.
    // 20 lines <= batch limit -> no truncation.
    const lines = Array.from(
      { length: 20 },
      (_, i) => `file_${String(i).padStart(2, "0")}.txt: ASCII text\n`,
    );
    const result = _file(lines.join(""));
    expect(result).not.toContain("truncated");
    expect(result).toContain("file_19.txt");
  });

  it.skip("test_21_lines_triggers_truncation", () => {
    // PORT: deferred — FileTypeFilter not yet ported.
    // 21 lines exceeds the 20-line limit; 1 entry truncated.
    const lines = Array.from(
      { length: 21 },
      (_, i) => `file_${String(i).padStart(2, "0")}.txt: ASCII text`,
    );
    const result = _file(lines.join("\n"));
    expect(result).toContain("1 more file entries truncated");
    expect(result).not.toContain("file_20.txt");
  });

  it.skip("test_truncation_count_is_accurate", () => {
    // PORT: deferred — FileTypeFilter not yet ported.
    // 30 lines -> 10 entries truncated.
    const lines = Array.from(
      { length: 30 },
      (_, i) => `file_${String(i).padStart(2, "0")}.bin: data`,
    );
    const result = _file(lines.join("\n"));
    expect(result).toContain("10 more file entries truncated");
  });

  it.skip("test_first_20_entries_present_after_truncation", () => {
    // PORT: deferred — FileTypeFilter not yet ported.
    const lines = Array.from(
      { length: 25 },
      (_, i) => `path_${String(i).padStart(3, "0")}.so: ELF shared object`,
    );
    const result = _file(lines.join("\n"));
    expect(result).toContain("path_000.so");
    expect(result).toContain("path_019.so");
    expect(result).not.toContain("path_020.so");
  });

  it.skip("test_empty_file_output", () => {
    // PORT: deferred — FileTypeFilter not yet ported.
    const result = _file("");
    expect(result).toBe("");
  });
});
