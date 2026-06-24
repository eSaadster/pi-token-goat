/**
 * Tests for BaseFilter ABC and filter subclass compliance.
 *
 * 1:1 TypeScript (vitest) port of tests/test_base_filter_abc.py, asserting
 * against the bash_compress BARREL (../src/token_goat/bash_compress.js), which
 * re-exports the framework's BaseFilter / Filter / GenericFilter and owns the
 * FILTERS registry — mirroring Python's `from token_goat import bash_compress
 * as bc`.
 *
 * Covers:
 *  - BaseFilter abstract methods are properly defined
 *  - can_handle() fails softly on exceptions
 *  - savings_ratio property returns a float in [0.0, 1.0]
 *  - All registered filters are BaseFilter subclasses
 *
 * Parity / deferral notes
 * ------------------------
 * The ~150 tool-specific filters (PytestFilter, DockerFilter, GitFilter, ...)
 * are NOT yet ported — they land in later runs as sibling modules appended to
 * FILTERS. Every Python test that instantiates one of those classes
 * (bc.PytestFilter() / bc.DockerFilter() / bc.GitFilter()) is therefore deferred
 * with it.skip + a "// PORT: deferred — <reason>" tag. The tests that exercise
 * only the framework contract (BaseFilter / Filter / GenericFilter / FILTERS)
 * port 1:1 with the SAME name and assertion polarity.
 *
 * Python `isinstance(x, float)` -> `typeof x === "number"` (JS has a single
 * number type; bash_compress's savings_ratio is a JS number, the faithful
 * analogue of Python's float). Python `issubclass(A, B)` ->
 * `A.prototype instanceof B`. Python `isinstance(inst, B)` -> `inst instanceof
 * B`. `pytest.raises(TypeError, match="abstract")` -> expect(() => ...).toThrow
 * with a TypeError whose message contains "abstract".
 */
import { describe, expect, it } from "vitest";

import {
  BaseFilter,
  FILTERS,
  Filter,
  GenericFilter,
} from "../src/token_goat/bash_compress.js";

// ===========================================================================
// TestBaseFilterInterface — the BaseFilter ABC interface.
// ===========================================================================

