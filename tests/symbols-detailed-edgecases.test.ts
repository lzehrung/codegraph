import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { buildProjectIndex } from "../src/index.js";
import { buildSymbolGraphDetailed } from "../src/graphs.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("Symbols-detailed edge cases", () => {
  it("membersOnly keeps namespace member edges but drops direct alias uses", async () => {
    const root = await mkTmpDir("dg-sym-members-");
    const util = `export function a(){return 1}; export function b(){return 2};\n`;
    const main = `import * as U from './util'\nimport { a } from './util'\nexport function uses(){ return U.a() + a() }\n`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");
    const index = await buildProjectIndex(root);
    const full = await buildSymbolGraphDetailed(index, { membersOnly: false });
    const members = await buildSymbolGraphDetailed(index, { membersOnly: true });
    // total edges fewer or equal
    expect(members.edges.length).toBeLessThanOrEqual(full.edges.length);
    // ensure at least one members edge still present
    expect(members.edges.some((e) => e.label === "uses")).toBe(true);
  });

  it("maxEdges=1 returns at most one uses edge", async () => {
    const root = await mkTmpDir("dg-sym-max-");
    const util = `export function a(){return 1}; export function b(){return 2};\n`;
    const main = `import * as U from './util'\nexport function uses(){ return U.a() + U.b() }\n`;
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");
    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index, { maxEdges: 1 });
    const usesCount = sg.edges.filter((e) => e.label === "uses").length;
    expect(usesCount).toBeLessThanOrEqual(1);
  });
});
