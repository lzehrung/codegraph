import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  goToDefinition,
  resolveExport,
} from "../src/index.js";
import { deduplicateEdges } from "../src/graph-edge-collector.js";

describe("graph edge provenance", () => {
  it("retains the precise, higher-confidence edge when target identity collides", () => {
    const edges = deduplicateEdges([
      {
        from: "/project/consumer.ts",
        to: { type: "file", path: "/project/target.ts" },
        raw: "path.join(__dirname, 'target')",
        resolved: "heuristic",
        confidence: 0.7,
      },
      {
        from: "/project/consumer.ts",
        to: { type: "file", path: "/project/target.ts" },
        raw: "./target",
        resolved: "precise",
        confidence: 1,
      },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.resolved).toBe("precise");
    expect(edges[0]?.confidence).toBe(1);
  });
});

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
    expect(resolveExport(index, Cfile, "foo")).toBeNull();
    expect(hit).not.toBeNull();
    if (hit) {
      expect(hit.def.file.replace(/\\/g, "/")).toBe(A.replace(/\\/g, "/"));
      expect(hit.def.localName).toBe("foo");
    }
  });

  it("declines ambiguous names from competing star exports and caches the absence", async () => {
    const root = await mkTmpDir("dg-reexp-star-ambiguity-");
    const left = path.join(root, "left.ts");
    const right = path.join(root, "right.ts");
    const barrel = path.join(root, "barrel.ts");
    try {
      await fsp.writeFile(left, "export const shared = 'left'\n", "utf8");
      await fsp.writeFile(right, "export const shared = 'right'\n", "utf8");
      await fsp.writeFile(barrel, "export * from './left'\nexport * from './right'\n", "utf8");

      const index = await buildProjectIndex(root);
      const barrelFile = barrel.replace(/\\/g, "/");

      expect(resolveExport(index, barrelFile, "shared")).toBeNull();
      const cacheSize = index.exportCache.size;
      expect(cacheSize).toBeGreaterThan(0);
      expect(resolveExport(index, barrelFile, "shared")).toBeNull();
      expect(index.exportCache.size).toBe(cacheSize);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an unambiguous name through a star export", async () => {
    const root = await mkTmpDir("dg-reexp-star-single-");
    const source = path.join(root, "source.ts");
    const barrel = path.join(root, "barrel.ts");
    try {
      await fsp.writeFile(source, "export function shared() { return 1 }\n", "utf8");
      await fsp.writeFile(barrel, "export * from './source'\n", "utf8");

      const index = await buildProjectIndex(root);
      const hit = resolveExport(index, barrel.replace(/\\/g, "/"), "shared");

      expect(hit?.kind).toBe("resolved");
      if (!hit || hit.kind !== "resolved") return;
      expect(hit.def.file).toBe(source.replace(/\\/g, "/"));
      expect(hit.def.localName).toBe("shared");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("builds detailed symbol graph for circular re-export chain without recursion overflow", async () => {
    const root = await mkTmpDir("dg-reexp-detailed-cycles-");
    const A = path.join(root, "A.ts");
    const B = path.join(root, "B.ts");
    const Main = path.join(root, "main.ts");
    await fsp.writeFile(A, "export { b as a } from './B'\n", "utf8");
    await fsp.writeFile(B, "export { a as b } from './A'\n", "utf8");
    await fsp.writeFile(Main, "import { a } from './A'\nexport const value = a\n", "utf8");

    const index = await buildProjectIndex(root);
    const detailed = await buildSymbolGraphDetailed(index);

    expect(detailed.nodes.size).toBeGreaterThan(0);
  });

  it("keeps symbol graph imports aligned with goto through barrel re-exports", async () => {
    const root = await mkTmpDir("dg-reexp-symbol-graph-");
    const definitions = path.join(root, "definitions.ts").replace(/\\/g, "/");
    const barrel = path.join(root, "barrel.ts").replace(/\\/g, "/");
    const consumer = path.join(root, "consumer.ts").replace(/\\/g, "/");

    await fsp.writeFile(
      definitions,
      ["export const named = 1;", "export const starred = 2;"].join("\n") + "\n",
      "utf8",
    );
    await fsp.writeFile(
      barrel,
      ["export { named } from './definitions';", "export * from './definitions';"].join("\n") + "\n",
      "utf8",
    );
    await fsp.writeFile(
      consumer,
      [
        "import { named, starred } from './barrel';",
        "import * as barrelNS from './barrel';",
        "export const value = named + starred + barrelNS.named;",
      ].join("\n") + "\n",
      "utf8",
    );

    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraph(index);
    const namedNode = [...graph.nodes.values()].find((node) => node.file === definitions && node.name === "named");
    const starredNode = [...graph.nodes.values()].find((node) => node.file === definitions && node.name === "starred");
    const namedImport = [...graph.nodes.values()].find(
      (node) => node.file === consumer && node.name === "named" && node.kind === "import",
    );
    const starredImport = [...graph.nodes.values()].find(
      (node) => node.file === consumer && node.name === "starred" && node.kind === "import",
    );
    const namespaceImport = [...graph.nodes.values()].find(
      (node) => node.file === consumer && node.name === "barrelNS" && node.kind === "namespaceImport",
    );

    expect(namedNode).toBeDefined();
    expect(starredNode).toBeDefined();
    expect(namedImport).toBeDefined();
    expect(starredImport).toBeDefined();
    expect(namespaceImport).toBeDefined();
    if (!namedNode || !starredNode || !namedImport || !starredImport || !namespaceImport) return;

    expect(graph.edges).toContainEqual({
      from: namedImport.id,
      to: namedNode.id,
      label: "named",
    });
    expect(graph.edges).toContainEqual({
      from: starredImport.id,
      to: starredNode.id,
      label: "starred",
    });
    expect(graph.edges).toContainEqual({
      from: namespaceImport.id,
      to: namedNode.id,
      label: "named",
    });
    expect(graph.edges).toContainEqual({
      from: namespaceImport.id,
      to: starredNode.id,
      label: "starred",
    });

    const goto = await goToDefinition(index, { file: consumer, line: 1, column: 10 });
    expect(goto.status).toBe("ok");
    if (goto.status === "ok") {
      expect(goto.definition.file).toBe(definitions);
      expect(goto.definition.localName).toBe("named");
      expect(namedNode.file).toBe(goto.definition.file);
      expect(namedNode.name).toBe(goto.definition.localName);
    }
  });

  it("detailed graph omits uses edges for ambiguous star exports regardless of declaration order", async () => {
    async function detailedUsesTargets(barrelSource: string): Promise<string[]> {
      const root = await mkTmpDir("dg-reexp-detailed-star-ambiguity-");
      try {
        const left = path.join(root, "left.ts");
        const right = path.join(root, "right.ts");
        const barrel = path.join(root, "barrel.ts");
        const consumer = path.join(root, "consumer.ts");
        await fsp.writeFile(left, "export function shared() { return 'left' }\n", "utf8");
        await fsp.writeFile(right, "export function shared() { return 'right' }\n", "utf8");
        await fsp.writeFile(barrel, barrelSource, "utf8");
        await fsp.writeFile(
          consumer,
          "import { shared } from './barrel'\nexport function uses() { return shared() }\n",
          "utf8",
        );

        const index = await buildProjectIndex(root, { cache: "off" });
        const detailed = await buildSymbolGraphDetailed(index);
        const nodes = [...detailed.nodes.values()];
        const usesNode = nodes.find(
          (node) => node.file.replace(/\\/g, "/").endsWith("/consumer.ts") && node.name === "uses",
        );
        const sharedNodes = nodes.filter(
          (node) =>
            node.name === "shared" &&
            (node.file.replace(/\\/g, "/").endsWith("/left.ts") || node.file.replace(/\\/g, "/").endsWith("/right.ts")),
        );
        expect(usesNode).toBeDefined();
        expect(sharedNodes).toHaveLength(2);
        if (!usesNode) return [];

        const sharedIds = new Set(sharedNodes.map((node) => node.id));
        return detailed.edges
          .filter((edge) => edge.from === usesNode.id && sharedIds.has(edge.to) && edge.label === "uses")
          .map((edge) => edge.to)
          .sort();
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    }

    const leftFirst = await detailedUsesTargets("export * from './left'\nexport * from './right'\n");
    const rightFirst = await detailedUsesTargets("export * from './right'\nexport * from './left'\n");

    expect(leftFirst).toEqual([]);
    expect(rightFirst).toEqual([]);
    expect(leftFirst).toEqual(rightFirst);
  });
});
