import { collectEdgeModuleSpecifiers } from "../graphs/specifiers.js";
import { extractAngularJsFileFacts } from "../frameworks/angularjs.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import type { LanguageExtensionMap, LanguageSupport } from "../languages.js";
import type { LogLevel } from "../logging.js";
import type { ProjectedSyntaxTree } from "../native/projected-tree.js";
import { isNativeRequiredUnavailableError, type NativeQueryResults } from "../native/tree-sitter-native.js";
import type { Pos, Range } from "../types.js";
import { fileIdentityKey, isFilePathWithinRoot, normalizePath } from "../util/paths.js";
import { resolveSpecifier, type MatchPathFn } from "../util/resolution.js";
import type { ModuleSpecifier } from "../util/specifiers.js";
import { resolveWorkspacePackage, type WorkspaceConfig } from "../util/workspace.js";
import type { PendingModuleCacheWrite } from "./build-cache.js";
import {
  collectImportsForFile,
  createFileImportResolver,
  importResolutionKey,
  type FileImportResolver,
} from "./imports.js";
import {
  PendingImportResolutionError,
  PendingImportTarget,
  type ImportResolver,
  type ImportResolverOptions,
  type ResolvedImportTarget,
} from "./imports/context.js";
import { collectLocalsAndExportsFromSource } from "./locals-and-exports.js";
import type { ParsedFileContext } from "./parse-context.js";
import { collectParseErrorRanges } from "./parse-errors.js";
import type { BuildReport, ImportBinding, ModuleIndex, SymbolDef } from "./types.js";

/**
 * Module records: the per-file indexing of a JavaScript or TypeScript file split at import resolution, so that a
 * native extraction worker runs everything that depends only on the file and the main thread runs the rest.
 *
 * `buildModuleRecord` extracts the imports with resolution deferred, then the locals and exports (scope index
 * included), the parse error ranges, and the specifiers of the file's dependency edges. `finishModuleRecord` resolves
 * the deferred requests with the resolver `collectImportsForFile` would have used, then does what needs other files:
 * JSON dependencies, the cross-module export rewrite, the cache signature, and the edges. A build that indexes a file
 * on the main thread runs the same two functions, so a worker and the main thread produce the same module.
 */

/** One distinct import resolution a module record defers, as the extraction asked for it. */
export type ImportResolutionRequest = {
  from: string;
  phpImportType?: "class" | "function" | "const";
  options?: ImportResolverOptions;
};

/**
 * A JavaScript or TypeScript module indexed up to import resolution. In `module`, each import binding's `resolved`
 * holds the `PendingImportTarget` of its request, and re-exports keep the specifier they were written with.
 * `requests` lists the distinct requests in the order the extraction first asked for them, and `specifiers` are the
 * module specifiers the file's dependency edges resolve.
 */
export type ModuleRecord = {
  module: ModuleIndex;
  requests: ImportResolutionRequest[];
  specifiers: ModuleSpecifier[];
};

/**
 * Why a file is indexed the way it was before module records. Each depends only on the file's content: no syntax tree
 * or native results, an import extraction that degraded, a write to the build report, a rule that reads a resolved
 * import target (the CommonJS `module.exports = { ...required }` spread), or an error.
 */
export type ModuleRecordFallback = "noTree" | "degradedImport" | "reportWrite" | "resolutionDependent" | "error";

export type ModuleRecordOutcome = { record: ModuleRecord } | { fallback: ModuleRecordFallback };

/** What a native extraction worker needs, besides the file and its parse, to build the file's module record. */
export type ModuleRecordTask = {
  projectRoot: string;
  dynamicImportHeuristics: boolean;
  logLevel?: LogLevel;
};

export type ModuleRecordInput = ModuleRecordTask & {
  file: string;
  source: string;
  support: LanguageSupport;
  nativeQueries: NativeQueryResults | null;
  tree: ProjectedSyntaxTree | undefined;
};

/** Languages whose files a build indexes through module records. */
export function isModuleRecordLanguage(languageId: string): boolean {
  return isJsTsLanguage(languageId);
}

/**
 * A resolver that resolves nothing: it records each distinct request and answers with that request's placeholder.
 * `targets` holds the placeholders, so the caller can tell whether anything tried to read one.
 */
