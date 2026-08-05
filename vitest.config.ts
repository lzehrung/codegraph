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
