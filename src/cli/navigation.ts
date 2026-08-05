import { loadCurrentProjectIndex, type LoadCurrentProjectIndexOptions } from "../indexer/load-current-index.js";
import { findReferences, goToDefinition } from "../indexer/navigation.js";
import { parseAgentSymbolHandle } from "../agent/handles.js";
import type { BuildOptions, FindReferencesResult, SymbolDef } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { parseCacheModeOption, parseNonNegativeIntegerOption, parsePositiveIntegerOption } from "./options.js";
import { parseCliSourceLocation } from "./location.js";
import { resolveCliProjectFile, writeCliProjectFileError } from "./projectFile.js";
import { writeCliOutput } from "./pretty.js";

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

// Current repository state: validate the on-disk index automatically and reuse it when
// inputs are unchanged. Pass --cache off to opt out of persisted reuse for one invocation.
function indexOptions(context: NavigationCommandContext): LoadCurrentProjectIndexOptions {
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  return {
    onProgress: context.progressHandler,
    discovery: context.discoveryOptions,
    ...(cache ? { cache } : {}),
    ...(context.hasFlag("--cache-strict") ? { cacheStrict: true } : {}),
    ...(context.hasFlag("--cache-verify") ? { cacheVerify: true } : {}),
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    ...context.workerOpts,
  };
}

async function loadNavigationIndex(context: NavigationCommandContext) {
  return await loadCurrentProjectIndex({
    root: context.projectRootFs,
    scope: { kind: "project" },
    options: indexOptions(context),
  });
}

