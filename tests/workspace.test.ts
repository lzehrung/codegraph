import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  collectGraph,
  findReferences,
  goToDefinition,
} from "../src/index.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../src/indexer/build-cache.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { mkTmpDir, readOnlySamplePath } from "./helpers/filesystem.js";

/* Minimal smoke tests to validate workspace detection wiring. Full fixtures are created in tests/samples/monorepo in a later step. */

describe("Monorepo workspace support", () => {
  const root = readOnlySamplePath("monorepo");

  const cacheModes = (["memory", "disk"] as const).flatMap((cache) =>
    (["full", "incremental"] as const).map((api) => ({ cache, api })),
  );

  it.each(cacheModes)("keeps workspace edges current across changes ($cache, $api)", async ({ cache, api }) => {
    const project = await mkTmpDir("cg-workspace-lifecycle-");
    const options = { cache, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
    const rootManifest = path.join(project, "package.json");
    const aManifest = path.join(project, "packages/a/package.json");
    const bManifest = path.join(project, "packages/b/package.json");
    const cManifest = path.join(project, "packages/c/package.json");
    const target = path.join(project, "packages/a/src/index.js");
    const consumer = path.join(project, "packages/b/src/index.js");
    const consumerText = 'import { target } from "../../a/src/index.js";\nexport function run() { return target(); }\n';
    const bBoth = JSON.stringify({ name: "@fixture/b", dependencies: { "@fixture/a": "*", "@fixture/c": "*" } });
    const bC = JSON.stringify({ name: "@fixture/b", dependencies: { "@fixture/c": "*" } });
    const cOriginal = JSON.stringify({ name: "@fixture/c" });
    const write = async (file: string, contents: string): Promise<void> => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, contents);
    };
    const graphEdges = (index: ProjectIndex): string[] => index.graph.edges.map((edge) => JSON.stringify(edge)).sort();
    const detailedEdges = async (index: ProjectIndex): Promise<string[]> =>
      (await buildSymbolGraphDetailed(index)).edges.map((edge) => JSON.stringify(edge)).sort();
    const check = async (expected: readonly string[]): Promise<void> => {
      const warm =
        api === "full"
          ? await buildProjectIndex(project, options)
          : await buildProjectIndexIncremental(project, options);
      const cold = await buildProjectIndex(project, { ...options, cache: "off" });
      expect(graphEdges(warm)).toEqual(graphEdges(cold));
      expect(await detailedEdges(warm)).toEqual(await detailedEdges(cold));
      const workspaceTargets = warm.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(bManifest))
        .map((edge) => edge.raw)
        .sort();
      expect(workspaceTargets).toEqual([...expected].sort());
      const request = { file: consumer, line: 2, column: consumerText.split("\n")[1]!.indexOf("target") + 1 };
      const goto = await goToDefinition(warm, request);
      expect(goto).toEqual(await goToDefinition(cold, request));
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected the relative import to resolve");
      expect(normalizePath(goto.definition.file)).toBe(normalizePath(target));
      const refs = await findReferences(warm, { file: target, line: 1, column: 17 });
      expect(refs).toEqual(await findReferences(cold, { file: target, line: 1, column: 17 }));
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Expected references for target");
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(refs.references.some((ref) => fileIdentityKey(ref.file) === fileIdentityKey(consumer))).toBe(true);
      if (cache === "disk") {
        closeDiskCacheDatabase(project, options);
        clearMemoryCache();
      }
    };
    try {
      await write(rootManifest, JSON.stringify({ name: "@fixture/root", private: true, workspaces: ["packages/*"] }));
      await write(aManifest, JSON.stringify({ name: "@fixture/a" }));
      await write(bManifest, bBoth);
      await write(target, "export function target() { return 1; }\n");
      await write(consumer, consumerText);
      await check(["@fixture/a"]);
      await fsp.appendFile(consumer, "// edit\n");
      await check(["@fixture/a"]);
      await fsp.utimes(bManifest, 0, 0);
      await check(["@fixture/a"]);
      await write(cManifest, cOriginal);
      await check(["@fixture/a", "@fixture/c"]);
      await write(bManifest, bC);
      await check(["@fixture/c"]);
      await fsp.unlink(cManifest);
      await check([]);
      await write(cManifest, cOriginal);
      await check(["@fixture/c"]);
      await write(cManifest, JSON.stringify({ name: "@fixture/renamed" }));
      await check([]);
      await write(cManifest, cOriginal);
      await check(["@fixture/c"]);
    } finally {
      closeDiskCacheDatabase(project, options);
      clearMemoryCache();
      await fsp.rm(project, { recursive: true, force: true });
    }
  });

  it.each(cacheModes)("resolves duplicate package names in path order ($cache, $api)", async ({ cache, api }) => {
    const project = await mkTmpDir("cg-workspace-duplicate-");
    const options = { cache, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
    const rootManifest = path.join(project, "package.json");
    const user = path.join(project, "packages/user/package.json");
    const earlier = path.join(project, "packages/a-dup/package.json");
    const middle = path.join(project, "packages/m-dup/package.json");
    const later = path.join(project, "packages/z-dup/package.json");
    const write = async (file: string, contents: string): Promise<void> => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, contents);
    };
    const check = async (target: string): Promise<void> => {
      const warm =
        api === "full"
          ? await buildProjectIndex(project, options)
          : await buildProjectIndexIncremental(project, options);
      const cold = await buildProjectIndex(project, { ...options, cache: "off" });
      const edges = (index: ProjectIndex): string[] => index.graph.edges.map((edge) => JSON.stringify(edge)).sort();
      expect(edges(warm)).toEqual(edges(cold));
      const targets = warm.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(user) && edge.raw === "dup")
        .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : edge.to.name));
      expect(targets).toEqual([fileIdentityKey(target)]);
      if (cache === "disk") {
        closeDiskCacheDatabase(project, options);
        clearMemoryCache();
      }
    };
    try {
      await write(rootManifest, JSON.stringify({ private: true, workspaces: ["packages/*"] }));
      await write(user, JSON.stringify({ name: "user", dependencies: { dup: "*" } }));
      await write(middle, JSON.stringify({ name: "dup" }));
      await check(middle);
      await write(earlier, JSON.stringify({ name: "dup" }));
      await check(middle);
      await write(later, JSON.stringify({ name: "dup" }));
      await check(later);
      await fsp.unlink(later);
      await check(middle);
      await fsp.unlink(middle);
      await check(earlier);
      await write(later, JSON.stringify({ name: "dup" }));
      await check(later);
    } finally {
      closeDiskCacheDatabase(project, options);
      clearMemoryCache();
      await fsp.rm(project, { recursive: true, force: true });
    }
  });

  it.each(cacheModes)("updates non-workspace package manifests ($cache, $api)", async ({ cache, api }) => {
    const project = await mkTmpDir("cg-non-workspace-lifecycle-");
    const options = { cache, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
    const rootManifest = path.join(project, "package.json");
    const packageA = path.join(project, "packages/a/package.json");
    const toolOne = path.join(project, "tools/one/package.json");
    const toolTwo = path.join(project, "tools/two/package.json");
    const source = path.join(project, "entry.js");
    const write = async (file: string, contents: string): Promise<void> => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, contents);
    };
    const check = async (target: string | undefined): Promise<void> => {
      const warm =
        api === "full"
          ? await buildProjectIndex(project, options)
          : await buildProjectIndexIncremental(project, options);
      const cold = await buildProjectIndex(project, { ...options, cache: "off" });
      const edges = (index: ProjectIndex): string[] => index.graph.edges.map((edge) => JSON.stringify(edge)).sort();
      expect(edges(warm)).toEqual(edges(cold));
      const targets = warm.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(toolOne))
        .map((edge) => (edge.to.type === "file" ? fileIdentityKey(edge.to.path) : edge.to.name));
      expect(targets).toEqual(target ? [fileIdentityKey(target)] : []);
      if (cache === "disk") {
        closeDiskCacheDatabase(project, options);
        clearMemoryCache();
      }
    };
    try {
      await write(rootManifest, JSON.stringify({ private: true, workspaces: ["packages/*"] }));
      await write(packageA, JSON.stringify({ name: "@fixture/a" }));
      await write(toolOne, JSON.stringify({ name: "one", dependencies: { "@fixture/a": "*" } }));
      await write(source, "export const entry = 1;\n");
      await check(packageA);
      await fsp.appendFile(source, "// edit\n");
      await check(packageA);
      await write(toolTwo, JSON.stringify({ name: "two" }));
      await write(toolOne, JSON.stringify({ name: "one", dependencies: { two: "*" } }));
      await check(toolTwo);
      await fsp.unlink(toolTwo);
      await check(undefined);
      await write(toolTwo, JSON.stringify({ name: "two" }));
      await check(toolTwo);
      await fsp.unlink(toolOne);
      await check(undefined);
    } finally {
      closeDiskCacheDatabase(project, options);
      clearMemoryCache();
      await fsp.rm(project, { recursive: true, force: true });
    }
  });

  const invalidSnapshots = ["missing", "corrupt", "invalid-graph", "invalid-modules"] as const;
  it.each(invalidSnapshots)("recomputes workspace edges for %s snapshot", async (state) => {
    const project = await mkTmpDir("cg-workspace-snapshot-");
    const options = { cache: "disk" as const, threads: 1, useNativeWorkers: false, logLevel: "silent" as const };
    const a = path.join(project, "a/package.json");
    const b = path.join(project, "b/package.json");
    const source = path.join(project, "entry.js");
    const snapshot = path.join(project, ".codegraph/cache/index-v1/project-index-snapshot.json");
    try {
      await fsp.mkdir(path.dirname(a), { recursive: true });
      await fsp.mkdir(path.dirname(b), { recursive: true });
      await fsp.writeFile(a, JSON.stringify({ name: "@fixture/a" }));
      await fsp.writeFile(b, JSON.stringify({ name: "@fixture/b", dependencies: { "@fixture/a": "*" } }));
      await fsp.writeFile(source, "export const entry = 1;\n");
      await buildProjectIndexIncremental(project, options);
      if (state === "missing") await fsp.unlink(snapshot);
      else if (state === "corrupt") await fsp.writeFile(snapshot, "invalid snapshot");
      else {
        const payload = JSON.parse(brotliDecompressSync(await fsp.readFile(snapshot)).toString("utf8")) as {
          graph: { nodes: unknown; edges: unknown };
          modules: unknown;
        };
        payload.graph.edges = [];
        if (state === "invalid-graph") payload.graph.nodes = [42];
        else payload.modules = null;
        await fsp.writeFile(snapshot, brotliCompressSync(JSON.stringify(payload)));
      }
      await fsp.appendFile(source, "// edited\n");
      const warm = await buildProjectIndexIncremental(project, options);
      const cold = await buildProjectIndex(project, { ...options, cache: "off" });
      const edges = (index: ProjectIndex): string[] => index.graph.edges.map((edge) => JSON.stringify(edge)).sort();
      expect(edges(warm)).toEqual(edges(cold));
      expect(warm.graph.edges).toContainEqual({
        from: normalizePath(b),
        to: { type: "file", path: normalizePath(a) },
        raw: "@fixture/a",
      });
    } finally {
      closeDiskCacheDatabase(project, options);
      clearMemoryCache();
      await fsp.rm(project, { recursive: true, force: true });
    }
  });

  it("loads workspace config and resolves cross-package imports", async () => {
    const index = await buildProjectIndex(root, { cache: "off" });
    expect(index).toBeDefined();

    // Ensure both packages are indexed
    const files = [...index.byFile.keys()];
    const hasPkgA = files.some((f) => f.includes("packages/pkg-a/src/index.ts"));
    const hasPkgB = files.some((f) => f.includes("packages/pkg-b/src/index.js"));
    expect(hasPkgA && hasPkgB).toBe(true);
  });

  it("creates graph edges from pkg-b to pkg-a via workspace resolution", async () => {
    const files = [
      path.join(root, "packages", "pkg-a", "src", "index.ts"),
      path.join(root, "packages", "pkg-b", "src", "index.js"),
    ];
    const graph = await collectGraph(root, files);
    const edge = graph.edges.find((e) => e.from.endsWith("packages/pkg-b/src/index.js") && e.raw === "@acme/pkg-a");
    expect(edge).toBeTruthy();
    expect(edge?.to.type).toBe("file");
  });

  it("per-package tsconfig paths: pkg-ts-consumer local alias and cross-package import", async () => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const packageA = path.join(root, "packages", "pkg-a", "src", "index.ts");
    const packageConsumer = path.join(root, "packages", "pkg-ts-consumer", "src", "index.ts");
    const packageUtil = path.join(root, "packages", "pkg-ts-consumer", "src", "util.ts");

    // Ensure consumer and util are indexed
    const files = [...index.byFile.keys()].map((file) => file.replace(/\\/g, "/"));
    expect(files.some((file) => file.endsWith("packages/pkg-ts-consumer/src/index.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("packages/pkg-ts-consumer/src/util.ts"))).toBe(true);

    // Graph should resolve @acme/pkg-a and @local/util from consumer
    const consumer = packageConsumer.replace(/\\/g, "/");
    const graph = index.graph;
    const edgeToPkgA = graph.edges.find((edge) => edge.from === consumer && edge.raw === "@acme/pkg-a");
    const edgeToLocal = graph.edges.find((edge) => edge.from === consumer && edge.raw === "@local/util");
    expect(edgeToPkgA).toBeDefined();
    expect(edgeToPkgA?.to.type).toBe("file");
    if (edgeToPkgA?.to.type === "file") {
      expect(edgeToPkgA.to.path.replace(/\\/g, "/")).toBe(packageA.replace(/\\/g, "/"));
    }
    expect(edgeToLocal).toBeDefined();
    expect(edgeToLocal?.to.type).toBe("file");
    if (edgeToLocal?.to.type === "file") {
      expect(edgeToLocal.to.path.replace(/\\/g, "/")).toBe(packageUtil.replace(/\\/g, "/"));
    }

    // Go to def for aHelper usage from pkg-a (line 5: return defA() + aHelper() + localUtil())
    const packageResult = await goToDefinition(index, {
      file: packageConsumer.replace(/\\/g, "/"),
      line: 5,
      column: 24,
    });
    expect(packageResult.status).toBe("ok");
    if (packageResult.status === "ok") {
      expect(packageResult.definition.file.replace(/\\/g, "/")).toBe(packageA.replace(/\\/g, "/"));
    }

    // Go to def for localUtil via @local alias (usage on line 5)
    const localResult = await goToDefinition(index, {
      file: packageConsumer.replace(/\\/g, "/"),
      line: 5,
      column: 38,
    });
    expect(localResult.status).toBe("ok");
    if (localResult.status === "ok") {
      expect(localResult.definition.file.replace(/\\/g, "/")).toContain("packages/pkg-ts-consumer/src/util.ts");
    }
  });
});
