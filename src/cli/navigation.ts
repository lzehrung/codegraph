import { buildProjectIndex } from "../indexer/build-index.js";
import { findReferences, goToDefinition } from "../indexer/navigation.js";
import type { BuildOptions } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { parsePositiveIntegerOption } from "./options.js";
import { resolveCliProjectFile, writeCliProjectFileError } from "./projectFile.js";

export type NavigationCommandContext = {
  projectRootFs: string;
  discoveryOptions: ProjectFileDiscoveryOptions;
  positionals: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  nativeMode: NativeRuntimeMode;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  progressHandler: BuildOptions["onProgress"];
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

function indexOptions(context: NavigationCommandContext) {
  return {
    onProgress: context.progressHandler,
    discovery: context.discoveryOptions,
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    ...context.workerOpts,
  };
}

export async function handleDumpmodCommand(context: NavigationCommandContext): Promise<void> {
  const [fileArg] = context.positionals;
  if (!fileArg) {
    context.writeStderrLine("Usage: dumpmod <file>");
    context.exit(2);
  }
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, fileArg, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile);
    return;
  }
  const file = resolvedFile.file;
  const index = await buildProjectIndex(context.projectRootFs, indexOptions(context));
  const mod = index.byFile.get(file);
  if (!mod) {
    context.writeJSONLine({
      status: "not_found",
      reason: "Module not indexed",
      file,
    });
    return;
  }
  context.writeJSONLine({
    file,
    locals: mod.locals.map((l) => ({
      name: l.localName,
      kind: l.kind,
      start: l.range.start,
    })),
    exports: mod.exports.map((e) =>
      e.type === "local"
        ? {
            type: e.type,
            exportedAs: e.exportedAs,
            def: {
              name: e.target.localName,
              kind: e.target.kind,
              start: e.target.range.start,
            },
          }
        : e,
    ),
    imports: mod.imports,
  });
}

export async function handleGotoCommand(context: NavigationCommandContext): Promise<void> {
  const [fileArg, lineArg, colArg] = context.positionals;
  if (!fileArg || !lineArg || !colArg) {
    context.writeStderrLine("Usage: goto <file> <line> <column>");
    context.exit(2);
  }
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, fileArg, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile);
    return;
  }
  const line = parsePositiveIntegerOption(lineArg, "line", 1);
  const column = parsePositiveIntegerOption(colArg, "column", 1);
  const index = await buildProjectIndex(context.projectRootFs, indexOptions(context));
  const res = await goToDefinition(index, { file: resolvedFile.file, line, column });
  context.writeJSONLine(res);
}

export async function handleRefsCommand(context: NavigationCommandContext): Promise<void> {
  const fileArg = context.getOpt("--file");
  const lineArg = context.getOpt("--line");
  const colArg = context.getOpt("--col") ?? context.getOpt("--column");
  if (!fileArg || !lineArg || !colArg) {
    context.writeStderrLine("Usage: refs --file <file> --line <line> --col <column>");
    context.exit(2);
  }
  const line = parsePositiveIntegerOption(lineArg, "--line", 1);
  const column = parsePositiveIntegerOption(colArg, "--col", 1);
  const pretty = context.hasFlag("--pretty");
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, fileArg, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile, pretty ? "text" : "json");
    return;
  }
  const index = await buildProjectIndex(context.projectRootFs, indexOptions(context));
  const res = await findReferences(index, { file: resolvedFile.file, line, column });
  if (!pretty) {
    context.writeJSONLine(res);
    return;
  }
  if (res.status === "ok") {
    for (const r of res.references) {
      const rel = toProjectDisplayPath(context.projectRootFs, r.file);
      const { line: refLine, column: refColumn } = r.range.start;
      context.writeStdoutLine(`${rel}:${refLine}:${refColumn}`);
    }
    return;
  }
  context.writeStdoutLine(`not_found: ${res.reason}`);
}
