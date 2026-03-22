import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 10000,
    include: ["tests/**/*.test.ts"],
    includeSource: ["src/**/*.{ts,tsx,js,jsx}"],
    exclude: ["node_modules", "dist"],
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
      "https://esm.sh/graphology@0.25.4": "graphology",
      "https://esm.sh/graphology-layout-forceatlas2@0.10.1": "graphology-layout-forceatlas2",
      "https://esm.sh/sigma@3.0.0-beta.33": path.resolve(rootDir, "tests/graph-visualization/__mocks__/sigma.ts"),
    },
  },
});
