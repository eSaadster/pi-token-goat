import { describe, expect, it } from "vitest";

import { __version__ } from "../src/token_goat/version.js";

describe("version (port of __init__.py)", () => {
  it("__version__ is a non-empty string", () => {
    expect(typeof __version__).toBe("string");
    expect(__version__.length).toBeGreaterThan(0);
  });

  it("__version__ resolves to the package.json value (seed)", () => {
    expect(__version__).toBe("0.0.0-seed");
  });
});
