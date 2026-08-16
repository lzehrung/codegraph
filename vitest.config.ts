import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    include: ["tests/**/*.test.ts"],
    includeSource: ["src/**/*.{ts,tsx,js,jsx}"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/types.ts",
        "src/languages/types.ts",
        "src/graphs/types.ts",
        "src/indexer/import-types.ts",
        "src/indexer/scope-types.ts",
      ],
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage/js",
      // Set below the measured baseline with headroom for run-to-run variance.
      // PR 6 added targeted branch coverage for query-index prepare paths, project-name
      // parsers, compile-cache fallbacks, dumpmod/pretty/errorMessage formatters, and
      // parsed-cache LRU identity; ratchet branches only as far as those justify.
      thresholds: {
        lines: 88,
        statements: 86,
        functions: 92,
        branches: 76,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
      "@lzehrung/codegraph": path.resolve(rootDir, "src/index.ts"),
      "./vendor/graphology.js": "graphology",
      "./vendor/graphology-layout-forceatlas2.js": "graphology-layout-forceatlas2",
      "./vendor/sigma.js": path.resolve(rootDir, "tests/graph-visualization/__mocks__/sigma.ts"),
      [path.resolve(rootDir, "docs/graph-visualization/vendor/sigma.js")]: path.resolve(
        rootDir,
        "tests/graph-visualization/__mocks__/sigma.ts",
      ),
    },
  },
});
