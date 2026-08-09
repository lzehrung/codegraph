import { loadCurrentProjectIndex, type LoadCurrentProjectIndexOptions } from "../indexer/load-current-index.js";
import { findReferences, goToDefinition } from "../indexer/navigation.js";
import { findLocalSymbolDefinitions, parseQualifiedSymbolPath } from "../indexer/symbols.js";
import { parseAgentSymbolHandle } from "../agent/handles.js";
import {
  SymbolKind,
  type BuildOptions,
  type FindReferencesResult,
  type GoToResult,
  type ModuleIndex,
  type ProjectIndex,
  type SymbolDef,
} from "../indexer/types.js";
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

type DumpmodOutput = {
  file: string;
  locals: Array<{
    name: string;
    kind: SymbolKind;
    start: SymbolDef["range"]["start"];
  }>;
  imports: ModuleIndex["imports"];
  exports: Array<
    | {
        type: "local";
        exportedAs: string;
        def: {
          name: string;
          kind: SymbolKind;
          start: SymbolDef["range"]["start"];
        };
      }
    | {
        type: "reexport";
        exportedAs: string;
        fromModule: string;
        moduleSpecifier?: string;
        sourceSpecifier: string;
        typeOnly?: boolean;
      }
    | {
        type: "namespaceReexport";
        exportedAs: string;
        fromModule: string;
        moduleSpecifier?: string;
        typeOnly?: boolean;
      }
    | {
        type: "exportStar";
        fromModule: string;
        moduleSpecifier?: string;
        sourceSpecifier?: string;
        typeOnly?: boolean;
      }
  >;
};

type GotoCandidate = {
  name: string;
  kind: SymbolKind;
  range: SymbolDef["range"];
};

type GotoCliOutput =
  | GoToResult
  | {
      status: "ambiguous";
      reason: string;
      candidates: GotoCandidate[];
    };

function formatGotoCandidate(candidate: GotoCandidate): string {
  return `${candidate.kind} ${candidate.name} @ ${candidate.range.start.line}:${candidate.range.start.column}`;
}

function formatDumpmodMissingOutput(projectRootFs: string, output: { reason: string; file: string }): string {
  return `${output.reason}: ${toProjectDisplayPath(projectRootFs, output.file)}`;
}

function formatDefinitionLocation(projectRootFs: string, definition: SymbolDef): string {
  const file = toProjectDisplayPath(projectRootFs, definition.file);
  return `${file}:${definition.range.start.line}:${definition.range.start.column} ${definition.kind} ${definition.localName}`;
}

function formatDumpmodOutput(projectRootFs: string, output: DumpmodOutput): string {
  const lines = [`File: ${toProjectDisplayPath(projectRootFs, output.file)}`, "Locals:"];
  if (!output.locals.length) {
    lines.push("- (none)");
  } else {
    for (const local of output.locals) {
      lines.push(`- ${local.kind} ${local.name} @ ${local.start.line}:${local.start.column}`);
    }
  }
  lines.push("Exports:");
  if (!output.exports.length) {
    lines.push("- (none)");
  } else {
    for (const entry of output.exports) {
      if (entry.type === "local") {
        lines.push(
          `- local ${entry.def.kind} ${entry.def.name} as ${entry.exportedAs} @ ${entry.def.start.line}:${entry.def.start.column}`,
        );
        continue;
      }
      if (entry.type === "reexport") {
        const typeOnlySuffix = entry.typeOnly ? " (type-only)" : "";
        lines.push(`- reexport ${entry.exportedAs} from ${entry.fromModule}${typeOnlySuffix}`);
        continue;
      }
      if (entry.type === "namespaceReexport") {
        const typeOnlySuffix = entry.typeOnly ? " (type-only)" : "";
        lines.push(`- namespace ${entry.exportedAs} from ${entry.fromModule}${typeOnlySuffix}`);
        continue;
      }
      const typeOnlySuffix = entry.typeOnly ? " (type-only)" : "";
      lines.push(`- export * from ${entry.fromModule}${typeOnlySuffix}`);
    }
  }
  return lines.join("\n");
}

