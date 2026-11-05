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
import { getOrBuildScopeIndex } from "../src/indexer/navigation-local.js";
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
        expect(beforeStats.sourceIdentityEntries).toBe(2);
        expect(beforeStats.sourceIdentityMetadataBytes).toBeGreaterThan(0);
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
        expect(__querySyntaxCacheStatsForTests(index).sourceIdentityEntries).toBe(2);
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

  it("preserves Python runtime import rebinding when the owning scope is evicted", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-python-rebinding-"));
    const mainFile = path.join(root, "main.py").replace(/\\/g, "/");
    const otherFile = path.join(root, "other.py").replace(/\\/g, "/");
    const mainLines = [
      "def helper():",
      "    return 1",
      "def run():",
      "    return helper()",
      "from other import helper",
      "",
    ];
    try {
      await fsp.writeFile(mainFile, mainLines.join("\n"), "utf8");
      await fsp.writeFile(otherFile, "def helper():\n    return 2\n", "utf8");
      const localSitesByRetention: string[][] = [];
      for (const evict of [true, false]) {
        const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
        if (evict) __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 0 });
        const usage = { file: mainFile, line: 4, column: mainLines[3]!.indexOf("helper") + 1 };
        const goto = await goToDefinition(index, usage);
        expect(goto.status).toBe("ok");
        if (goto.status !== "ok") throw new Error("Expected the imported helper");
        expect(goto.definition.file).toBe(otherFile);

        const imported = await findReferences(index, { file: otherFile, line: 1, column: 5 });
        expect(imported.status).toBe("ok");
        if (imported.status !== "ok") throw new Error("Expected imported helper references");
        const importedRun = imported.references.some(
          (reference) => reference.file === mainFile && reference.range.start.line === 4,
        );
        expect(importedRun).toBe(true);
        const local = await findReferences(index, { file: mainFile, line: 1, column: 5 });
        expect(local.status).toBe("ok");
        if (local.status !== "ok") throw new Error("Expected local helper references");
        localSitesByRetention.push(
          local.references.map((reference) => `${reference.file}:${reference.range.start.line}`),
        );

        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter(
          (edge) =>
            edge.label === "calls" && graph.nodes.get(edge.from)?.name === "run" && edge.site?.range.start.line === 4,
        );
        expect(calls).toHaveLength(1);
        expect(graph.nodes.get(calls[0]!.to)?.file).toBe(otherFile);
      }
      expect(localSitesByRetention[0]).toEqual(localSitesByRetention[1]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["off", "disk"] as const)(
    "rejects changed previously queried source after eviction with %s cache",
    async (cache) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-stale-"));
      const libFile = path.join(root, "lib.ts").replace(/\\/g, "/");
      const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
      const libSource = "export function greet() { return 1; }\nexport function other() { return 2; }\n";
      const mainSource = 'import { greet, other } from "./lib";\nexport function run() { return greet(); }\n';
      const editedSource = mainSource.replace("return greet()", "return other()");
      try {
        await fsp.writeFile(libFile, libSource, "utf8");
        await fsp.writeFile(mainFile, mainSource, "utf8");
        await fsp.utimes(mainFile, 1_700_000_000, 1_700_000_000);
        const index =
          cache === "disk"
            ? await makeIndex(root, path.join(root, "cache"))
            : await buildProjectIndex(root, { cache: "off", keepParsed: false });
        const usage = { file: mainFile, line: 2, column: mainSource.split("\n")[1]!.indexOf("greet") + 1 };
        const declaration = { file: libFile, line: 1, column: libSource.indexOf("greet") + 1 };
        const before = await goToDefinition(index, usage);
        expect(before.status === "ok" && before.definition.file).toBe(libFile);
        const previousContext = await ensureParsedContextForIndex(index, mainFile);
        const references = await findReferences(index, declaration);
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected references before the edit");
        expect(references.references.some((reference) => reference.file === mainFile)).toBe(true);
        await buildSymbolGraphDetailed(index);

        const originalStat = await fsp.stat(mainFile);
        expect(Buffer.byteLength(editedSource)).toBe(Buffer.byteLength(mainSource));
        await fsp.writeFile(mainFile, editedSource, "utf8");
        await fsp.utimes(mainFile, originalStat.atimeMs / 1000, originalStat.mtimeMs / 1000);
        const editedStat = await fsp.stat(mainFile);
        expect(editedStat.size).toBe(originalStat.size);
        expect(editedStat.mtimeMs).toBe(originalStat.mtimeMs);
        __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
        await expect(goToDefinition(index, usage)).rejects.toMatchObject({
          name: "StaleQuerySourceError",
          message: expect.stringMatching(/rebuild/i),
        });
        await expect(goToDefinition(index, usage, previousContext)).rejects.toThrow(/rebuild/i);
        await expect(findReferences(index, declaration)).rejects.toThrow(/rebuild/i);
        await expect(buildSymbolGraphDetailed(index)).rejects.toThrow(/rebuild/i);
        const rebuilt = await buildProjectIndex(root, { cache: "off", keepParsed: false });
        const current = await goToDefinition(rebuilt, usage);
        expect(current.status).toBe("ok");
        if (current.status !== "ok") throw new Error("Expected the rebuilt import target");
        expect(current.definition.localName).toBe("other");

        await fsp.writeFile(mainFile, mainSource, "utf8");
        await fsp.utimes(mainFile, originalStat.atimeMs / 1000, originalStat.mtimeMs / 1000);
        await expect(goToDefinition(index, usage)).rejects.toThrow(/rebuild/i);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a deleted previously queried file after eviction", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-deleted-"));
    const file = path.join(root, "main.ts").replace(/\\/g, "/");
    const source = "export function helper() { return 1; }\nexport function run() { return helper(); }\n";
    try {
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      const usage = { file, line: 2, column: source.split("\n")[1]!.indexOf("helper") + 1 };
      expect((await goToDefinition(index, usage)).status).toBe("ok");
      __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
      await fsp.unlink(file);
      await expect(goToDefinition(index, usage)).rejects.toThrow(/rebuild/i);
      await expect(buildSymbolGraphDetailed(index)).rejects.toThrow(/rebuild/i);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("continues using explicitly retained build-time syntax after a source edit", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-keep-parsed-"));
    const file = path.join(root, "main.ts").replace(/\\/g, "/");
    const source = [
      "export function alpha() { return 1; }",
      "export function omega() { return 2; }",
      "export function run() { return alpha(); }",
      "",
    ].join("\n");
    try {
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: true, useNativeWorkers: false });
      expect(index.parsed?.has(fileIdentityKey(file))).toBe(true);
      const usage = { file, line: 3, column: source.split("\n")[2]!.indexOf("alpha") + 1 };
      const before = await goToDefinition(index, usage);
      expect(before.status).toBe("ok");
      __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
      await fsp.writeFile(file, source.replace("return alpha()", "return omega()"), "utf8");
      expect(await goToDefinition(index, usage)).toEqual(before);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("evicts C# partial-owner trees instead of retaining them outside the query cache", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-csharp-owners-"));
    const partA = path.join(root, "A.cs").replace(/\\/g, "/");
    const partB = path.join(root, "B.cs").replace(/\\/g, "/");
    const useFile = path.join(root, "Use.cs").replace(/\\/g, "/");
    const partSource = [
      "namespace P;",
      "public partial class First {}",
      "public partial class Second {}",
      "public partial class Third {}",
      "",
    ].join("\n");
    const useLines = [
      "namespace P;",
      "class Consumer {",
      "  First MakeFirst() => new First();",
      "  Second MakeSecond() => new Second();",
      "  Third MakeThird() => new Third();",
      "}",
      "",
    ];
    try {
      await fsp.writeFile(partA, `// part A\n${partSource}`, "utf8");
      await fsp.writeFile(partB, `// part B\n${partSource}`, "utf8");
      await fsp.writeFile(useFile, useLines.join("\n"), "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
      const state = loadBinding();
      if (!state.loaded) throw new Error("Native addon required for C# retention test");
      const originalParse = state.binding.parseSyntaxTree;
      if (!originalParse) throw new Error("Native syntax-tree parser required for C# retention test");
      let ownerParses = 0;
      __setNativeTreeSitterBindingForTests({
        ...state,
        binding: {
          ...state.binding,
          parseSyntaxTree: (source, languageId) => {
            if (source.includes("public partial class First")) ownerParses += 1;
            return originalParse(source, languageId);
          },
        },
      });
      try {
        const first = await goToDefinition(index, {
          file: useFile,
          line: 3,
          column: useLines[2]!.indexOf("new First") + 5,
        });
        expect(first.status).toBe("ok");
        if (first.status !== "ok") throw new Error("Expected the first partial type");
        expect([partA, partB]).toContain(first.definition.file);
        const parsesAfterFirst = ownerParses;
        expect(parsesAfterFirst).toBeGreaterThanOrEqual(2);
        expect(__querySyntaxCacheStatsForTests(index).entries).toBe(0);

        const second = await goToDefinition(index, {
          file: useFile,
          line: 4,
          column: useLines[3]!.indexOf("new Second") + 5,
        });
        expect(second.status).toBe("ok");
        if (second.status !== "ok") throw new Error("Expected the second partial type");
        expect([partA, partB]).toContain(second.definition.file);
        expect(ownerParses).toBeGreaterThan(parsesAfterFirst);
        expect(__querySyntaxCacheStatsForTests(index).entries).toBe(0);

        await fsp.writeFile(partA, `// part X\n${partSource}`, "utf8");
        await expect(
          goToDefinition(index, {
            file: useFile,
            line: 5,
            column: useLines[4]!.indexOf("new Third") + 5,
          }),
        ).rejects.toMatchObject({ name: "StaleQuerySourceError" });
      } finally {
        __resetNativeTreeSitterBindingForTests();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps compact columns aligned with a live view when an older caller races a reparse", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-pending-owner-"));
    const file = path.join(root, "main.ts").replace(/\\/g, "/");
    const source = "export function helper() { return 1; }\nexport function run() { return helper(); }\n";
    try {
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      const previous = await ensureParsedContextForIndex(index, file);
      const module = index.byFile.get(fileIdentityKey(file));
      if (!module) throw new Error("Expected indexed module");
      __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
      __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 16 * 1024 * 1024, liveBytes: 16 * 1024 * 1024 });

      const pending = ensureParsedContextForIndex(index, file);
      getOrBuildScopeIndex(index, file, previous.source, previous.sup, module, previous.tree);
      await pending;
      const live = await ensureParsedContextForIndex(index, file);
      if (!(live.tree instanceof ProjectedSyntaxTree)) throw new Error("Expected a native projected tree");
      __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 0 });
      const restored = await ensureParsedContextForIndex(index, file);
      if (!(restored.tree instanceof ProjectedSyntaxTree)) throw new Error("Expected reconstructed native columns");
      expect(restored.tree.columns).toBe(live.tree.columns);
      expect(restored.tree.byteIndexMap).toBe(live.tree.byteIndexMap);
      const usage = { file, line: 2, column: source.split("\n")[1]!.indexOf("helper") + 1 };
      const goto = await goToDefinition(index, usage);
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected the helper declaration");
      expect(goto.definition.range.start.line).toBe(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an in-flight parse when the index signature changes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-pending-signature-"));
    const file = path.join(root, "main.ts").replace(/\\/g, "/");
    const source = "export function helper() { return 1; }\nexport function run() { return helper(); }\n";
    try {
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      const entries = index.manifestEntries;
      const original = entries?.get(file);
      if (!entries || !original) throw new Error("Expected an indexed file signature");
      const pending = ensureParsedContextForIndex(index, file);
      entries.set(file, { ...original, sig: `${original.sig}:changed` });
      await expect(pending).rejects.toMatchObject({ name: "StaleQuerySourceError" });
      entries.set(file, original);
      const usage = { file, line: 2, column: source.split("\n")[1]!.indexOf("helper") + 1 };
      await expect(goToDefinition(index, usage)).rejects.toThrow(/rebuild/i);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses Unicode and lone-CR position maps after view eviction", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-byte-map-"));
    const file = path.join(root, "main.ts").replace(/\\/g, "/");
    const lines = [
      'const message = "\u00e9\u{1f642}";',
      "export function greet() { return message; }",
      "export function run() { return greet(); }",
      "",
    ];
    try {
      await fsp.writeFile(file, lines.join("\r"), "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      const usage = { file, line: 3, column: lines[2]!.indexOf("greet") + 1 };
      const declaration = { file, line: 2, column: lines[1]!.indexOf("greet") + 1 };
      const before = await ensureParsedContextForIndex(index, file);
      if (!(before.tree instanceof ProjectedSyntaxTree)) throw new Error("Expected a native projected tree");
      expect(before.tree.byteIndexMap.byteToStringIndex.byteLength).toBeGreaterThan(0);
      expect(before.tree.byteIndexMap.loneCrLineStarts).toBeDefined();
      const goto = await goToDefinition(index, usage);
      expect(goto.status).toBe("ok");
      const references = await findReferences(index, declaration);
      expect(references.status).toBe("ok");

      __setQuerySyntaxCacheLimitsForTests(index, { liveBytes: 0 });
      const restored = await ensureParsedContextForIndex(index, file);
      if (!(restored.tree instanceof ProjectedSyntaxTree)) throw new Error("Expected reconstructed native columns");
      expect(restored.tree.byteIndexMap).toBe(before.tree.byteIndexMap);
      expect(await goToDefinition(index, usage)).toEqual(goto);
      expect(await findReferences(index, declaration)).toEqual(references);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("tracks graph-only source identities without retaining a native tree", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-graph-only-"));
    const file = path.join(root, "notes.md").replace(/\\/g, "/");
    const source = "# Notes\n\n[Guide](guide.md)\n";
    try {
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      const before = await ensureParsedContextForIndex(index, file);
      expect(before.tree).not.toBeInstanceOf(ProjectedSyntaxTree);
      expect(before.source).toBe(source);
      __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
      expect(__querySyntaxCacheStatsForTests(index)).toMatchObject({
        entries: 0,
        sourceIdentityEntries: 1,
      });
      expect((await ensureParsedContextForIndex(index, file)).source).toBe(source);
      await fsp.writeFile(file, source.replace("Guide", "Other"), "utf8");
      await expect(ensureParsedContextForIndex(index, file)).rejects.toThrow(/rebuild/i);
      await expect(buildSymbolGraphDetailed(index)).rejects.toThrow(/rebuild/i);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("detects component edits outside the projected script after eviction", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-query-syntax-component-"));
    const file = path.join(root, "Widget.vue").replace(/\\/g, "/");
    const lines = [
      "<template><div>alpha</div></template>",
      '<script lang="ts">',
      "export function greet() { return 1; }",
      "export function run() { return greet(); }",
      "</script>",
      "",
    ];
    try {
      const source = lines.join("\n");
      await fsp.writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      const usage = { file, line: 4, column: lines[3]!.indexOf("greet") + 1 };
      expect((await goToDefinition(index, usage)).status).toBe("ok");
      __setQuerySyntaxCacheLimitsForTests(index, { compactBytes: 0, liveBytes: 0 });
      await fsp.writeFile(file, source.replace("alpha", "omega"), "utf8");
      await expect(goToDefinition(index, usage)).rejects.toThrow(/rebuild/i);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
