/**
 * Regression tests for bash_detect — lightweight binary->filter lookup.
 *
 * Covers the P2-3/Code-10 fix: bash_detect.detect() must return the correct
 * filter name for known binaries (replacing the 75 ms bash_compress import with
 * a <1 ms dict lookup on the hot path) and null for unknown ones.
 */
import { describe, it, expect } from "vitest";

import * as bash_detect from "../src/token_goat/bash_detect.js";
import { _BINARY_TO_FILTER, detect } from "../src/token_goat/bash_detect.js";
import { FILTERS } from "../src/token_goat/bash_compress.js";

describe("TestDetectKnownBinaries", () => {
  // detect() maps known binary stems to their filter names.

  it("pytest", () => {
    expect(bash_detect.detect(["pytest"])).toBe("pytest");
  });

  it("git", () => {
    expect(bash_detect.detect(["git"])).toBe("git-log");
  });

  it("npm", () => {
    expect(bash_detect.detect(["npm"])).toBe("npm_install");
  });

  it("cargo", () => {
    // cargo maps to the CargoFilter for build/test/check/clippy compression.
    expect(bash_detect.detect(["cargo"])).toBe("cargo");
  });

  it("docker", () => {
    expect(bash_detect.detect(["docker"])).toBe("docker-compose");
  });

  it("gradle", () => {
    expect(bash_detect.detect(["gradle"])).toBe("gradle");
  });

  it("mvn", () => {
    expect(bash_detect.detect(["mvn"])).toBe("maven");
  });

  it("rg mapped to rg", () => {
    expect(bash_detect.detect(["rg"])).toBe("rg");
  });

  it("kubectl", () => {
    expect(bash_detect.detect(["kubectl"])).toBe("kubectl-logs");
  });

  it("find mapped to fd", () => {
    // GNU find shares FdFilter — path-per-line output handled identically.
    expect(bash_detect.detect(["find"])).toBe("fd");
  });

  it("wc mapped to wc", () => {
    // wc is registered with its own WcFilter for whitespace normalisation.
    expect(bash_detect.detect(["wc"])).toBe("wc");
  });
});

describe("TestDetectEdgeCases", () => {
  // detect() handles stems, extensions, paths, and case normalization.

  it("unknown binary returns null", () => {
    expect(bash_detect.detect(["totally_unknown_cmd_xyz"])).toBeNull();
  });

  it("empty argv returns null", () => {
    expect(bash_detect.detect([])).toBeNull();
  });

  it("extension stripped from stem", () => {
    // pytest.exe -> stem 'pytest' -> matches filter.
    expect(bash_detect.detect(["pytest.exe"])).toBe("pytest");
  });

  it("path prefix stripped", () => {
    // /usr/bin/pytest -> stem 'pytest' -> matches filter.
    expect(bash_detect.detect(["/usr/bin/pytest"])).toBe("pytest");
  });

  it("windows path prefix stripped", () => {
    // C:\tools\git.exe -> stem 'git' -> matches filter.
    expect(bash_detect.detect(["C:\\tools\\git.exe"])).toBe("git-log");
  });

  it("case insensitive match", () => {
    // PYTEST -> lowercased -> pytest -> matches filter.
    expect(bash_detect.detect(["PYTEST"])).toBe("pytest");
  });

  it("extra argv elements ignored", () => {
    // Only argv[0] is used; extra arguments do not affect the result.
    expect(bash_detect.detect(["pytest", "-v", "--tb=short"])).toBe("pytest");
    expect(bash_detect.detect(["totally_unknown", "pytest"])).toBeNull();
  });
});

describe("TestBashDetectTableSync", () => {
  // _BINARY_TO_FILTER must stay in sync with bash_compress.FILTERS.
  //
  // These tests fail if a new binary is added to bash_compress.FILTERS without
  // updating bash_detect._BINARY_TO_FILTER, silently losing the fast-path bypass
  // that avoids the 75 ms bash_compress import on every unrecognised command.

  function _expected_table(): Record<string, string> {
    // Build expected {binary: first_match_filter_name} from bash_compress.FILTERS.
    const expected: Record<string, string> = {};
    for (const f of FILTERS) {
      for (const binary of f.binaries) {
        const b = binary.toLowerCase();
        if (!(b in expected)) {
          expected[b] = f.name;
        }
      }
    }
    return expected;
  }

  it("no binaries missing from detect table", () => {
    // Every binary in bash_compress.FILTERS must appear in _BINARY_TO_FILTER.
    const expected = _expected_table();
    const missing = Object.keys(expected)
      .filter((b) => !(b in _BINARY_TO_FILTER))
      .sort();
    expect(missing).toEqual([]);
  });

  it("no stale entries in detect table", () => {
    // Every entry in _BINARY_TO_FILTER must point to a real filter name in FILTERS.
    const valid_names = new Set(FILTERS.map((f) => f.name));
    const stale: Record<string, string> = {};
    for (const [b, n] of Object.entries(_BINARY_TO_FILTER)) {
      if (!valid_names.has(n)) {
        stale[b] = n;
      }
    }
    expect(stale).toEqual({});
  });

  it("detect uses first match filter", () => {
    // Each binary must map to the first matching filter in FILTERS order.
    const expected = _expected_table();
    const mismatched: Record<string, [string, string]> = {};
    for (const b of Object.keys(expected)) {
      if (b in _BINARY_TO_FILTER && expected[b] !== _BINARY_TO_FILTER[b]) {
        mismatched[b] = [expected[b]!, _BINARY_TO_FILTER[b]!];
      }
    }
    expect(mismatched).toEqual({});
  });

  it("table size matches filters", () => {
    // Table entry count must equal the number of distinct binaries across all FILTERS.
    const expected = _expected_table();
    expect(Object.keys(_BINARY_TO_FILTER).length).toBe(Object.keys(expected).length);
  });
});

// Reference the named imports so unused-import lint stays quiet while keeping
// the import surface identical to the Python `from token_goat.bash_detect import`.
void detect;
