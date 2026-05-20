import type { Graph } from "../types.js";
import { type SymbolGraph } from "../graphs/symbol-graph.js";

export type SqliteGraphOptions = {
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
  outputPath: string;
};

export type SqliteGraphUpdateOptions = {
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
  outputPath: string;
  changedFiles: string[];
  deletedFiles?: string[];
  /**
   * When true, reconcile DB rows against the provided full graph for changed/deleted files.
   * Use this with full project graphs for accurate incremental CI patching.
   */
  fullGraphSync?: boolean;
};

export type GraphQueryResult =
  | {
      kind: "mostCalledMethods";
      results: Array<{ name: string; file: string; count: number }>;
    }
  | { kind: "dependencyChain"; results: string[] }
  | {
      kind: "controllersMostEndpoints";
      results: Array<{ name: string; file: string; count: number }>;
    }
  | {
      kind: "classesImplementing";
      results: Array<{ name: string; file: string }>;
    }
  | {
      kind: "affectedFunctionsForModule";
      results: Array<{ name: string; file: string }>;
    }
  | {
      kind: "highestComplexityClasses";
      results: Array<{ name: string; file: string; complexity: number }>;
    }
  | {
      kind: "highestComplexityFunctions";
      results: Array<{ name: string; file: string; complexity: number }>;
    };

export type RawSqlResult = {
  columns: string[];
  rows: Array<Array<unknown>>;
  rowLimit?: number;
  byteLimit?: number;
  bytes?: number;
  truncated?: boolean;
};