describe("TestBaseFilterInterface", () => {
  it("test_base_filter_is_abstract", () => {
    // BaseFilter cannot be instantiated directly.
    //
    // Python: `with pytest.raises(TypeError, match="abstract"): bc.BaseFilter()`.
    // In TS `new BaseFilter()` is also a compile error (abstract class); the
    // runtime guard in the constructor reproduces the THROW for a JS caller that
    // bypasses the type checker, with a message containing "abstract". The cast
    // through `unknown` lets us exercise that runtime guard despite the abstract
    // type. type-cast mirrors Python's `# type: ignore[abstract]`.
    const ctor = BaseFilter as unknown as { new (): BaseFilter };
    expect(() => new ctor()).toThrow(TypeError);
    expect(() => new ctor()).toThrow(/abstract/);
  });

  it("test_filter_implements_base_filter", () => {
    // Filter is a subclass of BaseFilter.
    expect(Filter.prototype instanceof BaseFilter).toBe(true);
  });

  it("test_all_filters_are_base_filter_subclasses", () => {
    // Every registered filter is a BaseFilter subclass.
    for (const f of FILTERS) {
      expect(
        f instanceof BaseFilter,
        `Filter ${f.name} (${f.constructor.name}) is not a BaseFilter instance`,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// TestCanHandleFailSoft — can_handle() exception handling.
// ===========================================================================

describe("TestCanHandleFailSoft", () => {
  it.skip("test_can_handle_returns_bool", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_can_handle_valid_command", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_can_handle_invalid_command", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_can_handle_malformed_command", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_can_handle_empty_command", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_can_handle_very_long_command", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });
});

// ===========================================================================
// TestSavingsRatioProperty — savings_ratio property.
// ===========================================================================

describe("TestSavingsRatioProperty", () => {
  it.skip("test_savings_ratio_returns_float", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it("test_savings_ratio_in_valid_range", () => {
    // savings_ratio is clamped to [0.0, 1.0].
    for (const f of FILTERS) {
      const ratio = f.savings_ratio;
      expect(
        0.0 <= ratio && ratio <= 1.0,
        `${f.name} savings_ratio = ${ratio}, expected in [0.0, 1.0]`,
      ).toBe(true);
    }
  });

  it("test_savings_ratio_never_raises", () => {
    // savings_ratio never raises, even for broken filters.
    // GenericFilter should always work.
    const f = new GenericFilter();
    const ratio = f.savings_ratio;
    expect(typeof ratio).toBe("number");
    expect(ratio).toBeGreaterThanOrEqual(0.0);
  });

  it.skip("test_savings_ratio_makes_sense", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it("test_all_filters_have_valid_savings_ratio", () => {
    // Every registered filter has a valid savings_ratio.
    for (const f of FILTERS) {
      const ratio = f.savings_ratio;
      expect(typeof ratio, `${f.name} savings_ratio is not a float: ${typeof ratio}`).toBe(
        "number",
      );
      expect(
        0.0 <= ratio && ratio <= 1.0,
        `${f.name} savings_ratio out of range: ${ratio}`,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// TestDetectFromCommand — detect_from_command() method on filters.
// ===========================================================================

describe("TestDetectFromCommand", () => {
  it.skip("test_pytest_filter_detect_from_command_valid", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_pytest_filter_detect_from_command_invalid", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_docker_filter_detect_from_command_valid", () => {
    // PORT: deferred — needs DockerFilter (tool-specific filter not yet ported).
  });

  it.skip("test_docker_filter_detect_from_command_invalid", () => {
    // PORT: deferred — needs DockerFilter (tool-specific filter not yet ported).
  });

  it.skip("test_git_filter_detect_from_command_valid", () => {
    // PORT: deferred — needs GitFilter (tool-specific filter not yet ported).
  });

  it.skip("test_git_filter_detect_from_command_invalid", () => {
    // PORT: deferred — needs GitFilter (tool-specific filter not yet ported).
  });
});

// ===========================================================================
// TestFilterNameProperty — the name property/attribute.
// ===========================================================================

describe("TestFilterNameProperty", () => {
  it("test_filter_has_name_attribute", () => {
    // All filters have a name attribute.
    for (const f of FILTERS) {
      // Python: hasattr(f, "name"); isinstance(f.name, str); len(f.name) > 0.
      // Every Filter has a `name` string field; assert it is a non-empty string.
      expect(typeof f.name).toBe("string");
      expect(f.name.length).toBeGreaterThan(0);
    }
  });

  it("test_filter_names_are_lowercase", () => {
    // Filter names should be lowercase for consistency.
    for (const f of FILTERS) {
      // Most names are lowercase; some may have hyphens.
      // Python str.islower(): true when the string has at least one cased char
      // and all cased chars are lowercase. For the lowercase identifiers these
      // filters use, `name === name.toLowerCase()` with a cased-char check is the
      // faithful equivalent.
      const isLower = _strIsLower(f.name) || f.name.includes("-");
      expect(isLower, `Filter name ${f.name} is not lowercase`).toBe(true);
    }
  });

  it.skip("test_pytest_filter_name", () => {
    // PORT: deferred — needs PytestFilter (tool-specific filter not yet ported).
  });

  it.skip("test_docker_filter_name", () => {
    // PORT: deferred — needs DockerFilter (tool-specific filter not yet ported).
  });
});

// ---------------------------------------------------------------------------
// Local helper: Python str.islower().
// ---------------------------------------------------------------------------

/**
 * Python str.islower() — true when the string contains at least one cased
 * character and every cased character is lower-case. Uncased characters
 * (digits, hyphens) are ignored.
 */
function _strIsLower(s: string): boolean {
  let hasCased = false;
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower !== upper) {
      // Cased character.
      hasCased = true;
      if (ch !== lower) {
        return false;
      }
    }
  }
  return hasCased;
}
