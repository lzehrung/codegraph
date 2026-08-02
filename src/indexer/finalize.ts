import { performance } from "node:perf_hooks";
import { buildGraphAdjacency } from "../graphs/adjacency.js";
import { discoverProjectFiles, type ProjectFileInfo } from "../util/projectFiles.js";
import type { FileId, Graph } from "../types.js";
import type { BloomFilterCache } from "../util/bloomFilter.js";
import type { ParsedFileContext } from "./parse-context.js";
import { retainedParsedCache } from "./parsed-cache.js";
import { buildReferenceCandidateIndex } from "./reference-candidates.js";
import { cacheRoot } from "./build-cache/module-cache.js";
import type { BuildOptions, BuildReport, ModuleIndex, ProjectIndex, ProjectIndexManifestEntry } from "./types.js";

export async function finalizeProjectIndex(args: {
  projectRoot: string;
  normalizedProjectRoot: string;
  opts: BuildOptions | undefined;
  timings: BuildReport["timings"] | undefined;
  totalStart: number;
  graph: Graph;
  modules: Map<FileId, ModuleIndex>;
  parsedMap: Map<string, ParsedFileContext>;
  bloomFilterCache: BloomFilterCache | undefined;
  projectFiles?: ProjectFileInfo[] | Promise<ProjectFileInfo[]>;
  manifestEntries?: Map<FileId, ProjectIndexManifestEntry>;
  buildReport?: BuildReport | undefined;
}): Promise<ProjectIndex> {
  if (args.timings) args.timings.totalMs = Math.round(performance.now() - args.totalStart);
  const projectFiles = await (args.projectFiles ??
    discoverProjectFiles(args.projectRoot, {
      ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
    }));
  const parsed = retainedParsedCache(args.parsedMap, args.opts);
  return {
    graph: args.graph,
    graphAdjacency: buildGraphAdjacency(args.graph),
    modules: args.modules,
    byFile: args.modules,
    projectRoot: args.normalizedProjectRoot,
    ...(args.opts?.native ? { nativeMode: args.opts.native } : {}),
    exportCache: new Map(),
    scopeCache: new Map(),
    ...(parsed ? { parsed } : {}),
    ...(args.bloomFilterCache ? { bloomFilters: args.bloomFilterCache } : {}),
    projectFiles,
    referenceCandidates: buildReferenceCandidateIndex(args.modules),
    ...(args.manifestEntries ? { manifestEntries: args.manifestEntries } : {}),
    ...(args.manifestEntries ? { manifestSignaturesFresh: true } : {}),
    ...(args.buildReport ? { buildReport: args.buildReport } : {}),
    ...(args.opts?.cache ? { cacheMode: args.opts.cache, cacheRootDir: cacheRoot(args.projectRoot, args.opts) } : {}),
  };
}
