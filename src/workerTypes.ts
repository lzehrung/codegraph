import type Parser from "tree-sitter";

import type { ModuleIndex } from "./indexer.js";
import type { Edge } from "./types.js";
import type { GraphBuildOptions } from "./graphs.js";
import type { WorkspaceConfig } from "./util.js";
import type { LanguageSupport } from "./languages.js";

export type WorkerPreparedInput = {
  source: string;
  sup: LanguageSupport;
  lang: Parser.Language;
};

export type ProcessFileTask = {
  file: string;
  projectRoot: string;
  workspaceConfig?: WorkspaceConfig;
  graphOptions: GraphBuildOptions;
  buildModule: boolean;
  buildGraph: boolean;
};

export type ProcessFileResult = {
  file: string;
  mod: ModuleIndex;
  edges: Edge[];
};
