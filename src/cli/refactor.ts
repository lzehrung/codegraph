import path from "node:path";
import { buildProjectIndexFromFiles } from "../indexer.js";
import type { BuildOptions } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { applyEdits } from "../refactor/applyEdits.js";
import { extractFunction } from "../refactor/extract.js";
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

function parseLineRange(raw: string): { startLine: number; endLine: number } {
  const match = /^(\d+):(\d+)$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid --range value "${raw}". Expected startLine:endLine.`);
  }
  const startLine = Number(match[1]);
  const endLine = Number(match[2]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error(`Invalid --range value "${raw}". Expected startLine:endLine.`);
  }
  return { startLine, endLine };
}

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
  if (operation !== "rename" && operation !== "move" && operation !== "extract") {
    throw new Error("Unsupported refactor operation. Expected: rename, move, or extract.");
  }

  const symbol = context.getOpt("--symbol");
  if (operation !== "extract" && !symbol) {
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
  const result = await runRefactorOperation(context, index, operation, symbol);
  await writeRefactorResult(context, result, {
    json: context.hasFlag("--json") || !context.hasFlag("--text"),
    apply: context.hasFlag("--apply"),
    useGit: context.hasFlag("--git"),
  });
}

async function runRefactorOperation(
  context: RefactorCommandContext,
  index: Awaited<ReturnType<typeof buildProjectIndexFromFiles>>,
  operation: "rename" | "move" | "extract",
  symbol: string | undefined,
): Promise<RefactorResult> {
  if (operation === "rename") {
    return await renameSymbol(index, symbol!, requireOption(context, "--to", "refactor rename"));
  }
  if (operation === "move") {
    return await moveSymbol(index, symbol!, path.resolve(context.projectRootFs, requireOption(context, "--to-file", "refactor move")));
  }
  const range = parseLineRange(requireOption(context, "--range", "refactor extract"));
  return await extractFunction(
    index,
    {
      file: path.resolve(context.projectRootFs, requireOption(context, "--file", "refactor extract")),
      range: { start: { line: range.startLine, column: 1 }, end: { line: range.endLine, column: 1 } },
    },
    { newName: requireOption(context, "--to", "refactor extract") },
  );
}

function requireOption(context: RefactorCommandContext, name: string, operation: string): string {
  const value = context.getOpt(name);
  if (!value) {
    throw new Error(`Missing ${name} for ${operation}.`);
  }
  return value;
}
