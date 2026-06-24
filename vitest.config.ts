import { defineConfig } from "vitest/config";

// Mirrors the design's runner choice: vitest, fork-per-file isolation to
// reproduce pytest-xdist --dist=loadscope module-scoped execution. The entropy
// seed needs none of that yet, but the config is set up so later layers inherit
// the correct execution model without churn.
export default defineConfig({
  test: {
    // File-level isolation == loadscope's module grouping. Once modules with
    // mutable global state land (paths.data_dir, the 8 module-level caches),
    // the setDataDir + clearModuleCaches beforeEach in tests/_setup guarantees
    // a clean graph per file.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    setupFiles: ["tests/setup.ts"],
  },
});
