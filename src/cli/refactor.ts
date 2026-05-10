import path from "node:path";
import { buildProjectIndexFromFiles } from "../indexer.js";
import type { BuildOptions } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { applyEdits } from "../refactor/applyEdits.js";
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
  if (operation !== "rename") {
    throw new Error("Unsupported refactor operation. Expected: rename.");
  }

  const symbol = context.getOpt("--symbol");
  const to = context.getOpt("--to");
  if (!symbol) {
    throw new Error("Missing --symbol for refactor rename.");
  }
  if (!to) {
    throw new Error("Missing --to for refactor rename.");
  }

  const indexOptions: BuildOptions = {
    discovery: context.discovery,
    keepParsed: true,
    ...(context.progressHandler ? { onProgress: context.progressHandler } : {}),
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    ...context.workerOpts,
  };
  const index = await buildProjectIndexFromFiles(context.projectRootFs, context.files, indexOptions);
  const result = await renameSymbol(index, symbol, to);
  await writeRefactorResult(context, result, {
    json: context.hasFlag("--json") || !context.hasFlag("--text"),
    apply: context.hasFlag("--apply"),
    useGit: context.hasFlag("--git"),
  });
}
