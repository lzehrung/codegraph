import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  resolveExport,
} from "../src/index.js";
import { deduplicateEdges } from "../src/graph-edge-collector.js";
import { expectResolvedDef } from "./helpers/narrow.js";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
} from "./helpers/consumer-agreement.js";

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
      expect(expectResolvedDef(hit).file.replace(/\\/g, "/")).toBe(A.replace(/\\/g, "/"));
      expect(expectResolvedDef(hit).localName).toBe("foo");
    }
  });

  it("declines competing star exports before and after warming the cache", async () => {
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
      expect(expectResolvedDef(hit).file).toBe(source.replace(/\\/g, "/"));
      expect(expectResolvedDef(hit).localName).toBe("shared");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Python's later star binding through a re-exporting module", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-python-nested-stars-", {
      "pkg/__init__.py": "",
      "pkg/left.py": "def target():\n    return 1\n",
      "pkg/right.py": "def target():\n    return 2\n",
      "pkg/empty.py": "def other():\n    return 3\n",
      "pkg/inner.py": "from .left import *\nfrom .right import *\n",
      "pkg/outer.py": "from .inner import *\nfrom .right import *\nfrom .empty import *\n",
      "pkg/use.py": "from .outer import target\n\ndef run():\n    return target()\n",
      "pkg/inner_use.py": "from .inner import target\n\ndef run_inner():\n    return target()\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "pkg/use.py",
        line: 4,
        token: "target",
        expected: { file: "pkg/right.py", line: 1 },
        edges: [{ label: "calls", from: { file: "pkg/use.py", name: "run" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "pkg/use.py",
        line: 4,
        token: "target",
        mustNotMatch: { file: "pkg/left.py", line: 1, token: "target" },
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "pkg/use.py", name: "run" } },
      });
      await assertConsumerAgreement(fixture, {
        file: "pkg/inner_use.py",
        line: 4,
        token: "target",
        expected: { file: "pkg/right.py", line: 1 },
        edges: [{ label: "calls", from: { file: "pkg/inner_use.py", name: "run_inner" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "pkg/inner_use.py",
        line: 4,
        token: "target",
        mustNotMatch: { file: "pkg/left.py", line: 1, token: "target" },
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "pkg/inner_use.py", name: "run_inner" } },
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it.each([
    { first: "left", second: "right" },
    { first: "right", second: "left" },
  ])("preserves repeated Python star imports ending with $first", async ({ first, second }) => {
    const fixture = await buildConsumerAgreementFixture("cg-python-repeat-star-", {
      "pkg/__init__.py": "",
      "pkg/left.py": "def target():\n    return 1\n",
      "pkg/right.py": "def target():\n    return 2\n",
      "pkg/facade.py": `from .${first} import *\nfrom .${second} import *\nfrom .${first} import *\n`,
      "pkg/outer.py": "from .facade import *\n",
      "pkg/use.py": "from .outer import target\n\ndef run():\n    return target()\n",
    });
    try {
      for (const allowLocalFallback of [false, true]) {
        fixture.index.exportCache.clear();
        const result = resolveExport(fixture.index, fixture.paths["pkg/facade.py"]!, "target", {
          allowLocalFallback,
        });
        expect(result?.kind).toBe("resolved");
        if (result?.kind !== "resolved") throw new Error("Expected the repeated star's final binding");
        expect(result.def.file).toBe(fixture.paths[`pkg/${first}.py`]);
      }
      await assertConsumerAgreement(fixture, {
        file: "pkg/use.py",
        line: 4,
        token: "target",
        expected: { file: `pkg/${first}.py`, line: 1 },
        requireCompleteCoverage: true,
        edges: [{ label: "calls", from: { file: "pkg/use.py", name: "run" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "pkg/use.py",
        line: 4,
        token: "target",
        mustNotMatch: { file: `pkg/${second}.py`, line: 1, token: "target" },
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "pkg/use.py", name: "run" } },
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it.each(["[]", '["other"]'])("keeps __all__ exclusions in Python star re-exports with %s", async (all) => {
    const fixture = await buildConsumerAgreementFixture("cg-python-star-all-", {
      "pkg/__init__.py": "",
      "pkg/left.py": "def target():\n    return 1\n",
      "pkg/right.py": `def target():\n    return 2\n\ndef other():\n    return 3\n\n__all__ = ${all}\n`,
      "pkg/facade.py": "from .left import *\nfrom .right import *\n",
      "pkg/outer.py": "from .facade import *\n",
      "pkg/use.py": "from .outer import target\n\ndef run():\n    return target()\n",
      "pkg/explicit_use.py": "from .right import target\n\ndef run_explicit():\n    return target()\n",
      "pkg/named.py": "from .right import target\n",
      "pkg/named_star.py": "from .named import *\n",
    });
    try {
      for (const allowLocalFallback of [false, true]) {
        fixture.index.exportCache.clear();
        const coldNamed = resolveExport(fixture.index, fixture.paths["pkg/named.py"]!, "target", {
          allowLocalFallback,
        });
        fixture.index.exportCache.clear();
        const namedStar = resolveExport(fixture.index, fixture.paths["pkg/named_star.py"]!, "target");
        expect(namedStar?.kind).toBe("resolved");
        if (namedStar?.kind !== "resolved") throw new Error("Expected the explicitly forwarded local");
        expect(namedStar.def.file).toBe(fixture.paths["pkg/right.py"]);
        const warmNamed = resolveExport(fixture.index, fixture.paths["pkg/named.py"]!, "target", {
          allowLocalFallback,
        });
        expect(warmNamed).toEqual(coldNamed);
        const explicit = resolveExport(fixture.index, fixture.paths["pkg/right.py"]!, "target");
        expect(explicit?.kind).toBe("resolved");
        if (explicit?.kind !== "resolved") throw new Error("Expected explicit access to the excluded local");
        expect(explicit.def.file).toBe(fixture.paths["pkg/right.py"]);
        const star = resolveExport(fixture.index, fixture.paths["pkg/facade.py"]!, "target", {
          allowLocalFallback,
        });
        expect(star?.kind).toBe("resolved");
        if (star?.kind !== "resolved") throw new Error("Expected the earlier public star binding");
        expect(star.def.file).toBe(fixture.paths["pkg/left.py"]);
      }
      await assertConsumerAgreement(fixture, {
        file: "pkg/use.py",
        line: 4,
        token: "target",
        expected: { file: "pkg/left.py", line: 1 },
        requireCompleteCoverage: true,
        edges: [{ label: "calls", from: { file: "pkg/use.py", name: "run" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "pkg/use.py",
        line: 4,
        token: "target",
        mustNotMatch: { file: "pkg/right.py", line: 1, token: "target" },
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "pkg/use.py", name: "run" } },
      });
      await assertConsumerAgreement(fixture, {
        file: "pkg/explicit_use.py",
        line: 4,
        token: "target",
        expected: { file: "pkg/right.py", line: 1 },
        requireCompleteCoverage: true,
        edges: [{ label: "calls", from: { file: "pkg/explicit_use.py", name: "run_explicit" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "pkg/explicit_use.py",
        line: 4,
        token: "target",
        mustNotMatch: { file: "pkg/left.py", line: 1, token: "target" },
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "pkg/explicit_use.py", name: "run_explicit" } },
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("keeps a C definition visible past repeated compatible prototypes in an included header", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-c-nested-prototypes-", {
      "one.h": "int target(void);\nstruct Item;\n",
      "two.h": "int target(void);\nstruct Item;\n",
      "mixed.h": '#include "one.h"\n#include "two.h"\n',
      "def.h": "int target(void) { return 1; }\nstruct Item { int value; };\n",
      "outer.h": '#include "mixed.h"\n#include "def.h"\n',
      "decoy.c": "int target(void) { return 2; }\n",
      "main.c": '#include "outer.h"\nint run(void) { return target(); }\n',
    });
    try {
      expect(resolveExport(fixture.index, fixture.paths["mixed.h"]!, "target", { cNamespace: "ordinary" })).toBeNull();
      expect(resolveExport(fixture.index, fixture.paths["mixed.h"]!, "Item", { cNamespace: "tag" })).toBeNull();
      const item = resolveExport(fixture.index, fixture.paths["outer.h"]!, "Item", { cNamespace: "tag" });
      expect(item?.kind).toBe("resolved");
      if (item?.kind === "resolved") expect(item.def.file).toBe(fixture.paths["def.h"]);
      await assertConsumerAgreement(fixture, {
        file: "main.c",
        line: 2,
        token: "target",
        expected: { file: "def.h", line: 1 },
        edges: [{ label: "calls", from: { file: "main.c", name: "run" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "main.c",
        line: 2,
        token: "target",
        mustNotMatch: { file: "decoy.c", line: 1, token: "target" },
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "main.c", name: "run" } },
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("keeps a named re-export ahead of a star decoy when the named path cycles", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-cycle-named-precedence-", {
      "a.ts": "export { target } from './b';\nexport * from './decoy';\n",
      "b.ts": "export * from './a';\nexport * from './def';\n",
      "def.ts": "export function target() { return 1; }\n",
      "decoy.ts": "export function target() { return 2; }\n",
      "consumer.ts": "import { target } from './b';\nexport function run() { return target(); }\n",
    });
    try {
      for (const allowLocalFallback of [false, true]) {
        for (const order of [
          ["a.ts", "b.ts"],
          ["b.ts", "a.ts"],
        ]) {
          fixture.index.exportCache.clear();
          for (const file of order) {
            for (let repeat = 0; repeat < 2; repeat += 1) {
              const hit = resolveExport(fixture.index, fixture.paths[file]!, "target", {
                allowLocalFallback,
                argumentCount: 0,
              });
              expect(hit?.kind).toBe("resolved");
              if (hit?.kind === "resolved") expect(hit.def.file).toBe(fixture.paths["def.ts"]);
            }
          }
        }
      }
      await assertConsumerAgreement(fixture, {
        file: "consumer.ts",
        line: 2,
        token: "target",
        expected: { file: "def.ts", line: 1 },
        edges: [{ label: "calls", from: { file: "consumer.ts", name: "run" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "consumer.ts",
        line: 2,
        token: "target",
        mustNotMatch: { file: "decoy.ts", line: 1, token: "target" },
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "consumer.ts", name: "run" } },
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("does not replace a missing named export with its alias or a star export", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-missing-named-export-", {
      "source.ts": "export function target() { return 1; }\n",
      "decoy.ts": "export function target() { return 2; }\n",
      "facade.ts": "export { missing as target } from './source';\nexport * from './decoy';\n",
      "consumer.ts": "import { target } from './facade';\nexport function run() { return target(); }\n",
    });
    try {
      expect(resolveExport(fixture.index, fixture.paths["facade.ts"]!, "target")).toBeNull();
      const result = await goToDefinition(fixture.index, {
        file: fixture.paths["consumer.ts"]!,
        line: 2,
        column: "export function run() { return target(); }".indexOf("target") + 1,
      });
      expect(result.status).toBe("not_found");
      for (const name of ["source.ts", "decoy.ts"]) {
        const references = await findReferences(fixture.index, { file: fixture.paths[name]!, line: 1, column: 17 });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error(`Expected references for ${name}`);
        expect(references.references.filter((reference) => reference.file === fixture.paths["consumer.ts"])).toEqual(
          [],
        );
      }
    } finally {
      await disposeConsumerAgreementFixture(fixture);
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