function formatGotoOutput(projectRootFs: string, output: GotoCliOutput): string {
  if (output.status === "ok") {
    const lines = [formatDefinitionLocation(projectRootFs, output.definition)];
    const via = output.via;
    if (via?.importedFrom) {
      let viaLine = `Resolved via ${via.importedFrom}`;
      if (via.exportedName) {
        viaLine += ` as ${via.exportedName}`;
      }
      lines.push(viaLine);
    }
    return lines.join("\n");
  }
  if (output.status === "ambiguous") {
    return [output.reason, ...output.candidates.map((candidate) => `- ${formatGotoCandidate(candidate)}`)].join("\n");
  }
  return output.reason;
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
    writeCliOutput(
      context,
      {
        status: "not_found",
        reason: "Module not indexed",
        file,
      },
      (output) => formatDumpmodMissingOutput(context.projectRootFs, output),
    );
    context.exit(1);
  }
  writeCliOutput(
    context,
    {
      file,
      locals: mod.locals.map((l) => ({
        name: l.localName,
        kind: l.kind,
        start: l.range.start,
      })),
      imports: mod.imports,
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
    },
    (output) => formatDumpmodOutput(context.projectRootFs, output),
  );
}

type ResolvedNavigationInput = {
  file: string;
  symbolName?: string;
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
  const qualifiedSymbol = parseQualifiedSymbolPath(target);
  const location = symbolHandle
    ? { file: symbolHandle.file, line: symbolHandle.line, column: symbolHandle.column }
    : parseCliSourceLocation(qualifiedSymbol?.file ?? target);
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
  if (qualifiedSymbol && (lineValue !== undefined || columnValue !== undefined)) {
    context.writeStderrLine("A qualified file::symbol target cannot be combined with a line or column.");
    context.exit(2);
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
    ...(qualifiedSymbol ? { symbolName: qualifiedSymbol.name } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

type SymbolPathResolution =
  | { status: "ok"; definition: SymbolDef }
  | { status: "not_found"; reason: string }
  | { status: "ambiguous"; reason: string; candidates: GotoCandidate[] };

function resolveSymbolPath(index: ProjectIndex, file: string, symbolName: string): SymbolPathResolution {
  const definitions = sortDefinitions(findLocalSymbolDefinitions(index, file, symbolName));
  if (definitions.length === 1) {
    const definition = definitions[0];
    if (!definition) throw new Error("Expected one symbol-path definition.");
    return { status: "ok", definition };
  }
  if (!definitions.length) {
    return { status: "not_found", reason: `No indexed symbol ${symbolName} in ${file}` };
  }
  return {
    status: "ambiguous",
    reason: `Multiple symbols named ${symbolName} in ${file}; use a portable handle from codegraph symbols to disambiguate.`,
    candidates: definitions.map((definition) => ({
      name: definition.localName,
      kind: definition.kind,
      range: definition.range,
    })),
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
  if (input.symbolName !== undefined) {
    const resolution = resolveSymbolPath(index, resolvedFile.file, input.symbolName);
    writeCliOutput(context, resolution, (value) => formatGotoOutput(context.projectRootFs, value));
    if (resolution.status !== "ok") context.exit(1);
    return;
  }
  if (input.line === undefined) {
    const definitions = sortDefinitions(index.byFile.get(resolvedFile.file)?.locals ?? []);
    if (definitions.length === 1) {
      const definition = definitions[0];
      if (definition === undefined) {
        throw new Error("Expected one definition candidate.");
      }
      const output: GotoCliOutput = { status: "ok", definition };
      writeCliOutput(context, output, (value) => formatGotoOutput(context.projectRootFs, value));
      return;
    }
    if (!definitions.length) {
      const output: GotoCliOutput = { status: "not_found", reason: `No indexed symbols in ${input.file}` };
      writeCliOutput(context, output, (value) => formatGotoOutput(context.projectRootFs, value));
      context.exit(1);
    }
    const output: GotoCliOutput = {
      status: "ambiguous",
      reason: `Multiple symbols in ${input.file}; pass one of the candidate locations.`,
      candidates: definitions.map((definition) => ({
        name: definition.localName,
        kind: definition.kind,
        range: definition.range,
      })),
    };
    writeCliOutput(context, output, (value) => formatGotoOutput(context.projectRootFs, value));
    return;
  }
  const res = await goToDefinition(index, {
    file: resolvedFile.file,
    line: input.line,
    column: input.column ?? 1,
  });
  writeCliOutput(context, res, (value) => formatGotoOutput(context.projectRootFs, value));
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

  if (input.symbolName !== undefined) {
    const resolution = resolveSymbolPath(index, resolvedFile.file, input.symbolName);
    if (resolution.status !== "ok") {
      if (pretty) {
        context.writeStdoutLine(formatGotoOutput(context.projectRootFs, resolution));
      } else {
        context.writeJSONLine(resolution);
      }
      context.exit(1);
    }
    const result = await findReferences(index, { def: resolution.definition });
    if (pretty) {
      writePrettyReferences(context, result);
    } else {
      context.writeJSONLine(result);
      if (result.status !== "ok") context.exit(1);
    }
    return;
  }

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
