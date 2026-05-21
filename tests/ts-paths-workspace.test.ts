import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { collectGraph } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("TypeScript paths/baseUrl resolution via tsconfig", () => {
  it("resolves @lib/util to lib/util.ts using tsconfig paths", async () => {
    const root = await mkTmpDir("dg-ts-paths-");
    const tsconfig = {
      compilerOptions: {
        target: "ES2020",
        module: "ES2020",
        baseUrl: ".",
        paths: {
          "@lib/*": ["lib/*"],
        },
      },
    };
    await fsp.writeFile(path.join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2), "utf8");
    const libDir = path.join(root, "lib");
    await fsp.mkdir(libDir);
    const util = path.join(libDir, "util.ts");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(util, "export const fn = () => 1;\n", "utf8");
    await fsp.writeFile(main, "import { fn } from '@lib/util';\nconst x = fn();\n", "utf8");
    const files = [util, main].map((f) => f.replace(/\\/g, "/"));
    const g = await collectGraph(root, files);
    expect(
      g.edges.some(
        (e) =>
          e.from.endsWith("/main.ts") &&
          e.raw === "@lib/util" &&
          e.to.type === "file" &&
          e.to.path.replace(/\\/g, "/").endsWith("/lib/util.ts"),
      ),
    ).toBe(true);
  });

  it("accepts tsconfig jsonc comments and trailing commas", async () => {
    const root = await mkTmpDir("dg-ts-paths-jsonc-");
    const tsconfig = `{
  // comment
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "baseUrl": ".",
    "paths": {
      "@lib/*": ["lib/*"],
    },
  },
}
`;
    await fsp.writeFile(path.join(root, "tsconfig.json"), tsconfig, "utf8");
    const libDir = path.join(root, "lib");
    await fsp.mkdir(libDir);
    const util = path.join(libDir, "util.ts");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(util, "export const fn = () => 1;\n", "utf8");
    await fsp.writeFile(main, "import { fn } from '@lib/util';\nconst x = fn();\n", "utf8");
    const files = [util, main].map((f) => f.replace(/\\/g, "/"));
    const g = await collectGraph(root, files);
    expect(
      g.edges.some(
        (e) =>
          e.from.endsWith("/main.ts") &&
          e.raw === "@lib/util" &&
          e.to.type === "file" &&
          e.to.path.replace(/\\/g, "/").endsWith("/lib/util.ts"),
      ),
    ).toBe(true);
  });

  it("resolves path aliases from extensionless local tsconfig extends", async () => {
    const root = await mkTmpDir("dg-ts-paths-extends-local-");
    const baseDir = path.join(root, "base");
    const appDir = path.join(root, "app");
    await fsp.mkdir(baseDir, { recursive: true });
    await fsp.mkdir(appDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "tsconfig.base.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@base/*": ["base/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(
      path.join(appDir, "tsconfig.json"),
      JSON.stringify({ extends: "../tsconfig.base" }, null, 2),
      "utf8",
    );
    const util = path.join(baseDir, "util.ts");
    const main = path.join(appDir, "main.ts");
    await fsp.writeFile(util, "export const fn = () => 1;\n", "utf8");
    await fsp.writeFile(main, "import { fn } from '@base/util';\nconst x = fn();\n", "utf8");

    const normalizedMain = main.replace(/\\/g, "/");
    const normalizedUtil = util.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedMain, normalizedUtil]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedMain &&
          edge.raw === "@base/util" &&
          edge.to.type === "file" &&
          edge.to.path === normalizedUtil,
      ),
    ).toBe(true);
  });

  it("resolves path aliases from package-based tsconfig extends", async () => {
    const root = await mkTmpDir("dg-ts-paths-extends-package-");
    const packageDir = path.join(root, "node_modules", "tsconfig-shared");
    const sharedDir = path.join(root, "shared");
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.mkdir(sharedDir, { recursive: true });
    await fsp.writeFile(
      path.join(packageDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["../../shared/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ extends: "tsconfig-shared/tsconfig.json" }, null, 2),
      "utf8",
    );
    const util = path.join(sharedDir, "util.ts");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(util, "export const fn = () => 1;\n", "utf8");
    await fsp.writeFile(main, "import { fn } from '@shared/util';\nconst x = fn();\n", "utf8");

    const normalizedMain = main.replace(/\\/g, "/");
    const normalizedUtil = util.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedMain, normalizedUtil]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedMain &&
          edge.raw === "@shared/util" &&
          edge.to.type === "file" &&
          edge.to.path === normalizedUtil,
      ),
    ).toBe(true);
  });
});
