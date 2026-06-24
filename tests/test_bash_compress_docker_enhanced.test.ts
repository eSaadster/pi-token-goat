/**
 * Tests for DockerFilter old-format (non-BuildKit) compression passes.
 *
 * 1:1 port of tests/test_bash_compress_docker_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion polarity;
 * the Python test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import DockerFilter`
 *      -> import DockerFilter from the barrel "../src/token_goat/bash_compress.js"
 *        (re-exports the container filters incl. DockerFilter).
 *  - module-level `_compress(inp, argv=None)` calling
 *    `DockerFilter().compress(inp, "", 0, argv or ["docker", "build", "."])`
 *      -> local `_compress(inp, argv?)` mirroring that exactly. The Python helper
 *        invokes the raw `compress()` override (not `apply()`), so the TS port
 *        does too.
 *
 * Byte-exactness: these filters operate on whole lines; the assertions are
 * substring `in` / `not in` checks on the returned string, which translate
 * directly to `.toContain` / `.not.toContain`. No byte arithmetic is involved.
 */
import { describe, expect, it } from "vitest";

import { DockerFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local _compress helper (port of the module-level `_compress` in the Python
// test). argv defaults to ["docker", "build", "."] exactly as in Python.
// ---------------------------------------------------------------------------
function _compress(inp: string, argv?: string[]): string {
  return new DockerFilter().compress(inp, "", 0, argv ?? ["docker", "build", "."]);
}

// ---------------------------------------------------------------------------
// Cache / ID line suppression
// ---------------------------------------------------------------------------

describe("TestCacheLineSuppression", () => {
  it("test_using_cache_removed_from_output", () => {
    const inp = [
      "Step 1/3 : FROM python:3.12",
      " ---> Using cache",
      "Step 2/3 : COPY . /app",
      " ---> Using cache",
      "Step 3/3 : CMD python app.py",
      " ---> def456abc789",
      "Successfully built def456abc789",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("---> Using cache");
    expect(out).not.toContain("Using cache");
  });

  it("test_multiple_cache_lines_all_removed", () => {
    const inp = [
      "Step 1/4 : FROM ubuntu:22.04",
      " ---> Using cache",
      "Step 2/4 : RUN apt-get update",
      " ---> Using cache",
      "Step 3/4 : RUN apt-get install -y curl",
      " ---> Using cache",
      "Step 4/4 : CMD bash",
      " ---> 111aaa222bbb",
      "Successfully built 111aaa222bbb",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Using cache");
  });

  it("test_sha256_id_line_removed", () => {
    const inp = [
      "Step 1/2 : FROM node:20",
      " ---> sha256:aabbccddeeff00112233445566778899aabbccdd",
      "Step 2/2 : CMD node server.js",
      "Successfully built aabbccddeeff001",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("sha256:");
  });

  it("test_sha256_short_hash_removed", () => {
    const inp = [
      "Step 1/1 : FROM alpine",
      " ---> sha256:deadbeefcafe1234",
      "Successfully built deadbeefcafe",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("sha256:");
  });

  it("test_cache_count_reflected_in_preamble", () => {
    // 2 cache hits -> preamble should say "2 cached"
    const inp = [
      "Step 1/3 : FROM ubuntu",
      " ---> Using cache",
      "Step 2/3 : RUN echo hello",
      " ---> Using cache",
      "Step 3/3 : CMD bash",
      " ---> 99aabb",
      "Successfully built 99aabb",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("2 cached");
  });

  it("test_cache_count_exact_in_preamble", () => {
    // 3-step build, 3 cached -> preamble: [building 3 layers, 3 cached]
    const inp = [
      "Step 1/3 : FROM python:3.12",
      " ---> Using cache",
      "Step 2/3 : COPY requirements.txt /",
      " ---> Using cache",
      "Step 3/3 : RUN pip install -r /requirements.txt",
      " ---> Using cache",
      "Successfully built abcdef123456",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("[building 3 layers, 3 cached]");
  });
});

// ---------------------------------------------------------------------------
// Removing intermediate container suppression
// ---------------------------------------------------------------------------

describe("TestIntermediateContainerSuppression", () => {
  it("test_removing_intermediate_container_removed", () => {
    const inp = [
      "Step 1/2 : RUN apt-get update",
      " ---> Running in a1b2c3d4e5f6",
      "Removing intermediate container a1b2c3d4e5f6",
      " ---> f6e5d4c3b2a1",
      "Step 2/2 : CMD bash",
      "Successfully built f6e5d4c3b2a1",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Removing intermediate container");
  });

  it("test_multiple_intermediate_containers_removed", () => {
    const inp = [
      "Step 1/3 : RUN apt-get update",
      "Removing intermediate container aaa111",
      "Step 2/3 : RUN apt-get install curl",
      "Removing intermediate container bbb222",
      "Step 3/3 : CMD bash",
      "Successfully built ccc333",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Removing intermediate container");
  });
});

// ---------------------------------------------------------------------------
// Step header suppression for clean steps
// ---------------------------------------------------------------------------

describe("TestStepHeaderSuppression", () => {
  it("test_clean_step_header_suppressed", () => {
    const inp = [
      "Step 1/3 : FROM ubuntu",
      " ---> Using cache",
      "Step 2/3 : RUN echo ok",
      " ---> abc111",
      "Step 3/3 : CMD bash",
      " ---> def222",
      "Successfully built def222",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Step 1/3");
    expect(out).not.toContain("Step 2/3");
    expect(out).not.toContain("Step 3/3");
  });

  it("test_step_with_error_content_keeps_error_text", () => {
    // Error content is kept even though the step header itself may be dropped
    const inp = [
      "Step 1/2 : RUN pip install nonexistent-pkg",
      "ERROR: Could not find a version that satisfies the requirement nonexistent-pkg",
      "Step 2/2 : CMD python app.py",
      "Successfully built abc123",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("Could not find a version");
    expect(out).toContain("Step 1/2");
  });

  it("test_clean_build_all_step_headers_dropped", () => {
    // Pure cache hit build: all step headers dropped, only preamble + success kept
    const inp = [
      "Step 1/2 : FROM alpine",
      " ---> Using cache",
      "Step 2/2 : CMD sh",
      " ---> Using cache",
      "Successfully built xyz789",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Step 1/2");
    expect(out).not.toContain("Step 2/2");
    expect(out).toContain("Successfully built");
  });
});

// ---------------------------------------------------------------------------
// Successfully built always kept
// ---------------------------------------------------------------------------

describe("TestSuccessfullyBuiltAlwaysKept", () => {
  it("test_success_line_present_after_all_suppression", () => {
    const inp = [
      "Step 1/1 : FROM scratch",
      " ---> Using cache",
      " ---> sha256:000111222333444555666777888999aaabbb",
      "Removing intermediate container 000111222",
      "Successfully built 000111222333",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("Successfully built 000111222333");
  });

  it("test_success_line_present_with_short_id", () => {
    const inp = [
      "Step 1/1 : FROM ubuntu",
      " ---> abc123def456",
      "Successfully built abc123def456",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("Successfully built abc123def456");
  });
});

// ---------------------------------------------------------------------------
// Preamble format
// ---------------------------------------------------------------------------

describe("TestBuildingPreamble", () => {
  it("test_preamble_format_layer_and_cached_counts", () => {
    const inp = [
      "Step 1/4 : FROM python:3.11",
      " ---> Using cache",
      "Step 2/4 : WORKDIR /app",
      " ---> Using cache",
      "Step 3/4 : COPY . .",
      " ---> 1a2b3c",
      "Step 4/4 : CMD python main.py",
      " ---> 4d5e6f",
      "Successfully built 4d5e6f",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("[building 4 layers, 2 cached]");
  });

  it("test_no_preamble_when_no_cache_hits", () => {
    // When there are no cache hits the preamble is not emitted
    const inp = [
      "Step 1/2 : FROM ubuntu",
      " ---> deadbeef1234",
      "Step 2/2 : CMD bash",
      " ---> cafebabe5678",
      "Successfully built cafebabe5678",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("[building");
  });

  it("test_preamble_appears_before_other_content", () => {
    const inp = [
      "Step 1/2 : FROM alpine",
      " ---> Using cache",
      "Step 2/2 : RUN echo hi",
      " ---> abc",
      "Successfully built abc",
    ].join("\n");
    const out = _compress(inp);
    const preamble_pos = out.indexOf("[building");
    const success_pos = out.indexOf("Successfully built");
    expect(preamble_pos).not.toBe(-1);
    expect(preamble_pos).toBeLessThan(success_pos);
  });
});
