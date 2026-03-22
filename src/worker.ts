import Parser from "tree-sitter";

import { collectEdgesForFile } from "./graphs.js";
import { prepareParserInput } from "./languages/filePrep.js";
import { supportsOxcLanguage } from "./languages/oxcAdapter.js";
import {
  collectImportsForFile,
  collectLocalsAndExportsFromSource,
  parseFile,
  type ModuleIndex,
} from "./indexer.js";
import { supportForFile } from "./languages.js";
import type { Edge } from "./types.js";
import type { ProcessFileResult, ProcessFileTask, WorkerPreparedInput } from "./workerTypes.js";

export default async function processFileTask(
  task: ProcessFileTask,
): Promise<ProcessFileResult> {
  const { file, projectRoot, workspaceConfig, graphOptions, buildModule, buildGraph } = task;
  const supported = supportForFile(file);
  if (!supported) {
    return {
      file,
      mod: emptyModule(file),
      edges: [],
    };
  }

  let prepared: WorkerPreparedInput;
  let tree: Parser.Tree | undefined;

  if (supportsOxcLanguage(supported.id)) {
    prepared = await prepareParserInput(file);
  } else {
    const parsed = await parseFile(file);
    prepared = {
      source: parsed.source,
      sup: parsed.sup,
      lang: parsed.lang,
    };
    tree = parsed.tree;
  }

  let mod: ModuleIndex = emptyModule(file);
  if (buildModule) {
    const imports = await collectImportsForFile(file, projectRoot, {
      source: prepared.source,
      ...(tree ? { tree } : {}),
      sup: prepared.sup,
      lang: prepared.lang,
      graphOptions,
    });
    mod = collectLocalsAndExportsFromSource(
      file,
      prepared.source,
      prepared.sup,
      prepared.lang,
      imports,
      tree ? { tree } : undefined,
    );
    mod.imports = imports;
  }

  let edges: Edge[] = [];
  if (buildGraph) {
    edges = await collectEdgesForFile(file, projectRoot, workspaceConfig, {
      ...(tree
        ? { parsed: { source: prepared.source, tree, sup: prepared.sup, lang: prepared.lang } }
        : { prepared }),
      fast: !!graphOptions.fast,
      ...(graphOptions.fastRegexDisabledLanguages
        ? { fastRegexDisabledLanguages: graphOptions.fastRegexDisabledLanguages }
        : {}),
      resolveNodeModules: !!graphOptions.resolveNodeModules,
      dynamicImportHeuristics: !!graphOptions.dynamicImportHeuristics,
      ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
    });
  }

  return { file, mod, edges };
}

function emptyModule(file: string): ModuleIndex {
  return {
    file,
    exports: [],
    imports: [],
    locals: [],
  };
}
