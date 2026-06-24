/**
 * Render data-transfer types — port of src/token_goat/render/types.py.
 *
 * Python's render/types.py defined these as dataclasses (StatsData, TotalStats,
 * KindStat, DayStat, ProjectStat, SourceStat, CommandStat, Sparklines). In the
 * TS port every wire/index type — including these — is consolidated into the
 * single type root at ../types.ts (see PORT-PLAN.md §3). This module re-exports
 * them so callers importing from "token_goat/render/types" keep the exact
 * import surface the Python module exposed (render/stats_renderer.py imports
 * from here).
 *
 * No runtime values: `export type` only, matching the dataclass-as-types
 * treatment in ../types.ts. Optionality that Python expressed via dataclass
 * defaults (TotalStats.*_delta, StatsData.by_source/by_command/version) is
 * expressed via optional interface fields in ../types.ts.
 */
export type {
  CommandStat,
  DayParam,
  DayStat,
  KindStat,
  ProjectStat,
  SourceStat,
  Sparklines,
  StatsData,
  TotalStats,
} from "../types.js";
