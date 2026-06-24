/**
 * Tests for BanditFilter, TrivyFilter, SnykFilter, and SemgrepFilter in
 * token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_security.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports BanditFilter / TrivyFilter / SnykFilter / SemgrepFilter +
 *        select_filter + the FILTERS registry).
 *  - Each Python test class calls `bc.XFilter().apply(stdout, stderr, exit_code,
 *    argv)` directly and reads `.text` / `.compressed_bytes` / `.original_bytes`;
 *    the TS port calls `f.apply(...)` with the same positional args and reads the
 *    same properties (apply() returns a CompressedOutput).
 *  - `isinstance(f, bc.XFilter)` -> `f instanceof XFilter`.
 *  - Python module-level helper functions (_bo, _ts, _snyk_tree, _snyk_output,
 *    _sg) are ported as local TS functions of the same name, mirroring the
 *    Python fixture construction exactly (including the box-drawing and
 *    check-mark / cross glyphs used by Snyk).
 *
 * Byte-exactness: the assertions are substring (`in` / `not in`) checks,
 * `.count(sub)` checks, and `compressed_bytes < original_bytes` comparisons.
 * The fixtures contain non-ASCII glyphs (Snyk: U+251C/U+2514/U+2502/U+2713/
 * U+2717); for the substring / count checks JS string ops are byte-equivalent
 * to Python `in` / `.count` on the same Unicode strings (both index by code
 * unit / code point, and the markers searched for are ASCII). The byte-length
 * comparison uses the framework's own `compressed_bytes`/`original_bytes`
 * (computed via UTF-8 byte length in framework._utf8Len), so no local Buffer
 * arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  BanditFilter,
  SemgrepFilter,
  SnykFilter,
  TrivyFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (mirrors the per-call pattern in the Python file;
// every Python test calls f.apply(stdout, stderr, exit_code, argv) inline, so
// this helper just makes the TS reads a touch shorter while preserving the
// exact positional argument order).
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

/** Python str.count(sub) — count of non-overlapping occurrences. */
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// ===========================================================================
// BanditFilter fixtures
// ===========================================================================

// Synthetic bandit issue blocks used across tests.
// B301 is a bandit code for serialization safety issues (used as test fixture).
const _BANDIT_HIGH =
  ">> Issue: [B301:unsafe_serialize] Unsafe deserialization detected.\n" +
  "   Severity: High   Confidence: Medium\n" +
  "   CWE: CWE-502\n" +
  "   Location: src/load.py:10:4\n";

const _BANDIT_MED =
  ">> Issue: [B105:hardcoded_password_string] Hardcoded password.\n" +
  "   Severity: Medium   Confidence: Medium\n" +
  "   CWE: CWE-259\n" +
  "   Location: src/config.py:5:4\n";

/** Port of Python _bo(issues, *, n_low=0): builds a synthetic bandit stdout. */
function _bo(issues: string[], n_low = 0): string {
  const p: string[] = ["Run started: 2024-01-15 12:00:00.000000", "", "Test results:"];
  p.push(...issues);
  for (let i = 0; i < n_low; i += 1) {
    p.push(
      ">> Issue: [B101:assert_used] Use of assert detected.\n" +
        "   Severity: Low   Confidence: High\n" +
        "   CWE: CWE-703\n" +
        `   Location: tests/test_${i}.py:3:4\n`,
    );
  }
  p.push(
    "Code scanned:",
    "   Total lines of code: 500",
    "",
    "Total issues (by severity):",
    "   Low: 5",
    "   High: 1",
  );
  return p.join("\n");
}

// ===========================================================================
// BanditFilter
// ===========================================================================

