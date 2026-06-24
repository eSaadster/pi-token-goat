/**
 * Tests for ActFilter (local GitHub Actions runner output compression).
 *
 * 1:1 port of tests/test_bash_compress_act_filter.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from tests.filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `apply_filter` / `savings_ratio` helpers below (ports of
 *        filter_test_helpers): apply_filter runs
 *        `filter_.apply(stdout, stderr, exit_code, argv).text` defaulting argv to
 *        `[filter_.name]`; savings_ratio returns
 *        `filter_.apply(stdout, "", 0, argv).percent_saved / 100.0`.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`.
 *  - `isinstance(result, bc.ActFilter)` -> `result instanceof ActFilter`.
 *  - `bc.__all__` -> the runtime `__all__` array re-exported by the barrel.
 *
 * Byte-exactness: the savings-ratio test compares `len(...encode())`-derived
 * percentages; ActFilter operates on whole lines and substring markers, and the
 * fixtures contain the ✅/❌ glyphs (same Unicode codepoints as the Python
 * source). The `apply().percent_saved` getter already does the byte math in
 * UTF-8, so no manual Buffer arithmetic is required here.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { ActFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local helpers (ports of tests/filter_test_helpers.apply_filter / savings_ratio)
// ---------------------------------------------------------------------------
function apply_filter(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

function savings_ratio(filter_: Filter, stdout: string, argv?: string[]): number {
  const _argv = argv ?? [filter_.name];
  return filter_.apply(stdout, "", 0, _argv).percent_saved / 100.0;
}

// ---------------------------------------------------------------------------
// Realistic act session fixture
// ---------------------------------------------------------------------------

const _ACT_RUN = `[Build/Checkout] | Using docker image node:20-bullseye-slim
[Build/Checkout] | Pulling from library/node
[Build/Checkout] | Waiting
[Build/Checkout] | Verifying Checksum
[Build/Checkout] | Pull complete
[Build/Checkout] | Digest: sha256:abc123def456
[Build/Checkout] | Status: Downloaded newer image
[Build/Checkout] | Checking out code...
[Build/Checkout] | git clone https://github.com/org/repo
[Build/Install] | npm install
[Build/Install] | added 312 packages in 4s
[Build/Test  ] | npm test
[Build/Test  ] | PASS src/__tests__/auth.test.js
[Build/Test  ] | PASS src/__tests__/api.test.js
[Build/Test  ] | Test Suites: 2 passed, 2 total
[Build/Test  ] | Tests:       15 passed, 15 total
[Build/Test  ] ✅ Build/Test
[Build/Build ] | npm run build
[Build/Build ] | Build complete in 3.2s
[Build/Build ] ✅ Build/Build
`;

const _ACT_MATRIX_RUN = `[matrix: {"os": "ubuntu-latest", "node": "18"}] Matrix: os=ubuntu-latest node=18
[matrix: {"os": "ubuntu-latest", "node": "20"}] Matrix: os=ubuntu-latest node=20
[matrix: {"os": "windows-latest", "node": "18"}] Matrix: os=windows-latest node=18
[matrix: {"os": "windows-latest", "node": "20"}] Matrix: os=windows-latest node=20
[Test (ubuntu-latest, 18)/Run tests] | npm test
[Test (ubuntu-latest, 18)/Run tests] | Tests: 10 passed
[Test (ubuntu-latest, 18)/Run tests] ✅ Test (ubuntu-latest, 18)
[Test (ubuntu-latest, 20)/Run tests] ✅ Test (ubuntu-latest, 20)
`;

const _ACT_FAILURE_RUN = `[Build/Test] | npm test
[Build/Test] | FAIL src/__tests__/auth.test.js
[Build/Test] | Error: expect(received).toBe(expected)
[Build/Test] | Tests: 1 failed, 14 passed
[Build/Test] | Process completed with exit code 1
[Build/Test] ❌ Build/Test
`;

// ---------------------------------------------------------------------------
// matches()
// ---------------------------------------------------------------------------

it("test_act_matches", () => {
  const f = new ActFilter();
  expect(f.matches(["act"])).toBeTruthy();
  expect(f.matches(["act", "-j", "build"])).toBeTruthy();
  expect(f.matches(["act", "--list"])).toBeTruthy();
  expect(f.matches(["act", "push"])).toBeTruthy();
});

it("test_act_no_match_other_binaries", () => {
  const f = new ActFilter();
  expect(f.matches(["gh"])).toBeFalsy();
  expect(f.matches(["docker"])).toBeFalsy();
  expect(f.matches(["npm"])).toBeFalsy();
  expect(f.matches(["node"])).toBeFalsy();
  expect(f.matches([])).toBeFalsy();
});

it("test_dispatch_routes_to_act", () => {
  const result = bc.select_filter(["act", "-j", "build"]);
  expect(result instanceof ActFilter).toBe(true);
});

// ---------------------------------------------------------------------------
// Docker pull progress lines are collapsed
// ---------------------------------------------------------------------------

it("test_docker_pull_lines_dropped", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_RUN, argv: ["act"] });
  expect(out).not.toContain("Pulling from");
  expect(out).not.toContain("Waiting");
  expect(out).not.toContain("Verifying Checksum");
  expect(out).not.toContain("Pull complete");
  expect(out).not.toContain("Digest:");
  expect(out).not.toContain("Status: Downloaded");
});

it("test_docker_pull_note_emitted", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_RUN, argv: ["act"] });
  expect(out).toContain("docker-pull");
});

// ---------------------------------------------------------------------------
// Job/step prefix stripped from body lines
// ---------------------------------------------------------------------------

it("test_job_prefix_stripped_from_body", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_RUN, argv: ["act"] });
  expect(out).not.toContain("[Build/Install] |");
  expect(out).not.toContain("[Build/Test  ] |");
  expect(out).toContain("npm install");
});

it("test_body_content_kept_after_prefix_strip", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_RUN, argv: ["act"] });
  expect(out).toContain("Test Suites: 2 passed");
  expect(out).toContain("Tests:       15 passed");
  expect(out).toContain("npm run build");
  expect(out).toContain("Build complete in 3.2s");
});

// ---------------------------------------------------------------------------
// Status lines kept verbatim (with prefix)
// ---------------------------------------------------------------------------

it("test_success_status_lines_kept", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_RUN, argv: ["act"] });
  expect(out).toContain("✅ Build/Test");
  expect(out).toContain("✅ Build/Build");
});

it("test_failure_status_line_kept", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_FAILURE_RUN, argv: ["act"] });
  expect(out).toContain("❌ Build/Test");
});

// ---------------------------------------------------------------------------
// Matrix expansion lines collapsed
// ---------------------------------------------------------------------------

it("test_matrix_expansion_lines_dropped", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_MATRIX_RUN, argv: ["act"] });
  expect(out).not.toContain('[matrix: {"os"');
});

it("test_matrix_expansion_note_emitted", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_MATRIX_RUN, argv: ["act"] });
  expect(out.toLowerCase()).toContain("matrix");
});

it("test_matrix_expansion_content_kept", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_MATRIX_RUN, argv: ["act"] });
  expect(out).toContain("npm test");
  expect(out).toContain("Tests: 10 passed");
});

// ---------------------------------------------------------------------------
// Failure / error lines kept verbatim (stripped of prefix)
// ---------------------------------------------------------------------------

it("test_error_lines_in_body_kept", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_FAILURE_RUN, argv: ["act"] });
  expect(out).toContain("FAIL src/__tests__/auth.test.js");
  expect(out).toContain("Error: expect(received).toBe(expected)");
  expect(out).toContain("Process completed with exit code 1");
});

it("test_failure_body_prefix_stripped", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: _ACT_FAILURE_RUN, argv: ["act"] });
  expect(out).not.toContain("[Build/Test] |");
});

// ---------------------------------------------------------------------------
// Short / clean output passes through
// ---------------------------------------------------------------------------

it("test_short_output_passes_through", () => {
  const short = "[Build/Test] | Tests: 5 passed\n[Build/Test] ✅ Build/Test\n";
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: short, argv: ["act"] });
  expect(out).toContain("Tests: 5 passed");
  expect(out).toContain("✅ Build/Test");
});

it("test_empty_input", () => {
  const f = new ActFilter();
  const out = apply_filter(f, { stdout: "", argv: ["act"] });
  expect(out).toBe("");
});

// ---------------------------------------------------------------------------
// Savings ratio
// ---------------------------------------------------------------------------

it("test_savings_on_docker_heavy_run", () => {
  const ratio = savings_ratio(new ActFilter(), _ACT_RUN, ["act"]);
  expect(ratio).toBeGreaterThan(0.2);
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

it("test_act_filter_in_filters_registry", () => {
  const names = new Set(bc.FILTERS.map((f) => f.name));
  expect(names.has("act")).toBe(true);
});

it("test_act_filter_in_all_exports", () => {
  expect(bc.__all__).toContain("ActFilter");
});
