import path from "node:path";
import { buildProjectIndexFromFiles, goToDefinition, symbolId } from "../indexer.js";
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

function parseSymbolLocation(raw: string): { file: string; line: number; column: number } {
  const columnSeparator = raw.lastIndexOf(":");
  const lineSeparator = columnSeparator > 0 ? raw.lastIndexOf(":", columnSeparator - 1) : -1;
  if (lineSeparator < 0 || columnSeparator < 0) {
    throw new Error(`Invalid --at value "${raw}". Expected file:line:column.`);
  }
  const file = raw.slice(0, lineSeparator);
  const line = Number(raw.slice(lineSeparator + 1, columnSeparator));
  const column = Number(raw.slice(columnSeparator + 1));
  if (!file || !Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
    throw new Error(`Invalid --at value "${raw}". Expected file:line:column.`);
  }
  return { file, line, column };
}

function inclusiveLineRange(
  startLine: number,
  endLine: number,
): { start: { line: number; column: number }; end: { line: number; column: number } } {
  return { start: { line: startLine, column: 1 }, end: { line: endLine + 1, column: 1 } };
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
  const at = context.getOpt("--at");
  if (operation !== "extract" && !symbol && !at) {
    throw new Error(`Missing --symbol or --at for refactor ${operation}.`);
  }
  if (operation !== "extract" && symbol && at) {
    throw new Error(`Pass either --symbol or --at for refactor ${operation}, not both.`);
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
    return await renameSymbol(
      index,
      await resolveRefactorSymbol(context, index, symbol, "refactor rename"),
      requireOption(context, "--to", "refactor rename"),
    );
  }
  if (operation === "move") {
    return await moveSymbol(
      index,
      await resolveRefactorSymbol(context, index, symbol, "refactor move"),
      path.resolve(context.projectRootFs, requireOption(context, "--to-file", "refactor move")),
    );
  }
  const range = parseLineRange(requireOption(context, "--range", "refactor extract"));
  return await extractFunction(
    index,
    {
      file: path.resolve(context.projectRootFs, requireOption(context, "--file", "refactor extract")),
      range: inclusiveLineRange(range.startLine, range.endLine),
    },
    { newName: requireOption(context, "--to", "refactor extract") },
  );
}

async function resolveRefactorSymbol(
  context: RefactorCommandContext,
  index: Awaited<ReturnType<typeof buildProjectIndexFromFiles>>,
  symbol: string | undefined,
  operation: string,
): Promise<string> {
  if (symbol) return symbol;
  const location = parseSymbolLocation(requireOption(context, "--at", operation));
  const result = await goToDefinition(index, {
    file: path.resolve(context.projectRootFs, location.file).replace(/\\/g, "/"),
    line: location.line,
    column: location.column,
  });
  if (result.status !== "ok") {
    throw new Error(`Could not resolve --at for ${operation}: ${result.reason}`);
  }
  return symbolId(result.definition);
}

function requireOption(context: RefactorCommandContext, name: string, operation: string): string {
  const value = context.getOpt(name);
  if (!value) {
    throw new Error(`Missing ${name} for ${operation}.`);
  }
  return value;
}