function createDeferredImportResolver(): {
  resolver: FileImportResolver;
  requests: ImportResolutionRequest[];
  targets: PendingImportTarget[];
} {
  const requests: ImportResolutionRequest[] = [];
  const targets: PendingImportTarget[] = [];
  const targetByKey = new Map<string, PendingImportTarget>();
  const resolve: ImportResolver = (from, phpImportType, options) => {
    const key = importResolutionKey(from, phpImportType, options);
    let target = targetByKey.get(key);
    if (!target) {
      target = new PendingImportTarget(requests.length);
      targetByKey.set(key, target);
      targets.push(target);
      requests.push({
        from,
        ...(phpImportType ? { phpImportType } : {}),
        ...(options && Object.keys(options).length ? { options } : {}),
      });
    }
    return Promise.resolve(target);
  };
  return { resolver: { resolve, jvmPackageFiles: new Map() }, requests, targets };
}

/**
 * Indexes a JavaScript or TypeScript file up to import resolution. Runs in a native extraction worker on the worker's
 * own parse, or on the main thread when the build indexes the file there. A file it cannot index exactly as the main
 * thread would returns the reason instead, and the build indexes that file as before.
 */
export async function buildModuleRecord(input: ModuleRecordInput): Promise<ModuleRecordOutcome> {
  const { file, source, support, nativeQueries, tree } = input;
  if (!isModuleRecordLanguage(support.id)) {
    throw new Error(`Module records cover JavaScript and TypeScript files, not ${support.id}.`);
  }
  if (!tree || !nativeQueries) return { fallback: "noTree" };
  const logLevel = input.logLevel ? { logLevel: input.logLevel } : {};
  // The main thread writes to the build report itself, so any write here means the file must be indexed there.
  const probeReport: BuildReport = { timings: {} };
  try {
    let degraded = false;
    const deferred = createDeferredImportResolver();
    const imports = await collectImportsForFile(file, input.projectRoot, {
      source,
      sup: support,
      nativeQueries,
      ...logLevel,
      report: probeReport,
      onDegraded: () => {
        degraded = true;
      },
      resolver: deferred.resolver,
    });
    if (degraded) return { fallback: "degradedImport" };
    const module = collectLocalsAndExportsFromSource(file, source, support, imports, {
      tree,
      nativeQueries,
      ...logLevel,
    });
    const angularJsFacts = extractAngularJsFileFacts(source, tree);
    if (angularJsFacts) module.angularJsFacts = angularJsFacts;
    module.parseErrorRanges = collectParseErrorRanges(tree);
    module.nativeOutcome = "used";
    const specifiers = collectEdgeModuleSpecifiers(support, source, {
      tree,
      nativeQueries,
      file: file.replace(/\\/g, "/"),
      ...logLevel,
      report: probeReport,
      projectRoot: input.projectRoot,
      dynamicImportHeuristics: input.dynamicImportHeuristics,
    });
    // A rule that read a resolved target needs the main thread, even where the extraction caught the refusal.
    if (deferred.targets.some((target) => target.read)) return { fallback: "resolutionDependent" };
    const reportWritten = Object.keys(probeReport).length > 1 || Object.keys(probeReport.timings).length > 0;
    if (reportWritten) return { fallback: "reportWrite" };
    return { record: { module, requests: deferred.requests, specifiers } };
  } catch (error) {
    if (error instanceof PendingImportResolutionError) return { fallback: "resolutionDependent" };
    if (isNativeRequiredUnavailableError(error)) throw error;
    return { fallback: "error" };
  }
}

/** Adds each JSON file the imports resolved to, by identity key, so the build indexes it as a module. */
export function collectJsonDependencies(imports: readonly ImportBinding[], bucket: Map<string, string>): void {
  for (const imp of imports) {
    const resolved = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : null;
    if (resolved?.toLowerCase().endsWith(".json")) bucket.set(fileIdentityKey(resolved), resolved);
  }
}

