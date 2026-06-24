/**
 * Tests for docker build output compression (Iter 38).
 *
 * 1:1 port of tests/test_docker_build_compress.py. The helpers
 * (_is_docker_build_cmd, _has_docker_build_output, compress_docker_build) live
 * in bash_compress/post_bash_helpers.ts and are re-exported from the
 * bash_compress barrel.
 *
 * Test-seam mapping (Python -> TS):
 *  - Python's `setup_method` (computing self.compressed / self.removed / self.lines
 *    shared across the class's methods) -> a `beforeEach` inside the describe()
 *    block populating module-scoped `let` bindings, mirroring per-test state.
 *  - The "post_bash integration" class never actually calls post_bash; it builds
 *    the header string locally and asserts substrings, so it ports verbatim with
 *    no payload machinery.
 *  - .splitlines() -> a local splitlines() helper matching Python semantics (a
 *    single trailing newline does not yield a trailing empty element).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  _has_docker_build_output,
  _is_docker_build_cmd,
  compress_docker_build,
} from "../src/token_goat/bash_compress.js";

/** Port of str.splitlines() for the line subset used here (\n only). */
function splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

// ---------------------------------------------------------------------------
// _is_docker_build_cmd
// ---------------------------------------------------------------------------

describe("TestIsDockerBuildCmd", () => {
  it("test_docker_build_dot", () => {
    expect(_is_docker_build_cmd(["docker", "build", "."])).toBe(true);
  });

  it("test_docker_build_with_tag", () => {
    expect(_is_docker_build_cmd(["docker", "build", "-t", "myapp:latest", "."])).toBe(true);
  });

  it("test_docker_buildx_build", () => {
    expect(_is_docker_build_cmd(["docker", "buildx", "build", "."])).toBe(true);
  });

  it("test_docker_compose_build", () => {
    expect(_is_docker_build_cmd(["docker-compose", "build"])).toBe(true);
  });

  it("test_docker_compose_build_service", () => {
    expect(_is_docker_build_cmd(["docker-compose", "build", "web"])).toBe(true);
  });

  it("test_docker_run_false", () => {
    expect(_is_docker_build_cmd(["docker", "run", "myimage"])).toBe(false);
  });

  it("test_docker_pull_false", () => {
    expect(_is_docker_build_cmd(["docker", "pull", "python:3.11"])).toBe(false);
  });

  it("test_docker_ps_false", () => {
    expect(_is_docker_build_cmd(["docker", "ps"])).toBe(false);
  });

  it("test_podman_build_false", () => {
    expect(_is_docker_build_cmd(["podman", "build", "."])).toBe(false);
  });

  it("test_empty_false", () => {
    expect(_is_docker_build_cmd([])).toBe(false);
  });

  it("test_docker_push_false", () => {
    expect(_is_docker_build_cmd(["docker", "push", "myapp"])).toBe(false);
  });

  it("test_docker_compose_up_false", () => {
    // Regression: docker-compose up is NOT a build command.
    expect(_is_docker_build_cmd(["docker-compose", "up"])).toBe(false);
  });

  it("test_docker_compose_up_build_false", () => {
    // Regression: docker-compose up --build is NOT a build-only command.
    expect(_is_docker_build_cmd(["docker-compose", "up", "--build"])).toBe(false);
  });

  it("test_docker_compose_logs_false", () => {
    expect(_is_docker_build_cmd(["docker-compose", "logs"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _has_docker_build_output
// ---------------------------------------------------------------------------

describe("TestHasDockerBuildOutput", () => {
  it("test_classic_step_line", () => {
    expect(_has_docker_build_output("Step 1/5 : FROM python:3.11\n")).toBe(true);
  });

  it("test_buildkit_summary", () => {
    expect(_has_docker_build_output("[+] Building 12.3s (10/10) FINISHED\n")).toBe(true);
  });

  it("test_plain_text_false", () => {
    expect(_has_docker_build_output("hello world\nsome output\n")).toBe(false);
  });

  it("test_empty_false", () => {
    expect(_has_docker_build_output("")).toBe(false);
  });

  it("test_docker_run_output_false", () => {
    expect(_has_docker_build_output("Unable to find image 'python:3.11' locally\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compress_docker_build — classic format
// ---------------------------------------------------------------------------

const _CLASSIC_OUTPUT = `Sending build context to Docker daemon  2.048kB
Step 1/5 : FROM python:3.11-slim
 ---> a7a78dda8a3b
Step 2/5 : WORKDIR /app
 ---> Using cache
 ---> b123456789ab
Step 3/5 : COPY requirements.txt .
 ---> Using cache
 ---> c234567890bc
Step 4/5 : RUN pip install -r requirements.txt
 ---> Running in d345678901cd
Collecting flask
  Downloading Flask-3.0.0-py3-none-any.whl (92 kB)
Successfully installed flask-3.0.0
Removing intermediate container d345678901cd
 ---> e456789012de
Step 5/5 : COPY . .
 ---> f567890123ef
Successfully built 9876543210ab
Successfully tagged myapp:latest
`;

describe("TestCompressDockerBuildClassic", () => {
  let lines: string[];

  beforeEach(() => {
    const [compressed] = compress_docker_build(_CLASSIC_OUTPUT);
    lines = splitlines(compressed);
  });

  it("test_step_headers_kept", () => {
    expect(lines.some((ln) => ln.includes("Step 1/5 : FROM"))).toBe(true);
    expect(lines.some((ln) => ln.includes("Step 2/5 : WORKDIR"))).toBe(true);
    expect(lines.some((ln) => ln.includes("Step 4/5 : RUN"))).toBe(true);
  });

  it("test_using_cache_suppressed", () => {
    expect(lines.some((ln) => ln.includes("Using cache"))).toBe(false);
  });

  it("test_running_in_hash_suppressed", () => {
    expect(lines.some((ln) => ln.includes("Running in d345678901cd"))).toBe(false);
  });

  it("test_bare_hash_arrow_suppressed", () => {
    // Bare ---> <hash> lines like " ---> a7a78dda8a3b" should be gone
    expect(lines.some((ln) => ln.trim() === "---> a7a78dda8a3b")).toBe(false);
    expect(lines.some((ln) => ln.trim() === "---> b123456789ab")).toBe(false);
  });

  it("test_sending_build_context_suppressed", () => {
    expect(lines.some((ln) => ln.includes("Sending build context"))).toBe(false);
  });

  it("test_removing_intermediate_container_suppressed", () => {
    expect(lines.some((ln) => ln.includes("Removing intermediate container"))).toBe(false);
  });

  it("test_run_step_output_kept", () => {
    // Lines inside RUN step (pip output) should be kept
    expect(lines.some((ln) => ln.includes("Collecting flask"))).toBe(true);
    expect(lines.some((ln) => ln.includes("Successfully installed"))).toBe(true);
  });

  it("test_success_built_kept", () => {
    expect(lines.some((ln) => ln.includes("Successfully built 9876543210ab"))).toBe(true);
  });

  it("test_success_tagged_kept", () => {
    expect(lines.some((ln) => ln.includes("Successfully tagged myapp:latest"))).toBe(true);
  });

  it("test_lines_removed_positive", () => {
    const [, removed] = compress_docker_build(_CLASSIC_OUTPUT);
    expect(removed).toBeGreaterThan(0);
  });

  it("test_lines_removed_count", () => {
    const [, removed] = compress_docker_build(_CLASSIC_OUTPUT);
    expect(removed).toBeGreaterThanOrEqual(6);
  });

  it("test_non_run_non_step_lines_suppressed", () => {
    expect(lines.some((ln) => ln.includes("f567890123ef"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compress_docker_build — BuildKit format
// ---------------------------------------------------------------------------

const _BUILDKIT_OUTPUT = `[+] Building 12.3s (10/10) FINISHED
 => [internal] load build definition from Dockerfile           0.0s
 => => transferring dockerfile: 892B                           0.0s
 => [internal] load .dockerignore                              0.0s
 => => transferring context: 2B                                0.0s
 => [internal] load metadata for docker.io/library/python:3.11 1.2s
 => [1/5] FROM docker.io/library/python:3.11@sha256:abc...    0.0s
 => => resolve docker.io/library/python:3.11@sha256:abc...    0.0s
 => CACHED [2/5] WORKDIR /app                                  0.0s
 => CACHED [3/5] COPY requirements.txt .                       0.0s
 => [4/5] RUN pip install -r requirements.txt                  8.7s
 => [5/5] COPY . .                                             0.1s
 => exporting to image                                         1.2s
 => => exporting layers                                        1.1s
 => => writing image sha256:9876543210ab...                    0.0s
 => => naming to docker.io/library/myapp:latest                0.0s
`;

describe("TestCompressDockerBuildKit", () => {
  let lines: string[];

  beforeEach(() => {
    const [compressed] = compress_docker_build(_BUILDKIT_OUTPUT);
    lines = splitlines(compressed);
  });

  it("test_summary_line_kept", () => {
    expect(lines.some((ln) => ln.includes("[+] Building 12.3s"))).toBe(true);
  });

  it("test_step_lines_kept", () => {
    expect(lines.some((ln) => ln.includes("[1/5] FROM"))).toBe(true);
    expect(lines.some((ln) => ln.includes("[4/5] RUN"))).toBe(true);
    expect(lines.some((ln) => ln.includes("[5/5] COPY"))).toBe(true);
  });

  it("test_cached_step_lines_kept", () => {
    expect(lines.some((ln) => ln.includes("CACHED [2/5] WORKDIR"))).toBe(true);
    expect(lines.some((ln) => ln.includes("CACHED [3/5] COPY"))).toBe(true);
  });

  it("test_substep_transferring_suppressed", () => {
    expect(lines.some((ln) => ln.includes("transferring dockerfile"))).toBe(false);
    expect(lines.some((ln) => ln.includes("transferring context"))).toBe(false);
  });

  it("test_substep_exporting_layers_suppressed", () => {
    expect(lines.some((ln) => ln.includes("exporting layers"))).toBe(false);
  });

  it("test_substep_writing_image_suppressed", () => {
    expect(lines.some((ln) => ln.includes("writing image"))).toBe(false);
  });

  it("test_substep_naming_suppressed", () => {
    expect(lines.some((ln) => ln.includes("naming to docker.io"))).toBe(false);
  });

  it("test_resolve_substep_suppressed", () => {
    expect(lines.some((ln) => ln.includes("resolve docker.io"))).toBe(false);
  });

  it("test_lines_removed_positive", () => {
    const [, removed] = compress_docker_build(_BUILDKIT_OUTPUT);
    expect(removed).toBeGreaterThan(0);
  });

  it("test_substep_count_removed", () => {
    const [, removed] = compress_docker_build(_BUILDKIT_OUTPUT);
    expect(removed).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// compress_docker_build — error lines always kept
// ---------------------------------------------------------------------------

describe("TestCompressDockerBuildErrors", () => {
  it("test_error_line_kept", () => {
    const stdout = `Step 1/3 : FROM python:3.11-slim
 ---> a7a78dda8a3b
Step 2/3 : RUN pip install badpackage
 ---> Running in d345678901cd
ERROR: Could not find a version that satisfies the requirement badpackage
The command '/bin/sh -c pip install badpackage' returned a non-zero exit code: 1
`;
    const [compressed] = compress_docker_build(stdout);
    const lines = splitlines(compressed);
    expect(lines.some((ln) => ln.includes("ERROR: Could not find"))).toBe(true);
    expect(lines.some((ln) => ln.includes("non-zero exit code"))).toBe(true);
  });

  it("test_failed_line_kept", () => {
    const stdout = "Step 1/2 : FROM scratch\n ---> abc123\nBUILD FAILED\n";
    const [compressed] = compress_docker_build(stdout);
    expect(compressed).toContain("BUILD FAILED");
  });

  it("test_empty_input", () => {
    const [compressed, removed] = compress_docker_build("");
    expect(compressed).toBe("");
    expect(removed).toBe(0);
  });

  it("test_no_suppressible_lines", () => {
    // All step headers, no ---> lines
    const stdout = "Step 1/2 : FROM python:3.11\nStep 2/2 : CMD python\nSuccessfully built abc\n";
    const [compressed, removed] = compress_docker_build(stdout);
    expect(removed).toBe(0);
    expect(compressed).toContain("Step 1/2");
    expect(compressed).toContain("Step 2/2");
  });
});

// ---------------------------------------------------------------------------
// post_bash integration (smoke tests via direct function call simulation)
// ---------------------------------------------------------------------------

describe("TestPostBashIntegration", () => {
  // Light integration tests: verify the compress functions produce the right
  // systemMessage shape when called from a simulated post_bash context.

  it("test_docker_build_classic_produces_header", () => {
    const [, removed] = compress_docker_build(_CLASSIC_OUTPUT);
    expect(removed).toBeGreaterThan(0);
    const header =
      `[token-goat] docker build: ${removed} build steps ` +
      "compressed (cache/hash/sub-step lines removed). " +
      "Kept: step headers, RUN output, errors.";
    expect(header).toContain("build steps compressed");
    expect(header).toContain("Kept: step headers");
  });

  it("test_docker_build_buildkit_produces_header", () => {
    const [, removed] = compress_docker_build(_BUILDKIT_OUTPUT);
    expect(removed).toBeGreaterThan(0);
    const header =
      `[token-goat] docker build: ${removed} build steps ` +
      "compressed (cache/hash/sub-step lines removed). " +
      "Kept: step headers, RUN output, errors.";
    expect(header).toContain("build steps compressed");
  });

  it("test_non_docker_cmd_not_triggered", () => {
    expect(_is_docker_build_cmd(["npm", "run", "build"])).toBe(false);
    expect(_is_docker_build_cmd(["make", "build"])).toBe(false);
  });

  it("test_exit_code_nonzero_guard", () => {
    // The hook only fires when exit_code in (None, 0).
    // We verify that compress_docker_build itself doesn't crash on error output.
    const error_output = _CLASSIC_OUTPUT + "ERROR: something went wrong\n";
    const [compressed] = compress_docker_build(error_output);
    expect(compressed).toContain("ERROR: something went wrong");
  });

  it("test_has_docker_build_output_guards_buildkit", () => {
    // _has_docker_build_output is the content guard
    expect(_has_docker_build_output(_BUILDKIT_OUTPUT)).toBe(true);
    expect(_has_docker_build_output(_CLASSIC_OUTPUT)).toBe(true);
    // A random command that happens to mention docker won't trigger
    expect(_has_docker_build_output("docker: 'build' is not a docker command")).toBe(false);
  });

  it("test_buildkit_output_with_preamble_detected", () => {
    // Regression: [+] Building with a warning preamble must still be detected.
    const output_with_preamble =
      "WARNING: Docker Desktop version 4.x is outdated\n" +
      "[+] Building 2.1s (5/5) FINISHED\n" +
      " => [1/3] FROM python:3.11\n";
    expect(_has_docker_build_output(output_with_preamble)).toBe(true);
  });
});
