import type { Edge } from "../types.js";

export type GraphBuildOptions = {
  resolveNodeModules?: boolean;
  dynamicImportHeuristics?: boolean;
  resolutionHints?: string[];
  logLevel?: import("../logging.js").LogLevel;
};

export type GraphCacheEntry = {
  sig: string;
  gitSig?: string;
  sqlCorpusSig?: string;
  /**
   * Public-surface signature of the file as of the build that wrote this entry (see
   * `indexer/public-surface.ts`). Written by builds that keep a manifest; absent for files whose
   * dependents always rebuild with them, and in manifests written before the field existed.
   */
  surface?: string;
  edges: Edge[];
};