export async function handleDumpmodCommand(context: NavigationCommandContext): Promise<void> {
  const [fileArg] = context.positionals;
  if (!fileArg) {
    context.writeStderrLine("Usage: dumpmod <file>");
    context.exit(2);
  }
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, fileArg, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile, context.hasFlag("--json") ? "json" : "text");
  }
  const file = resolvedFile.file;
  const index = await loadNavigationIndex(context);
  const mod = index.byFile.get(file);
  if (!mod) {
    writeCliOutput(context, {
      status: "not_found",
      reason: "Module not indexed",
      file,
    });
    context.exit(1);
  }
  writeCliOutput(context, {
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

type ResolvedNavigationInput = {
  file: string;
  line?: number;
  column?: number;
};

function parseNavigationInput(
  context: NavigationCommandContext,
  namedOptions: boolean,
): ResolvedNavigationInput | null {
  const fileOption = namedOptions ? context.getOpt("--file") : undefined;
  const positional = context.positionals[0];
  const target = fileOption ?? positional ?? "";
  const symbolHandle = parseAgentSymbolHandle(target);
  const location = symbolHandle
    ? { file: symbolHandle.file, line: symbolHandle.line, column: symbolHandle.column }
    : parseCliSourceLocation(target);
  if (!location.file) return null;

  let lineValue: string | undefined;
  let columnValue: string | undefined;
  if (fileOption) {
    lineValue = context.getOpt("--line") ?? context.positionals[0];
    columnValue = context.getOpt("--col") ?? context.getOpt("--column") ?? context.positionals[1];
  } else {
    lineValue = context.getOpt("--line") ?? context.positionals[1];
    columnValue = context.getOpt("--col") ?? context.getOpt("--column") ?? context.positionals[2];
  }

  let line = location.line;
  if (lineValue !== undefined) {
    line = parsePositiveIntegerOption(lineValue, "line", 1);
  } else if (line !== undefined) {
    line = parsePositiveIntegerOption(String(line), "line", 1);
  }
  let column = location.column;
  if (columnValue !== undefined) {
    column = parseNonNegativeIntegerOption(columnValue, "column", 1);
  } else if (column !== undefined) {
    column = parseNonNegativeIntegerOption(String(column), "column", 1);
  }
  return {
    file: location.file,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

function sortDefinitions(definitions: readonly SymbolDef[]): SymbolDef[] {
  return [...definitions].sort((left, right) => {
    const lineDelta = left.range.start.line - right.range.start.line;
    if (lineDelta) return lineDelta;
    const columnDelta = left.range.start.column - right.range.start.column;
    if (columnDelta) return columnDelta;
    return left.localName.localeCompare(right.localName);
  });
}

function writePrettyReferences(context: NavigationCommandContext, result: FindReferencesResult): void {
  if (result.status !== "ok") {
    context.writeStdoutLine(`not_found: ${result.reason}`);
    context.exit(1);
  }
  for (const reference of result.references) {
    const rel = toProjectDisplayPath(context.projectRootFs, reference.file);
    const { line, column } = reference.range.start;
    context.writeStdoutLine(`${rel}:${line}:${column}`);
  }
}

export async function handleGotoCommand(context: NavigationCommandContext): Promise<void> {
  const input = parseNavigationInput(context, false);
  if (!input) {
    context.writeStderrLine("Usage: goto <file>[:line[:column]] [line] [column]");
    context.exit(2);
  }
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, input.file, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile, context.hasFlag("--json") ? "json" : "text");
  }
  const index = await loadNavigationIndex(context);
  if (input.line === undefined) {
    const definitions = sortDefinitions(index.byFile.get(resolvedFile.file)?.locals ?? []);
    if (definitions.length === 1) {
      writeCliOutput(context, { status: "ok", definition: definitions[0] });
      return;
    }
    if (!definitions.length) {
      writeCliOutput(context, { status: "not_found", reason: `No indexed symbols in ${input.file}` });
      context.exit(1);
    }
    writeCliOutput(context, {
      status: "ambiguous",
      reason: `Multiple symbols in ${input.file}; pass one of the candidate locations.`,
      candidates: definitions.map((definition) => ({
        name: definition.localName,
        kind: definition.kind,
        range: definition.range,
      })),
    });
    return;
  }
  const res = await goToDefinition(index, {
    file: resolvedFile.file,
    line: input.line,
    column: input.column ?? 1,
  });
  writeCliOutput(context, res);
  if (res.status !== "ok") context.exit(1);
}

export async function handleRefsCommand(context: NavigationCommandContext): Promise<void> {
  const input = parseNavigationInput(context, true);
  if (!input) {
    context.writeStderrLine(
      "Usage: refs <file>[:line[:column]] [line] [column] OR refs --file <file> [--line <line> --col <column>]",
    );
    context.exit(2);
  }
  const pretty = !context.hasFlag("--json");
  const resolvedFile = resolveCliProjectFile(context.projectRootFs, input.file, "File");
  if (resolvedFile.status === "error") {
    writeCliProjectFileError(context, resolvedFile, pretty ? "text" : "json");
  }
  const index = await loadNavigationIndex(context);

  if (input.line !== undefined) {
    const result = await findReferences(index, {
      file: resolvedFile.file,
      line: input.line,
      column: input.column ?? 1,
    });
    if (pretty) {
      writePrettyReferences(context, result);
    } else {
      context.writeJSONLine(result);
      if (result.status !== "ok") context.exit(1);
    }
    return;
  }

  const definitions = sortDefinitions(index.byFile.get(resolvedFile.file)?.locals ?? []);
  if (!definitions.length) {
    const result = { status: "not_found" as const, reason: `No indexed symbols in ${input.file}` };
    if (pretty) {
      context.writeStdoutLine(`not_found: ${result.reason}`);
    } else {
      context.writeJSONLine(result);
    }
    context.exit(1);
  }

  const symbols: Array<{ definition: SymbolDef; references: FindReferencesResult }> = [];
  for (const definition of definitions) {
    symbols.push({ definition, references: await findReferences(index, { def: definition }) });
  }
  if (!pretty) {
    context.writeJSONLine({ status: "ok", file: resolvedFile.file, symbols });
    return;
  }
  for (const symbol of symbols) {
    const { line, column } = symbol.definition.range.start;
    context.writeStdoutLine(
      `${symbol.definition.localName} [${symbol.definition.kind}] ${input.file}:${line}:${column}`,
    );
    if (symbol.references.status === "ok" && symbol.references.references.length) {
      writePrettyReferences(context, symbol.references);
    } else {
      context.writeStdoutLine("  (no references)");
    }
  }
}