/** Points the re-exports of a JavaScript or TypeScript module at the project files they resolve to. */
export async function resolveCrossModuleSymbolExports(
  file: string,
  mod: ModuleIndex,
  support: LanguageSupport,
  projectRoot: string,
  graphOptions: GraphBuildOptions,
  workspaceConfig: WorkspaceConfig | undefined,
  matchPath: MatchPathFn | undefined,
): Promise<void> {
  if (!support.supportsCrossModuleSymbols || !isJsTsLanguage(support.id)) return;
  const reexports = mod.exports.filter(
    (entry) => entry.type === "reexport" || entry.type === "exportStar" || entry.type === "namespaceReexport",
  );
  if (!reexports.length) return;
  for (const entry of reexports) {
    if (entry.fromModule.startsWith(".")) {
      entry.moduleSpecifier ??= entry.fromModule;
      const resolved = await resolveSpecifier(file, entry.fromModule, projectRoot, matchPath, workspaceConfig, {
        resolveNodeModules: !!graphOptions.resolveNodeModules,
        ...(graphOptions.resolutionHints ? { resolutionHints: graphOptions.resolutionHints } : {}),
      });
      if (typeof resolved === "string" && isFilePathWithinRoot(projectRoot, resolved)) entry.fromModule = resolved;
      continue;
    }
    const pkgResolved = await resolveWorkspacePackage(entry.fromModule, workspaceConfig);
    if (pkgResolved) {
      entry.moduleSpecifier ??= entry.fromModule;
      if (isFilePathWithinRoot(projectRoot, pkgResolved)) entry.fromModule = pkgResolved;
    }
  }
}

/** The main-thread state a module record is finished with. */
export type ModuleRecordFinishContext = {
  file: string;
  support: LanguageSupport;
  projectRoot: string;
  graphOptions: GraphBuildOptions;
  workspaceConfig?: WorkspaceConfig;
  matchPath?: MatchPathFn;
  logLevel?: LogLevel;
  languageExtensions?: LanguageExtensionMap;
  report?: BuildReport;
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>;
  /** JSON files the build's modules import, by identity key. */
  jsonDependencies: Map<string, string>;
  /** The signature the module is cached under; absent when the build does not cache it. */
  cacheSignature?: () => Promise<string>;
};

export type FinishedModuleRecord = {
  module: ModuleIndex;
  cacheWrite?: PendingModuleCacheWrite;
  /** What the file's edges are collected from (see `collectEdgesForFile`). */
  edgeSource: { sup: LanguageSupport; specifiers: readonly ModuleSpecifier[] };
};

/**
 * Finishes a module record on the main thread: resolves its requests in first-use order with the file's import
 * resolver, puts each target where its placeholder was (the binding keeps its key order), then records JSON
 * dependencies, points re-exports at their files, and takes the cache signature.
 */
export async function finishModuleRecord(
  record: ModuleRecord,
  context: ModuleRecordFinishContext,
): Promise<FinishedModuleRecord> {
  const mod = record.module;
  const targets: ResolvedImportTarget[] = [];
  if (record.requests.length) {
    const resolver = await createFileImportResolver(context.file, context.projectRoot, context.support.id, {
      graphOptions: context.graphOptions,
      ...(context.workspaceConfig ? { workspaceConfig: context.workspaceConfig } : {}),
      ...(context.matchPath ? { matchPath: context.matchPath } : {}),
      ...(context.logLevel ? { logLevel: context.logLevel } : {}),
      ...(context.languageExtensions ? { languageExtensions: context.languageExtensions } : {}),
      ...(context.report ? { report: context.report } : {}),
      ...(context.parsedFiles ? { parsedFiles: context.parsedFiles } : {}),
    });
    for (const request of record.requests) {
      targets.push(await resolver.resolve(request.from, request.phpImportType, request.options));
    }
  }
  for (const binding of mod.imports) {
    const pending = binding.resolved;
    if (!(pending instanceof PendingImportTarget)) continue;
    const target = targets[pending.request];
    if (target === undefined) {
      throw new Error(`Module record of ${context.file} has no resolution request ${pending.request}.`);
    }
    binding.resolved = target;
  }
  collectJsonDependencies(mod.imports, context.jsonDependencies);
  await resolveCrossModuleSymbolExports(
    context.file,
    mod,
    context.support,
    context.projectRoot,
    context.graphOptions,
    context.workspaceConfig,
    context.matchPath,
  );
  const cacheSignature = context.cacheSignature ? await context.cacheSignature() : undefined;
  return {
    module: mod,
    ...(cacheSignature !== undefined ? { cacheWrite: { file: context.file, sig: cacheSignature, mod } } : {}),
    edgeSource: { sup: context.support, specifiers: record.specifiers },
  };
}

