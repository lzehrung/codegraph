import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import type { DetailedSymbolGraph } from "../src/graphs/symbol-graph-detailed.js";
import {
  __querySyntaxCacheStatsForTests,
  __setQuerySyntaxCacheLimitsForTests,
  ensureParsedContextForIndex,
} from "../src/indexer/parsed-cache.js";
import { fileIdentityKey } from "../src/util/paths.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../src/native/tree-sitter-native.js";
import { loadBinding } from "../src/native/runtime.js";
import { ProjectedSyntaxTree } from "../src/native/projected-tree.js";

function normalizedGraph(graph: DetailedSymbolGraph) {
  return {
    nodes: [...graph.nodes.values()]
      .map((node) => ({ id: node.id, file: node.file, name: node.name, kind: node.kind }))
      .sort((left, right) => `${left.file}:${left.id}`.localeCompare(`${right.file}:${right.id}`)),
    edges: [...graph.edges].sort((left, right) =>
      `${left.from}:${left.to}:${left.label}`.localeCompare(`${right.from}:${right.to}:${right.label}`),
    ),
  };
}

async function makeIndex(root: string, cacheDir: string) {
  await buildProjectIndex(root, { cache: "disk", cacheDir, keepParsed: false });
  return await buildProjectIndex(root, { cache: "disk", cacheDir, keepParsed: false });
}