describe("TestBanditFilter", () => {
  it("test_matches", () => {
    const f = new BanditFilter();
    expect(f.matches(["bandit", "-r", "src/"])).toBe(true);
    expect(f.matches(["pytest"])).toBe(false);
  });

  it("test_select", () => {
    expect(bc.select_filter(["bandit", "-r", "src/"]) instanceof BanditFilter).toBe(true);
  });

  it("test_run_started", () => {
    const r = new BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).toContain("Run started:");
  });

  it("test_test_results", () => {
    const r = new BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).toContain("Test results:");
  });

  it("test_high", () => {
    const r = new BanditFilter().apply(_bo([_BANDIT_HIGH]), "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).toContain("B301:unsafe_serialize");
  });

  it("test_medium", () => {
    const r = new BanditFilter().apply(_bo([_BANDIT_MED]), "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).toContain("B105:hardcoded_password_string");
  });

  it("test_low_collapsed", () => {
    const r = new BanditFilter().apply(_bo([], 5), "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).not.toContain("CWE-703");
    expect(
      r.text.toLowerCase().includes("collapsed") || r.text.toLowerCase().includes("low"),
    ).toBe(true);
  });

  it("test_code_scanned", () => {
    const r = new BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).toContain("Code scanned:");
  });

  it("test_total_issues", () => {
    const r = new BanditFilter().apply(_bo([]), "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).toContain("Total issues");
  });

  it("test_drops_testing_progress", () => {
    const out = "testing /src/foo.py\ntesting /src/bar.py\nTest results:\n";
    const r = new BanditFilter().apply(out, "", 0, ["bandit", "-r", "src/"]);
    expect(r.text).not.toContain("testing /src/foo.py");
  });

  it("test_empty", () => {
    expect(typeof new BanditFilter().apply("", "", 0, ["bandit"]).text).toBe("string");
  });

  it("test_compression", () => {
    const r = new BanditFilter().apply(_bo([_BANDIT_HIGH], 20), "", 0, ["bandit", "-r", "src/"]);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
    expect(r.text).toContain("B301:unsafe_serialize");
  });
});

// ===========================================================================
// TrivyFilter fixtures
// ===========================================================================

const _TL =
  "2024-01-15T12:00:00Z INFO Need to update DB\n" +
  "2024-01-15T12:00:01Z INFO Downloading DB...\n";

const _THD =
  "+---+--+--+\n" +
  "| Library | Vulnerability ID | Severity | Installed Version |\n" +
  "+---+--+--+";

const _TROWS =
  "| openssl | CVE-2023-0001 | CRITICAL | 1.1.1k |\n" +
  "| libssl | CVE-2023-0002 | HIGH | 1.1.1k |\n" +
  "| zlib | CVE-2023-0003 | MEDIUM | 1.2.11 |\n" +
  "| zlib | CVE-2023-0004 | LOW | 1.2.11 |";

const _TTOT = "Total: 4 (CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1)";

/** Port of Python _ts(): assembles a trivy table stdout. */
function _ts(): string {
  return _THD + "\n" + _TROWS + "\n+---+--+--+\n\n" + _TTOT;
}

// ===========================================================================
// TrivyFilter
// ===========================================================================

describe("TestTrivyFilter", () => {
  it("test_matches", () => {
    expect(new TrivyFilter().matches(["trivy", "image", "nginx:latest"])).toBe(true);
    expect(new TrivyFilter().matches(["bandit"])).toBe(false);
  });

  it("test_select", () => {
    expect(bc.select_filter(["trivy", "fs", "."]) instanceof TrivyFilter).toBe(true);
  });

  it("test_drops_logs", () => {
    const r = new TrivyFilter().apply("", _TL, 0, ["trivy", "image", "nginx"]);
    expect(r.text).not.toContain("INFO");
    expect(r.text).not.toContain("Downloading DB");
  });

  it("test_keeps_critical", () => {
    const r = new TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"]);
    expect(r.text).toContain("CVE-2023-0001");
  });

  it("test_keeps_high", () => {
    const r = new TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"]);
    expect(r.text).toContain("CVE-2023-0002");
  });

  it("test_collapses_medium", () => {
    const r = new TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"]);
    expect(r.text).not.toContain("CVE-2023-0003");
  });

  it("test_collapses_low", () => {
    const r = new TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"]);
    expect(r.text).not.toContain("CVE-2023-0004");
  });

  it("test_keeps_total", () => {
    const r = new TrivyFilter().apply(_ts(), "", 0, ["trivy", "image", "nginx"]);
    expect(r.text).toContain("Total:");
  });

  it("test_no_vuln", () => {
    const r = new TrivyFilter().apply("No vulnerabilities found\n", "", 0, [
      "trivy",
      "image",
      "scratch",
    ]);
    expect(r.text).toContain("No vulnerabilities");
  });

  it("test_empty", () => {
    expect(typeof new TrivyFilter().apply("", "", 0, ["trivy"]).text).toBe("string");
  });

  it("test_compression", () => {
    // Reuse same library names so many rows collapse to a single note per lib,
    // ensuring compressed_bytes < original_bytes even with collapse-note overhead.
    const med_rows = Array.from(
      { length: 30 },
      (_v, i) => `| zlib | CVE-2024-${String(i).padStart(4, "0")} | MEDIUM | 1.2.${i} |`,
    );
    const low_rows = Array.from(
      { length: 20 },
      (_v, i) => `| openssl | CVE-2024-${String(i + 30).padStart(4, "0")} | LOW | 1.1.${i} |`,
    );
    const rows = med_rows.concat(low_rows, ["| critical-pkg | CVE-2024-9999 | CRITICAL | 1.0.0 |"]);
    const stdout = _THD + "\n" + rows.join("\n") + "\n" + _TTOT;
    const r = new TrivyFilter().apply(stdout, "", 0, ["trivy", "image", "nginx"]);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
    expect(r.text).toContain("CVE-2024-9999");
  });
});

// ===========================================================================
// SnykFilter fixtures
// ===========================================================================

const _TC = "\u{251C}\u{2500} "; // "├─ " (U+251C BOX DRAWINGS LIGHT VERTICAL AND RIGHT + U+2500 LIGHT HORIZONTAL)
const _TE = "\u{2514}\u{2500} "; // "└─ " (U+2514 BOX DRAWINGS LIGHT UP AND RIGHT + U+2500)
const _TV = "\u{2502}  "; // "│  " (U+2502 BOX DRAWINGS LIGHT VERTICAL)
const _VX = "\u{2717}"; // "✗" (U+2717 BALLOT X)
const _CK = "\u{2714}"; // "✔" (U+2714 HEAVY CHECK MARK)

/** Port of Python _snyk_tree(extras=0): builds a synthetic snyk dep tree. */
function _snyk_tree(extras = 0): string {
  const lines: string[] = [
    "my-project@1.0.0",
    _TC + "express@4.18.2",
    _TV + _TC + "body-parser@1.20.1",
    _TV + _TE + "debug@2.6.9",
    _TC + "lodash@4.17.21",
    _TE + "moment@2.29.4",
  ];
  for (let i = 0; i < extras; i += 1) {
    lines.push(_TC + `extra-pkg-${i}@1.0.${i}`);
  }
  return lines.join("\n");
}

/** Port of Python _snyk_output(extras=0): assembles a synthetic snyk stdout. */
function _snyk_output(extras = 0): string {
  return (
    "Testing my-project...\n\n" +
    _snyk_tree(extras) +
    "\n\n" +
    _VX +
    " High severity vulnerability found in lodash\n" +
    "  Description: Prototype Pollution\n" +
    "  More about this vulnerability:\n" +
    "    https://snyk.io/vuln/SNYK-JS-LODASH\n\n" +
    _CK +
    " 0 unique vulnerabilities\n" +
    _VX +
    " 1 issues found\n"
  );
}

// ===========================================================================
// SnykFilter
// ===========================================================================

describe("TestSnykFilter", () => {
  it("test_matches", () => {
    expect(new SnykFilter().matches(["snyk", "test"])).toBe(true);
    expect(new SnykFilter().matches(["trivy"])).toBe(false);
  });

  it("test_select", () => {
    expect(bc.select_filter(["snyk", "test"]) instanceof SnykFilter).toBe(true);
  });

  it("test_keeps_first_testing_line", () => {
    const r = new SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"]);
    expect(r.text).toContain("Testing my-project");
  });

  it("test_drops_duplicate_testing_lines", () => {
    const stdout = `Testing foo...\nTesting bar...\n${_CK} 0 unique vulnerabilities\n`;
    const r = new SnykFilter().apply(stdout, "", 0, ["snyk", "test"]);
    expect(_count(r.text, "Testing")).toBe(1);
  });

  it("test_collapses_deep_tree", () => {
    const r = new SnykFilter().apply(_snyk_output(30), "", 0, ["snyk", "test"]);
    expect(
      r.text.toLowerCase().includes("collapsed") ||
        r.text.toLowerCase().includes("dependency tree"),
    ).toBe(true);
  });

  it("test_keeps_vuln_header", () => {
    const r = new SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"]);
    expect(r.text).toContain("High severity");
    expect(r.text).toContain("lodash");
  });

  it("test_collapses_more_about_urls", () => {
    const r = new SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"]);
    expect(r.text).not.toContain("More about this vulnerability:");
  });

  it("test_keeps_summary", () => {
    const r = new SnykFilter().apply(_snyk_output(), "", 0, ["snyk", "test"]);
    expect(r.text.includes("unique vulnerabilities") || r.text.includes("issues found")).toBe(
      true,
    );
  });

  it("test_keeps_license_lines", () => {
    const stdout = `Testing foo...\nLicense issue found in bar@1.0.0\n${_CK} 0 unique\n`;
    const r = new SnykFilter().apply(stdout, "", 0, ["snyk", "test"]);
    expect(r.text).toContain("License issue");
  });

  it("test_empty", () => {
    expect(typeof new SnykFilter().apply("", "", 0, ["snyk"]).text).toBe("string");
  });

  it("test_compression", () => {
    const r = new SnykFilter().apply(_snyk_output(50), "", 0, ["snyk", "test"]);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
  });
});

// ===========================================================================
// SemgrepFilter fixtures
// ===========================================================================

const _SS = "Scanning 42 files...";
const _SSUM = "Ran 100 rules on 42 files: 3 findings.";

/** Port of Python _sg(n=1): builds a synthetic semgrep stdout with n match blocks. */
function _sg(n = 1): string {
  const parts: string[] = [_SS, ""];
  for (let i = 0; i < n; i += 1) {
    parts.push(
      "python.security.audit.exec-used.exec-used\n" +
        `  src/file_${i}.py:${10 + i}:5:\n` +
        `    ${10 + i} |     run_code(user_input)\n` +
        "    Details: https://semgrep.dev/r/python.security.audit.exec-used.exec-used\n",
    );
  }
  parts.push(_SSUM);
  return parts.join("\n");
}

// ===========================================================================
// SemgrepFilter
// ===========================================================================

describe("TestSemgrepFilter", () => {
  it("test_matches", () => {
    expect(new SemgrepFilter().matches(["semgrep", "--config", "p/python"])).toBe(true);
    expect(new SemgrepFilter().matches(["bandit"])).toBe(false);
  });

  it("test_select", () => {
    expect(
      bc.select_filter(["semgrep", "--config", "auto"]) instanceof SemgrepFilter,
    ).toBe(true);
  });

  it("test_keeps_scanning", () => {
    const r = new SemgrepFilter().apply(_sg(), "", 0, ["semgrep"]);
    expect(r.text).toContain("Scanning 42 files");
  });

  it("test_drops_duplicate_scanning", () => {
    const stdout = `Scanning 10 files...\nScanning 20 files...\n${_SSUM}`;
    const r = new SemgrepFilter().apply(stdout, "", 0, ["semgrep"]);
    expect(_count(r.text, "Scanning")).toBe(1);
  });

  it("test_keeps_rule_snippet", () => {
    const r = new SemgrepFilter().apply(_sg(1), "", 0, ["semgrep"]);
    expect(r.text).toContain("exec-used");
  });

  it("test_drops_details_urls", () => {
    const r = new SemgrepFilter().apply(_sg(1), "", 0, ["semgrep"]);
    expect(r.text).not.toContain("Details: https://semgrep.dev");
  });

  it("test_collapses_beyond_3", () => {
    const r = new SemgrepFilter().apply(_sg(10), "", 0, ["semgrep"]);
    expect(
      r.text.toLowerCase().includes("collapsed") || r.text.toLowerCase().includes("additional"),
    ).toBe(true);
  });

  it("test_keeps_first_3", () => {
    const r = new SemgrepFilter().apply(_sg(5), "", 0, ["semgrep"]);
    expect(r.text).toContain("src/file_0.py");
    expect(r.text).toContain("src/file_1.py");
    expect(r.text).toContain("src/file_2.py");
    expect(r.text).not.toContain("src/file_3.py");
    expect(r.text).not.toContain("src/file_4.py");
  });

  it("test_keeps_summary", () => {
    const r = new SemgrepFilter().apply(_sg(), "", 0, ["semgrep"]);
    expect(r.text).toContain("Ran 100 rules");
  });

  it("test_empty", () => {
    expect(typeof new SemgrepFilter().apply("", "", 0, ["semgrep"]).text).toBe("string");
  });

  it("test_compression", () => {
    const r = new SemgrepFilter().apply(_sg(20), "", 0, ["semgrep"]);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
  });
});

// ===========================================================================
// Registry integration
// ===========================================================================

describe("TestSecurityFiltersRegistered", () => {
  it("test_bandit_in_filters", () => {
    expect(bc.FILTERS.some((f) => f instanceof BanditFilter)).toBe(true);
  });

  it("test_trivy_in_filters", () => {
    expect(bc.FILTERS.some((f) => f instanceof TrivyFilter)).toBe(true);
  });

  it("test_snyk_in_filters", () => {
    expect(bc.FILTERS.some((f) => f instanceof SnykFilter)).toBe(true);
  });

  it("test_semgrep_in_filters", () => {
    expect(bc.FILTERS.some((f) => f instanceof SemgrepFilter)).toBe(true);
  });

  it("test_select_bandit", () => {
    expect(bc.select_filter(["bandit", "-r", "."]) instanceof BanditFilter).toBe(true);
  });

  it("test_select_trivy", () => {
    expect(bc.select_filter(["trivy", "image", "alpine:3.18"]) instanceof TrivyFilter).toBe(true);
  });

  it("test_select_snyk", () => {
    expect(bc.select_filter(["snyk", "test", "--all-projects"]) instanceof SnykFilter).toBe(true);
  });

  it("test_select_semgrep", () => {
    expect(
      bc.select_filter(["semgrep", "--config", "auto", "."]) instanceof SemgrepFilter,
    ).toBe(true);
  });
});
