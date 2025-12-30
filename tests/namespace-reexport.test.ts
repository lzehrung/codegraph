import { describe, it, expect } from "vitest";
import {
  buildProjectIndexFromFiles,
  goToDefinition,
} from "../src/index.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

describe("namespace re-export", () => {
  it("should resolve ns.member for export * as ns from", async () => {
    const root = path.resolve("temp-ns-reexport-test");
    if (!fs.existsSync(root)) fs.mkdirSync(root);
    
    const libFile = path.join(root, "lib.ts").replace(/\\/g, "/");
    const reexportFile = path.join(root, "reexport.ts").replace(/\\/g, "/");
    const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
    
    await fsp.writeFile(libFile, `export const x = 1;`);
    await fsp.writeFile(reexportFile, `export * as ns from "./lib";`);
    await fsp.writeFile(mainFile, `
      import { ns } from "./reexport";
      console.log(ns.x); // line 3
    `);

    try {
      const index = await buildProjectIndexFromFiles(root, [libFile, reexportFile, mainFile]);

      // Goto definition of ns.x at line 3
      const res = await goToDefinition(index, { file: mainFile, line: 3, column: 22 });
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.definition.file).toBe(libFile);
        expect(res.definition.localName).toBe("x");
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("should resolve transitive namespace re-exports", async () => {
    const root = path.resolve("temp-ns-transitive-test");
    if (!fs.existsSync(root)) fs.mkdirSync(root);
    
    const libFile = path.join(root, "lib.ts").replace(/\\/g, "/");
    const ns1File = path.join(root, "ns1.ts").replace(/\\/g, "/");
    const ns2File = path.join(root, "ns2.ts").replace(/\\/g, "/");
    const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
    
    await fsp.writeFile(libFile, `export const x = 1;`);
    await fsp.writeFile(ns1File, `export * as sub from "./lib";`);
    await fsp.writeFile(ns2File, `export * as outer from "./ns1";`);
    await fsp.writeFile(mainFile, `
      import { outer } from "./ns2";
      console.log(outer.sub.x); // line 3
    `);

    try {
      const index = await buildProjectIndexFromFiles(root, [libFile, ns1File, ns2File, mainFile]);

      // outer.sub.x
      // outer at 19, sub at 25, x at 29
      const res = await goToDefinition(index, { file: mainFile, line: 3, column: 29 });
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.definition.file).toBe(libFile);
        expect(res.definition.localName).toBe("x");
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("should handle circular namespace re-exports gracefully", async () => {
    const root = path.resolve("temp-ns-circular-test");
    if (!fs.existsSync(root)) fs.mkdirSync(root);
    
    const aFile = path.join(root, "a.ts").replace(/\\/g, "/");
    const bFile = path.join(root, "b.ts").replace(/\\/g, "/");
    const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
    
    await fsp.writeFile(aFile, `export * as b from "./b";\nexport const valA = 1;`);
    await fsp.writeFile(bFile, `export * as a from "./a";\nexport const valB = 2;`);
    await fsp.writeFile(mainFile, `
      import { a } from "./b";
      console.log(a.b.a.valA); // deeply nested
    `);

    try {
      const index = await buildProjectIndexFromFiles(root, [aFile, bFile, mainFile]);

      const res = await goToDefinition(index, { file: mainFile, line: 3, column: 25 }); // valA
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.definition.file).toBe(aFile);
        expect(res.definition.localName).toBe("valA");
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
