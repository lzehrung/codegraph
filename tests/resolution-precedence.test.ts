import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";

import { collectGraph } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("Resolution precedence", () => {
  it("prefers tsconfig paths over workspace package names", async () => {
    const root = await mkTmpDir("dg-precedence-");

    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "root",
          private: true,
          workspaces: ["packages/*"],
        },
        null,
        2,
      ),
      "utf8",
    );

    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              foo: ["src/foo"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "foo.ts"), "export const foo = 1;\n", "utf8");

    const wsDir = path.join(root, "packages", "foo-pkg");
    await fsp.mkdir(wsDir, { recursive: true });
    await fsp.writeFile(
      path.join(wsDir, "package.json"),
      JSON.stringify({ name: "foo", main: "index.js" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(path.join(wsDir, "index.js"), "module.exports = 123;\n", "utf8");

    const main = path.join(root, "main.ts");
    await fsp.writeFile(main, "import { foo } from 'foo';\nconsole.log(foo);\n", "utf8");

    const files = [main, path.join(root, "src", "foo.ts")].map((f) => f.replace(/\\/g, "/"));
    const graph = await collectGraph(root, files);
    const edge = graph.edges.find((e) => e.from.endsWith("/main.ts") && e.raw === "foo" && e.to.type === "file");
    expect(edge).toBeDefined();
    expect(edge?.to.type).toBe("file");
    if (edge?.to.type === "file") {
      expect(edge.to.path.replace(/\\/g, "/").endsWith("/src/foo.ts")).toBe(true);
    }
  });
});
