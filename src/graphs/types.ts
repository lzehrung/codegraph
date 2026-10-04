import type { Edge } from "../types.js";

export type GraphBuildOptions = {
  fast?: boolean;
  resolveNodeModules?: boolean;
  dynamicImportHeuristics?: boolean;
  resolutionHints?: string[];
  logLevel?: import("../logging.js").LogLevel;
};

export type GraphCacheEntry = {
  sig: string;
  gitSig?: string;
  sqlCorpusSig?: string;
  edges: Edge[];
};
