import { normalizeLanguageExtensions } from "../languages.js";
import { buildGraphAdjacency } from "../graphs/adjacency.js";
import { performance } from "node:perf_hooks";
import {
  discoverProjectFilesWithGitCandidates,
  type GitCandidateSet,
  type ProjectDiscoveryContext,
  type ProjectFileInfo,
} from "../util/projectFiles.js";
import type { FileId, Graph } from "../types.js";
import type { BloomFilterCache } from "../util/bloomFilter.js";
import type { ParsedFileContext } from "./parse-context.js";
import { retainedParsedCache } from "./parsed-cache.js";
import { buildReferenceCandidateIndex } from "./reference-candidates.js";
import { cacheRoot } from "./build-cache/location.js";
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
  knownGitCandidates?: GitCandidateSet | null;
  discoveryContext?: ProjectDiscoveryContext;
  manifestEntries?: Map<FileId, ProjectIndexManifestEntry>;
  buildReport?: BuildReport | undefined;
}): Promise<ProjectIndex> {
  const discoveryTimings = args.opts?.report ? (args.opts.report.timings ??= {}) : undefined;
  let projectFiles: ProjectFileInfo[];
  if (args.projectFiles !== undefined) {
    projectFiles = await args.projectFiles;
  } else {
    const metadataDiscoveryStart = performance.now();
    projectFiles = await discoverProjectFilesWithGitCandidates(args.projectRoot, {
      ...(args.opts?.logLevel ? { logLevel: args.opts.logLevel } : {}),
      ...(args.knownGitCandidates !== undefined ? { knownGitCandidates: args.knownGitCandidates } : {}),
      ...(args.discoveryContext ? { discoveryContext: args.discoveryContext } : {}),
    });
    if (discoveryTimings) {
      const metadataDiscoveryMs = Math.round(performance.now() - metadataDiscoveryStart);
      discoveryTimings.metadataDiscoveryMs = metadataDiscoveryMs;
      (discoveryTimings.steps ??= []).push({ name: "metadata-discovery", ms: metadataDiscoveryMs });
    }
  }
  if (args.timings) args.timings.totalMs = Math.round(performance.now() - args.totalStart);
  const languageExtensions = normalizeLanguageExtensions(args.opts?.languageExtensions);
  const parsed = retainedParsedCache(args.parsedMap, args.opts);
  return {
    projectRoot: args.normalizedProjectRoot,
    graph: args.graph,
    graphAdjacency: buildGraphAdjacency(args.graph),
    modules: args.modules,
    byFile: args.modules,
    ...(languageExtensions ? { languageExtensions } : {}),
    exportCache: new Map(),
    scopeCache: new Map(),
    ...(args.opts?.native ? { nativeMode: args.opts.native } : {}),
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
