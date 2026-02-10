import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  resolveExport,
} from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Circular re-exports resolution", () => {
  it("resolves through re-export chains without recursion issues", async () => {
    const root = await mkTmpDir("dg-reexp-cycles-");
    const A = path.join(root, "A.ts");
    const B = path.join(root, "B.ts");
    const C = path.join(root, "C.ts");
    await fsp.writeFile(A, "export function foo() { return 1 }\n", "utf8");
    await fsp.writeFile(B, "export { foo } from './A'\n", "utf8");
    await fsp.writeFile(C, "export { foo as foo2 } from './B'\n", "utf8");

    const index = await buildProjectIndex(root);
    const Cfile = C.replace(/\\/g, "/");
    const hit = resolveExport(index, Cfile, "foo2");
    expect(hit).not.toBeNull();
    if (hit) {
      expect(hit.def.file.replace(/\\/g, "/")).toBe(A.replace(/\\/g, "/"));
      expect(hit.def.localName).toBe("foo");
    }
  });

  it("builds detailed symbol graph for circular re-export chain without recursion overflow", async () => {
    const root = await mkTmpDir("dg-reexp-detailed-cycles-");
    const A = path.join(root, "A.ts");
    const B = path.join(root, "B.ts");
    const Main = path.join(root, "main.ts");
    await fsp.writeFile(A, "export { b as a } from './B'\n", "utf8");
    await fsp.writeFile(B, "export { a as b } from './A'\n", "utf8");
    await fsp.writeFile(
      Main,
      "import { a } from './A'\nexport const value = a\n",
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const detailed = await buildSymbolGraphDetailed(index);

    expect(detailed.nodes.size).toBeGreaterThan(0);
  });
});
