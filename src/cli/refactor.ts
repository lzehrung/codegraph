import path from "node:path";
import { buildProjectIndexFromFiles } from "../indexer.js";
import type { BuildOptions } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { applyEdits } from "../refactor/applyEdits.js";
import { moveSymbol } from "../refactor/move.js";
import { renameSymbol } from "../refactor/rename.js";
import type { RefactorResult, TextEdit } from "../refactor/types.js";
import type { ProjectFileDiscoveryOptions } from "../util.js";

export type RefactorCommandContext = {
  projectRootFs: string;
  positionals: string[];
  files: string[];
  discovery: ProjectFileDiscoveryOptions;
  nativeMode: NativeRuntimeMode;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  progressHandler: ((update: { current: number; total: number }) => void) | undefined;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
};

function renderRefactorEdits(projectRoot: string, edits: TextEdit[]): string {
  return edits
    .map((edit) => {
      const file = path.relative(projectRoot, edit.file).replace(/\\/g, "/") || edit.file;
      return `${file}:${edit.start}-${edit.end} -> ${JSON.stringify(edit.newText)}`;
    })
    .join("\n");
}

async function writeRefactorResult(
  context: RefactorCommandContext,
  result: RefactorResult,
  options: { json: boolean; apply: boolean; useGit: boolean },
): Promise<void> {
  if (options.apply && result.status === "ok") {
    const applied = await applyEdits(result.edits, { useGit: options.useGit });
    if (options.json) {
      context.writeJSONLine({ ...result, applied });
      return;
    }
    context.writeStdoutLine(renderRefactorEdits(context.projectRootFs, result.edits));
    return;
  }
  if (options.json) {
    context.writeJSONLine(result);
    return;
  }
  context.writeStdoutLine(renderRefactorEdits(context.projectRootFs, result.edits));
}

export async function handleRefactorCommand(context: RefactorCommandContext): Promise<void> {
  const operation = context.positionals[0];
  if (operation !== "rename" && operation !== "move") {
    throw new Error("Unsupported refactor operation. Expected: rename or move.");
  }

  const symbol = context.getOpt("--symbol");
  if (!symbol) {
    throw new Error(`Missing --symbol for refactor ${operation}.`);
  }

  const indexOptions: BuildOptions = {
    discovery: context.discovery,
    keepParsed: true,
    ...(context.progressHandler ? { onProgress: context.progressHandler } : {}),
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    ...context.workerOpts,
  };
  const index = await buildProjectIndexFromFiles(context.projectRootFs, context.files, indexOptions);
  const result =
    operation === "rename"
      ? await renameSymbol(index, symbol, requireOption(context, "--to", "refactor rename"))
      : await moveSymbol(index, symbol, path.resolve(context.projectRootFs, requireOption(context, "--to-file", "refactor move")));
  await writeRefactorResult(context, result, {
    json: context.hasFlag("--json") || !context.hasFlag("--text"),
    apply: context.hasFlag("--apply"),
    useGit: context.hasFlag("--git"),
  });
}

function requireOption(context: RefactorCommandContext, name: string, operation: string): string {
  const value = context.getOpt(name);
  if (!value) {
    throw new Error(`Missing ${name} for ${operation}.`);
  }
  return value;
}
