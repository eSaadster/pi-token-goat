/**
 * Smoke test for render/types.ts re-exports (port of render/types.py).
 *
 * The render types themselves are exercised by the stats-renderer tests in
 * Layer 4; this file only verifies that render/types.ts re-exports the same
 * names the Python module's __all__ exposed, so callers importing from
 * "token_goat/render/types" resolve at compile time.
 */
import { describe, expect, it } from "vitest";

// Type-only imports: these fail to compile if render/types.ts stops re-exporting
// any name the Python __all__ listed.
import type {
  CommandStat,
  DayStat,
  KindStat,
  ProjectStat,
  SourceStat,
  Sparklines,
  StatsData,
  TotalStats,
} from "../src/token_goat/render/types.js";

describe("render/types re-exports (port of render/types.py)", () => {
  it("re-exports every name in the Python __all__", () => {
    // Referencing each type in a parameter position is the compile-time check.
    const check = (
      _a: StatsData,
      _b: TotalStats,
      _c: KindStat,
      _d: DayStat,
      _e: ProjectStat,
      _f: SourceStat,
      _g: CommandStat,
      _h: Sparklines,
    ): void => {};
    expect(typeof check).toBe("function");
  });
});