describe("bounded query syntax retention", () => {
  it("evicts views and scopes, reuses native columns, and preserves query results", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-retention-"));
    const cacheDir = path.join(root, "cache");
    const libFile = path.join(root, "lib.ts").replace(/\\/g, "/");
    const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
    const libSource = "export function greet(name: string) { return name; }\n";
    const mainSource = 'import { greet } from "./lib";\nexport const call = () => greet("ok");\n';
    try {
      await fsp.writeFile(libFile, libSource, "utf8");
      await fsp.writeFile(mainFile, mainSource, "utf8");
      const index = await makeIndex(root, cacheDir);
      expect(index.parsed).toBeUndefined();

      const state = loadBinding();
      if (!state.loaded) throw new Error("Native addon required for syntax retention test");
      const originalParse = state.binding.parseSyntaxTree;
      if (!originalParse) throw new Error("Native syntax-tree parser required for syntax retention test");
      let parses = 0;
      __setNativeTreeSitterBindingForTests({
        ...state,
        binding: {
          ...state.binding,
          parseSyntaxTree: (source, languageId) => {
            parses += 1;
            return originalParse(source, languageId);
          },
        },
      });
      try {
        const declaration = {
          file: libFile,
          line: 1,
          column: libSource.indexOf("greet") + 1,
        };
        const usage = {
          file: mainFile,
          line: 2,
          column: mainSource.split("\n")[1]!.indexOf("greet") + 1,
        };
        const beforeReferences = await findReferences(index, declaration);
        const beforeGoto = await goToDefinition(index, usage);
        expect(beforeGoto.status).toBe("ok");
        if (beforeGoto.status !== "ok") throw new Error("Expected greet declaration");
        expect(beforeGoto.definition.file).toBe(libFile);
        expect(beforeReferences.status).toBe("ok");
        if (beforeReferences.status !== "ok") throw new Error("Expected greet references");
        expect(beforeReferences.references.map((reference) => reference.file)).toContain(mainFile);
        const beforeGraph = normalizedGraph(await buildSymbolGraphDetailed(index));
        const beforeContext = await ensureParsedContextForIndex(index, libFile);
        const parsesBeforeEviction = parses;
        const beforeStats = __querySyntaxCacheStatsForTests(index);
        expect(beforeStats.compactEntries).toBeGreaterThan(0);
        expect(beforeStats.liveEntries).toBeGreaterThan(0);
        expect(beforeStats.nativeBufferBytes).toBeGreaterThan(0);
        expect(beforeStats.sourceBytes).toBeGreaterThan(0);
        expect(beforeStats.positionMapBytes).toBeGreaterThan(0);
        expect(beforeStats.scopeBytes).toBeGreaterThan(0);
        expect(beforeStats.signatureBytes).toBeGreaterThan(0);
        expect(index.scopeCache.size).toBeGreaterThan(0);

        __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 0 });
        const afterEviction = __querySyntaxCacheStatsForTests(index);
        expect(afterEviction.liveBytes).toBe(0);
        expect(afterEviction.liveEntries).toBe(0);
        expect(afterEviction.scopeBytes).toBe(0);
        expect(afterEviction.projectedNodeBytes).toBe(0);
        expect(afterEviction.compactEntries).toBeGreaterThan(0);
        expect(afterEviction.nativeBufferBytes).toBe(beforeStats.nativeBufferBytes);
        expect(afterEviction.sourceBytes).toBe(beforeStats.sourceBytes);
        expect(afterEviction.positionMapBytes).toBe(beforeStats.positionMapBytes);
        expect(afterEviction.signatureBytes).toBe(beforeStats.signatureBytes);
        expect(index.scopeCache.size).toBe(0);
        const afterEvictionContext = await ensureParsedContextForIndex(index, libFile);
        if (
          !(beforeContext.tree instanceof ProjectedSyntaxTree) ||
          !(afterEvictionContext.tree instanceof ProjectedSyntaxTree)
        ) {
          throw new Error("Expected native projected syntax trees");
        }
        expect(afterEvictionContext.tree).not.toBe(beforeContext.tree);
        expect(afterEvictionContext.tree.columns).toBe(beforeContext.tree.columns);
        expect(afterEvictionContext.tree.byteIndexMap).toBe(beforeContext.tree.byteIndexMap);

        __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 1024 * 1024 });
        const afterReferences = await findReferences(index, declaration);
        const afterGoto = await goToDefinition(index, usage);
        const afterGraph = normalizedGraph(await buildSymbolGraphDetailed(index));
        expect(afterReferences).toEqual(beforeReferences);
        expect(afterGoto).toEqual(beforeGoto);
        expect(afterGraph).toEqual(beforeGraph);
        expect(index.scopeCache.size).toBeGreaterThan(0);
        expect(__querySyntaxCacheStatsForTests(index).scopeBytes).toBeGreaterThan(0);
        expect(parses).toBe(parsesBeforeEviction);

        __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
        expect(__querySyntaxCacheStatsForTests(index)).toMatchObject({
          compactBytes: 0,
          liveBytes: 0,
          entries: 0,
        });
        expect(await findReferences(index, declaration)).toEqual(beforeReferences);
        expect(await goToDefinition(index, usage)).toEqual(beforeGoto);
        expect(parses).toBeGreaterThan(parsesBeforeEviction);
        expect(__querySyntaxCacheStatsForTests(index).entries).toBe(0);
      } finally {
        __resetNativeTreeSitterBindingForTests();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("shares in-flight parses between concurrent reference, goto, and graph users", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-concurrent-"));
    const cacheDir = path.join(root, "cache");
    const libFile = path.join(root, "lib.ts").replace(/\\/g, "/");
    const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
    const libSource = "export function greet(name: string) { return name; }\n";
    const mainSource = 'import { greet } from "./lib";\nexport const call = () => greet("ok");\n';
    try {
      await fsp.writeFile(libFile, libSource, "utf8");
      await fsp.writeFile(mainFile, mainSource, "utf8");
      const index = await makeIndex(root, cacheDir);
      const state = loadBinding();
      if (!state.loaded) throw new Error("Native addon required for concurrent syntax retention test");
      const originalParse = state.binding.parseSyntaxTree;
      if (!originalParse) throw new Error("Native syntax-tree parser required for concurrent syntax retention test");
      const parsesBySource = new Map<string, number>();
      __setNativeTreeSitterBindingForTests({
        ...state,
        binding: {
          ...state.binding,
          parseSyntaxTree: (source, languageId) => {
            const key = source.includes("export function greet") ? "lib" : "main";
            parsesBySource.set(key, (parsesBySource.get(key) ?? 0) + 1);
            return originalParse(source, languageId);
          },
        },
      });
      try {
        __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 0 });
        const declaration = { file: libFile, line: 1, column: libSource.indexOf("greet") + 1 };
        const usage = { file: mainFile, line: 2, column: mainSource.split("\n")[1]!.indexOf("greet") + 1 };
        const concurrentLookups = Promise.all([
          findReferences(index, declaration),
          goToDefinition(index, usage),
          buildSymbolGraphDetailed(index),
        ]);
        const concurrentContexts = Promise.all(
          Array.from({ length: 12 }, () => ensureParsedContextForIndex(index, libFile)),
        );
        const [[references, goto, graph], contexts] = await Promise.all([concurrentLookups, concurrentContexts]);
        expect(contexts.every((context) => context === contexts[0])).toBe(true);
        expect(references.status).toBe("ok");
        expect(goto.status).toBe("ok");
        expect(normalizedGraph(graph).edges.some((edge) => edge.label === "uses")).toBe(true);
        expect(parsesBySource.get("lib")).toBe(1);
        expect(parsesBySource.get("main")).toBe(1);
        expect(__querySyntaxCacheStatsForTests(index).inFlight).toBe(0);
      } finally {
        __resetNativeTreeSitterBindingForTests();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves built-in and shadowed Python super calls when scopes are evicted", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-super-"));
    try {
      await fsp.writeFile(
        path.join(root, "service.py"),
        [
          "class Base:",
          "    def helper(self):",
          "        return 1",
          "class Child(Base):",
          "    def run(self):",
          "        return super().helper()",
          "    def shadowed(self, super):",
          "        return super().helper()",
          "",
        ].join("\n"),
      );
      for (const evict of [false, true]) {
        const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
        if (evict) __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 0 });
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges
          .filter((edge) => edge.label === "calls")
          .map((edge) => ({
            from: graph.nodes.get(edge.from)?.name,
            to: graph.nodes.get(edge.to)?.name,
            line: edge.site?.range.start.line,
          }));
        expect(calls).toEqual([{ from: "run", to: "helper", line: 6 }]);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps edited source and syntax columns isolated to the newly built index", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-edited-"));
    const cacheDir = path.join(root, "cache");
    const file = path.join(root, "lib.ts").replace(/\\/g, "/");
    try {
      await fsp.writeFile(file, "export function beforeEdit() { return 1; }\n", "utf8");
      const oldIndex = await makeIndex(root, cacheDir);
      const oldContext = await ensureParsedContextForIndex(oldIndex, file);
      await fsp.writeFile(file, "export function afterEdit() { return 2; }\n", "utf8");
      const newIndex = await makeIndex(root, cacheDir);
      const newContext = await ensureParsedContextForIndex(newIndex, file);

      expect(oldContext.source).toContain("beforeEdit");
      expect(newContext.source).toContain("afterEdit");
      if (!(oldContext.tree instanceof ProjectedSyntaxTree) || !(newContext.tree instanceof ProjectedSyntaxTree)) {
        throw new Error("Expected native projected syntax trees");
      }
      expect(newContext.tree.columns).not.toBe(oldContext.tree.columns);
      const fileKey = fileIdentityKey(file);
      const oldFileId = oldIndex.byFile.get(fileKey)?.file;
      const newFileId = newIndex.byFile.get(fileKey)?.file;
      const oldSignature = oldFileId ? oldIndex.manifestEntries?.get(oldFileId)?.sig : undefined;
      const newSignature = newFileId ? newIndex.manifestEntries?.get(newFileId)?.sig : undefined;
      expect(oldSignature).toBeDefined();
      expect(newSignature).not.toBe(oldSignature);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