/**
 * A module record as a worker posts it. Each symbol definition's file and the file prefix of its callable key are
 * left out when they are the module's file, and every range is packed into `data`; `decodeModuleRecord` restores the
 * record exactly, including which objects are shared.
 *
 * `data` holds, in order: a header (definition count, range count, distinct range count, pending binding count), one
 * flag word per definition of `defs`, the distinct range of each range in visit order, six words per distinct range
 * (start line, column, index; end line, column, index; an absent index is -1), and a binding index and request for
 * each binding whose target is pending.
 */
export type ModuleRecordPayload = {
  module: ModuleIndex;
  /** Each symbol definition of the module once: its locals, then export targets that are not locals. */
  defs: SymbolDef[];
  /** Stands in for every range packed into `data`. */
  packedRange: Range;
  data: Int32Array;
  requests: ImportResolutionRequest[];
  specifiers: ModuleSpecifier[];
};

const HEADER_WORDS = 4;
const RANGE_WORDS = 6;
const FILE_LEFT_OUT = 1;
const CALLABLE_FILE_LEFT_OUT = 2;
const RANGE_KEYS = ["start", "end"] as const;
const POSITION_KEYS = ["line", "column", "index"] as const;

function isPackableNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
}

/** A position written exactly as `{ line, column }` or `{ line, column, index }`, with values a word can hold. */
function isPackablePosition(position: Pos): boolean {
  let keys = 0;
  for (const key of Object.keys(position)) {
    if (key !== POSITION_KEYS[keys]) return false;
    keys += 1;
  }
  if (keys < 2) return false;
  return (
    isPackableNumber(position.line) &&
    isPackableNumber(position.column) &&
    (keys === 2 || isPackableNumber(position.index))
  );
}

/** A range written exactly as `{ start, end }` with two distinct packable positions. */
function isPackableRange(range: Range): boolean {
  const keys = Object.keys(range);
  if (keys.length !== RANGE_KEYS.length || keys[0] !== RANGE_KEYS[0] || keys[1] !== RANGE_KEYS[1]) return false;
  return range.start !== range.end && isPackablePosition(range.start) && isPackablePosition(range.end);
}

/** Visits the ranges of a record in the order its encoding packs them. */
function forEachRange(
  defs: readonly SymbolDef[],
  imports: readonly ImportBinding[],
  visit: (range: Range) => Range,
): void {
  for (const def of defs) def.range = visit(def.range);
  for (const binding of imports) {
    if (binding.kind === "named" && binding.importedRange) binding.importedRange = visit(binding.importedRange);
    if (binding.kind !== "star" && binding.localRange) binding.localRange = visit(binding.localRange);
  }
}

/** Each symbol definition of a module once: its locals, then export targets that are not locals. */
function distinctDefinitions(mod: ModuleIndex): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const seen = new Set<SymbolDef>();
  const add = (def: SymbolDef): void => {
    if (seen.has(def)) return;
    seen.add(def);
    defs.push(def);
  };
  for (const local of mod.locals) add(local);
  for (const entry of mod.exports) if (entry.type === "local") add(entry.target);
  return defs;
}

/**
 * Encodes a module record for a worker to post. It reuses the record's objects, so the record must not be used
 * afterwards. A record whose ranges cannot be packed exactly (a shape other than `{ start, end }` with
 * `{ line, column, index }` positions, or a position object two ranges share) keeps its ranges as objects.
 */
