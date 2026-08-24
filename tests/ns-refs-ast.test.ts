import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, findReferences, resolveExport } from "../src/index.js";
import { expectResolvedDef } from "./helpers/narrow.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Namespace member references (AST-based)", () => {
  it("finds references to ns.member across newlines and spaces", async () => {
    const root = await mkTmpDir("dg-ns-refs-");
    const mod = path.join(root, "mod.ts");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(mod, "export const member = 1;\nexport const other = 2;\n", "utf8");
    await fsp.writeFile(
      main,
      [
        "import * as ns from './mod';",
        "const a = ns.member;",
        "const b = ns\n  .member;",
        "const c = ns\n\t.\n  member;",
      ].join("\n"),
      "utf8",
    );
    const index = await buildProjectIndex(root);
    const modFile = mod.replace(/\\/g, "/");
    const hit = resolveExport(index, modFile, "member");
    expect(hit).not.toBeNull();
    if (!hit) return;
    const res = await findReferences(index, { def: expectResolvedDef(hit) });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      const refsInMain = res.references.filter((r) => r.file.replace(/\\/g, "/").endsWith("/main.ts"));
      expect(refsInMain.length).toBeGreaterThanOrEqual(3);
    }
  });
});
