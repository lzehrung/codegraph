import type { Edge } from "../types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";

export type GraphBuildOptions = {
  fast?: boolean;
  fastRegexDisabledLanguages?: string[];
  resolveNodeModules?: boolean;
  dynamicImportHeuristics?: boolean;
  resolutionHints?: string[];
  native?: NativeRuntimeMode;
  logLevel?: import("../logging.js").LogLevel;
};

export type GraphCacheEntry = {
  sig: string;
  gitSig?: string;
  sqlCorpusSig?: string;
  edges: Edge[];
};