export function encodeModuleRecord(record: ModuleRecord): ModuleRecordPayload {
  const mod = record.module;
  const file = mod.file;
  const defs = distinctDefinitions(mod);
  const defFlags: number[] = [];
  const strippedCallables = new Set<NonNullable<SymbolDef["callable"]>>();
  for (const def of defs) {
    let flags = 0;
    if (def.file === file) {
      def.file = "";
      flags |= FILE_LEFT_OUT;
    }
    const callable = def.callable;
    if (
      callable &&
      !strippedCallables.has(callable) &&
      callable.key.startsWith(file) &&
      callable.key.charCodeAt(file.length) === 0
    ) {
      strippedCallables.add(callable);
      callable.key = callable.key.slice(file.length);
      flags |= CALLABLE_FILE_LEFT_OUT;
    }
    defFlags.push(flags);
  }

  const rangeSlots: number[] = [];
  const distinctRanges: Range[] = [];
  const slotByRange = new Map<Range, number>();
  const positions = new Set<Pos>();
  // A binding listed twice would have its ranges restored twice, so such a record keeps its ranges as objects.
  let packable = new Set(mod.imports).size === mod.imports.length;
  forEachRange(defs, mod.imports, (range) => {
    let slot = slotByRange.get(range);
    if (slot === undefined) {
      if (!isPackableRange(range) || positions.has(range.start) || positions.has(range.end)) packable = false;
      positions.add(range.start);
      positions.add(range.end);
      slot = distinctRanges.length;
      slotByRange.set(range, slot);
      distinctRanges.push(range);
    }
    rangeSlots.push(slot);
    return range;
  });
  const packedRange: Range = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
  if (packable) forEachRange(defs, mod.imports, () => packedRange);
  const packedCount = packable ? rangeSlots.length : 0;
  const distinctCount = packable ? distinctRanges.length : 0;

  const pending: number[] = [];
  mod.imports.forEach((binding, index) => {
    if (binding.resolved instanceof PendingImportTarget) pending.push(index, binding.resolved.request);
  });

  const data = new Int32Array(
    HEADER_WORDS + defFlags.length + packedCount + RANGE_WORDS * distinctCount + pending.length,
  );
  data[0] = defs.length;
  data[1] = packedCount;
  data[2] = distinctCount;
  data[3] = pending.length / 2;
  let offset = HEADER_WORDS;
  data.set(defFlags, offset);
  offset += defFlags.length;
  if (packable) {
    data.set(rangeSlots, offset);
    offset += rangeSlots.length;
    for (const range of distinctRanges) {
      data[offset] = range.start.line;
      data[offset + 1] = range.start.column;
      data[offset + 2] = range.start.index ?? -1;
      data[offset + 3] = range.end.line;
      data[offset + 4] = range.end.column;
      data[offset + 5] = range.end.index ?? -1;
      offset += RANGE_WORDS;
    }
  }
  data.set(pending, offset);
  return { module: mod, defs, packedRange, data, requests: record.requests, specifiers: record.specifiers };
}

function unpackPosition(line: number, column: number, index: number): Pos {
  return index < 0 ? { line, column } : { line, column, index };
}

/** Restores the module record a worker encoded with `encodeModuleRecord`, reusing the payload's objects. */
export function decodeModuleRecord(payload: ModuleRecordPayload): ModuleRecord {
  const { module: mod, defs, data } = payload;
  const file = mod.file;
  const defCount = data[0]!;
  const packedCount = data[1]!;
  const distinctCount = data[2]!;
  const pendingCount = data[3]!;
  const expectedLength = HEADER_WORDS + defCount + packedCount + RANGE_WORDS * distinctCount + 2 * pendingCount;
  if (defCount !== defs.length || data.length !== expectedLength) {
    throw new Error(`Module record of ${file} does not match its encoding.`);
  }
  let offset = HEADER_WORDS;
  for (const def of defs) {
    const flags = data[offset]!;
    offset += 1;
    if (flags & FILE_LEFT_OUT) def.file = file;
    if (flags & CALLABLE_FILE_LEFT_OUT && def.callable) def.callable.key = file + def.callable.key;
  }
  if (packedCount) {
    const slotsOffset = offset;
    const rangesOffset = slotsOffset + packedCount;
    const ranges = new Array<Range | undefined>(distinctCount);
    let visited = 0;
    forEachRange(defs, mod.imports, (packed) => {
      if (packed !== payload.packedRange || visited >= packedCount) {
        throw new Error(`Module record of ${file} does not match its encoding.`);
      }
      const slot = data[slotsOffset + visited]!;
      visited += 1;
      let range = ranges[slot];
      if (!range) {
        const at = rangesOffset + RANGE_WORDS * slot;
        range = {
          start: unpackPosition(data[at]!, data[at + 1]!, data[at + 2]!),
          end: unpackPosition(data[at + 3]!, data[at + 4]!, data[at + 5]!),
        };
        ranges[slot] = range;
      }
      return range;
    });
    offset = rangesOffset + RANGE_WORDS * distinctCount;
  }
  const targets = payload.requests.map((_, request) => new PendingImportTarget(request));
  for (let pending = 0; pending < pendingCount; pending += 1) {
    const binding = mod.imports[data[offset]!];
    const target = targets[data[offset + 1]!];
    if (!binding || !target) throw new Error(`Module record of ${file} does not match its encoding.`);
    binding.resolved = target;
    offset += 2;
  }
  return { module: mod, requests: payload.requests, specifiers: payload.specifiers };
}
