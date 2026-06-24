/**
 * Tests for DockerFilter iteration-105 enhancements (old-format build output).
 *
 * 1:1 port of tests/test_bash_compress_docker_enhancements.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion polarity;
 * the Python test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import DockerFilter`
 *      -> import DockerFilter from the barrel "../src/token_goat/bash_compress.js".
 *  - module-level `_compress(inp, argv=None)` calling
 *    `DockerFilter().compress(inp, "", 0, argv or ["docker", "build", "."])`
 *      -> local `_compress(inp, argv?)` mirroring that exactly (raw `compress()`
 *        override, not `apply()`).
 *  - module-level `_old_build(*steps, success_id="abc123def456")` synthesising a
 *    minimal old-format build -> local `_old_build(steps, success_id?)`. The
 *    Python source defines it but the ported test bodies construct their inputs
 *    inline, so it is retained verbatim for parity (referenced via a `void` to
 *    keep strict unused-symbol settings quiet without altering behaviour).
 *
 * Byte-exactness: substring `in` / `not in` checks translate directly to
 * `.toContain` / `.not.toContain`; no byte arithmetic is involved.
 */
import { describe, expect, it } from "vitest";

import { DockerFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local _compress helper (port of the module-level `_compress`). argv defaults
// to ["docker", "build", "."] exactly as in Python.
// ---------------------------------------------------------------------------
function _compress(inp: string, argv?: string[]): string {
  return new DockerFilter().compress(inp, "", 0, argv ?? ["docker", "build", "."]);
}

// ---------------------------------------------------------------------------
// Port of `_old_build`: produce a minimal old-format docker build output
// (Step N/M style). Retained for 1:1 parity even though the test bodies below
// build their inputs inline (matching the Python module).
// ---------------------------------------------------------------------------
function _old_build(steps: string[], success_id = "abc123def456"): string {
  const total = steps.length;
  const lines: string[] = [];
  steps.forEach((body, idx) => {
    const i = idx + 1;
    lines.push(`Step ${i}/${total} : RUN step${i}`);
    if (body) {
      lines.push(...body.split("\n"));
    }
  });
  lines.push(`Successfully built ${success_id}`);
  return lines.join("\n");
}
void _old_build;

// ---------------------------------------------------------------------------
// Cache / ID suppression
// ---------------------------------------------------------------------------

describe("TestDockerCacheAndIdSuppression", () => {
  it("test_using_cache_suppressed", () => {
    const inp = [
      "Step 1/2 : FROM ubuntu",
      " ---> Using cache",
      "Step 2/2 : CMD bash",
      "Successfully built abc123",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Using cache");
  });

  it("test_sha256_id_suppressed", () => {
    const inp = [
      "Step 1/2 : FROM ubuntu",
      " ---> sha256:abc123def456abc123def456abc123",
      "Step 2/2 : CMD bash",
      "Successfully built abc123def456",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("sha256:");
  });

  it("test_removing_container_suppressed", () => {
    const inp = [
      "Step 1/2 : RUN apt-get update",
      " ---> Running in c0ffee1234ab",
      "Removing intermediate container c0ffee1234ab",
      " ---> deadbeef5678",
      "Step 2/2 : CMD bash",
      "Successfully built deadbeef5678",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Removing intermediate container");
  });
});

// ---------------------------------------------------------------------------
// Cached layer count in preamble
// ---------------------------------------------------------------------------

describe("TestDockerCachedCountPreamble", () => {
  it("test_cached_count_in_preamble", () => {
    const inp = [
      "Step 1/3 : FROM ubuntu",
      " ---> Using cache",
      "Step 2/3 : RUN apt-get update",
      " ---> Using cache",
      "Step 3/3 : CMD bash",
      " ---> sha256:abc123def456abc123",
      "Successfully built abc123def456abc1",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("cached");
  });
});

// ---------------------------------------------------------------------------
// Step header suppression
// ---------------------------------------------------------------------------

describe("TestDockerStepHeaders", () => {
  it("test_clean_step_header_suppressed", () => {
    // Step headers are dropped for clean (no-error) steps
    const inp = [
      "Step 1/2 : FROM ubuntu",
      " ---> abc123",
      "Step 2/2 : CMD bash",
      " ---> def456",
      "Successfully built def456",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("Step 1/2");
    expect(out).not.toContain("Step 2/2");
  });

  it("test_step_error_content_kept", () => {
    // Error output from a step is preserved even though the step header is dropped
    const inp = [
      "Step 1/2 : RUN apt-get install vim",
      "E: Package 'vim' has no installation candidate",
      "Step 2/2 : CMD bash",
      "Successfully built abc123",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("E: Package 'vim' has no installation candidate");
  });
});

// ---------------------------------------------------------------------------
// Successfully built always kept
// ---------------------------------------------------------------------------

describe("TestDockerSuccessfullyBuilt", () => {
  it("test_successfully_built_always_kept", () => {
    const inp = [
      "Step 1/1 : FROM ubuntu",
      " ---> abc123def456abc123def456",
      "Successfully built abc123def456abc123def456",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("Successfully built");
  });
});
