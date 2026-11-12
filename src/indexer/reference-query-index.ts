import {
  withCsharpGlobalUsings,
  csharpGlobalUsingSource,
  csharpProjectUsingNamespaceFiles,
  csharpImportNamespace,
} from "./csharp-global-usings.js";
import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageSupport } from "../languages.js";
import type { FileId } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { csharpNamespaceAt, IMPLICIT_UNIT_LANGUAGES } from "./compilation-units.js";
import { csharpNamespaceImportDirectories, resolveImported } from "./navigation-resolve.js";
import { candidateFilesImportingTarget } from "./reference-candidates.js";
import type { ExportEntry, ImportBinding, ModuleIndex, ProjectIndex, SymbolDef } from "./types.js";

/**
 * Query-time reverse indexes for reference lookups.
 *
 * Every structure here is a cache keyed by one `ProjectIndex` object: it is built from that index's
 * modules the first time a lookup needs it, reused by every later lookup, dropped with the index, and
 * never stored in a module entry or on disk. Nothing here holds an answer that depends on more than
 * the module tables, so an incremental build (which returns a new index) starts from empty caches. A
 * lookup that replaces `byFile`, or changes its size, or remaps the language extensions of the same
 * index object also rebuilds them.
 */

type Generation = {
  byFile: ProjectIndex["byFile"];
  size: number;
  languageExtensions: ProjectIndex["languageExtensions"];
};

/** One lazily built structure per index; rebuilt when the index object's module table changed under it. */
function perIndexCache<T>(build: (index: ProjectIndex) => T): (index: ProjectIndex) => T {
  const cache = new WeakMap<ProjectIndex, { generation: Generation; value: T }>();
  return (index) => {
    const cached = cache.get(index);
    if (
      cached &&
      cached.generation.byFile === index.byFile &&
      cached.generation.size === index.byFile.size &&
      cached.generation.languageExtensions === index.languageExtensions
    ) {
      return cached.value;
    }
    const value = build(index);
    cache.set(index, {
      generation: { byFile: index.byFile, size: index.byFile.size, languageExtensions: index.languageExtensions },
      value,
    });
    return value;
  };
}

function pushDistinct<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (list[list.length - 1] !== value) list.push(value);
}

export type ReferenceModuleEntry = {
  readonly file: FileId;
  readonly key: string;
  readonly support: LanguageSupport | undefined;
};

export type ReferenceModuleTable = {
  /** Every indexed module in `file.localeCompare` order, the order a whole-project reference scan visits files. */
  readonly entries: readonly ReferenceModuleEntry[];
  /** `fileIdentityKey` -> position in `entries`. */
  readonly rankByKey: ReadonlyMap<string, number>;
  /** The PHP files, in `entries` order. */
  readonly phpFiles: readonly FileId[];
};

/** All modules sorted once per index, with the identity key and language each whole-project scan needs per file. */
export const referenceModuleTable = perIndexCache((index): ReferenceModuleTable => {
  const entries = Array.from(
    index.byFile.values(),
    (module): ReferenceModuleEntry => ({
      file: module.file,
      key: fileIdentityKey(module.file),
      support: supportForFileWithoutHeaderSample(module.file, index.languageExtensions),
    }),
  );
  entries.sort((left, right) => left.file.localeCompare(right.file));
  const rankByKey = new Map<string, number>();
  const phpFiles: FileId[] = [];
  for (let rank = 0; rank < entries.length; rank += 1) {
    const entry = entries[rank]!;
    rankByKey.set(entry.key, rank);
    if (entry.support?.id === "php") phpFiles.push(entry.file);
  }
  return { entries, rankByKey, phpFiles };
});

export type JvmModuleEntry = {
  readonly file: FileId;
  readonly key: string;
  readonly languageId: "java" | "kotlin";
  readonly support: LanguageSupport;
};

/** The Java and Kotlin modules, in module order. */
export const jvmModuleEntries = perIndexCache((index): readonly JvmModuleEntry[] => {
  const entries: JvmModuleEntry[] = [];
  for (const module of index.byFile.values()) {
    const support = supportForFileWithoutHeaderSample(module.file, index.languageExtensions);
    if (support?.id !== "java" && support?.id !== "kotlin") continue;
    entries.push({ file: module.file, key: fileIdentityKey(module.file), languageId: support.id, support });
  }
  return entries;
});

type NamespaceOwner = { readonly ordinal: number; readonly module: ModuleIndex };

export type ExportEdgeIndex = {
  /** `fileIdentityKey(fromModule)` -> modules with a `reexport`, `exportStar`, or `namespaceReexport` entry from it. */
  readonly reexportersByFrom: ReadonlyMap<string, readonly ModuleIndex[]>;
  /** A `reexport` entry's `sourceSpecifier` -> modules that re-export a name spelled so. */
  readonly reexportersBySpecifier: ReadonlyMap<string, readonly ModuleIndex[]>;
  /** `fileIdentityKey(fromModule)` -> modules with an `export * as name from` that module, in module order. */
  readonly namespaceOwnersByFrom: ReadonlyMap<string, readonly NamespaceOwner[]>;
  /**
   * `fileIdentityKey` of a file -> modules that have a local export whose target sits in that other file.
   * Extraction attaches every local export to its own file, so this is empty for an ordinary index; it
   * keeps the reach computation sound for a module table that says otherwise.
   */
  readonly foreignExportersByTarget: ReadonlyMap<string, readonly ModuleIndex[]>;
};

export const exportEdgeIndex = perIndexCache((index): ExportEdgeIndex => {
  const reexportersByFrom = new Map<string, ModuleIndex[]>();
  const reexportersBySpecifier = new Map<string, ModuleIndex[]>();
  const namespaceOwnersByFrom = new Map<string, NamespaceOwner[]>();
  const foreignExportersByTarget = new Map<string, ModuleIndex[]>();
  let ordinal = 0;
  for (const moduleIndex of index.byFile.values()) {
    const moduleOrdinal = ordinal;
    ordinal += 1;
    for (const entry of moduleIndex.exports) {
      if (entry.type === "local") {
        if (entry.target.file !== moduleIndex.file) {
          const targetKey = fileIdentityKey(entry.target.file);
          if (targetKey !== fileIdentityKey(moduleIndex.file))
            pushDistinct(foreignExportersByTarget, targetKey, moduleIndex);
        }
        continue;
      }
      const fromKey = fileIdentityKey(entry.fromModule);
      pushDistinct(reexportersByFrom, fromKey, moduleIndex);
      if (entry.type === "reexport") {
        pushDistinct(reexportersBySpecifier, entry.sourceSpecifier, moduleIndex);
      } else if (entry.type === "namespaceReexport") {
        const owners = namespaceOwnersByFrom.get(fromKey);
        if (!owners) namespaceOwnersByFrom.set(fromKey, [{ ordinal: moduleOrdinal, module: moduleIndex }]);
        else if (owners[owners.length - 1]!.module !== moduleIndex)
          owners.push({ ordinal: moduleOrdinal, module: moduleIndex });
      }
    }
  }
  return { reexportersByFrom, reexportersBySpecifier, namespaceOwnersByFrom, foreignExportersByTarget };
});

/**
 * Modules with an `export * as name from` one of `targetKeys`, each once, in module order. The same
 * set a scan of every module's exports for such an entry finds.
 */
export function namespaceReexportOwners(index: ProjectIndex, targetKeys: ReadonlySet<string>): ModuleIndex[] {
  const edges = exportEdgeIndex(index);
  const found = new Map<number, ModuleIndex>();
  for (const targetKey of targetKeys) {
    for (const owner of edges.namespaceOwnersByFrom.get(targetKey) ?? []) found.set(owner.ordinal, owner.module);
  }
  return [...found.entries()].sort((left, right) => left[0] - right[0]).map(([, module]) => module);
}

const modulesByDirectory = perIndexCache((index): ReadonlyMap<string, readonly ModuleIndex[]> => {
  const byDirectory = new Map<string, ModuleIndex[]>();
  for (const module of index.byFile.values()) {
    pushDistinct(byDirectory, fileIdentityKey(path.dirname(module.file)), module);
  }
  return byDirectory;
});

/** Each module's position in the index's module table, the order a scan of every module visits them. */
const moduleOrdinals = perIndexCache((index): ReadonlyMap<ModuleIndex, number> => {
  const ordinals = new Map<ModuleIndex, number>();
  for (const module of index.byFile.values()) ordinals.set(module, ordinals.size);
  return ordinals;
});

/**
 * `modules` in the order a scan of every module of the index visits them. `resolveExport` caches the answers of
 * the modules it passes through, including the one a star-export cycle cut short, so the order in which modules
 * are probed decides what a cold index answers; a test that replaces such a scan with the few modules that can
 * matter has to probe them in the scan's order.
 */
export function inModuleOrder(index: ProjectIndex, modules: readonly ModuleIndex[]): ModuleIndex[] {
  const ordinals = moduleOrdinals(index);
  const position = (module: ModuleIndex): number => ordinals.get(module) ?? Number.MAX_SAFE_INTEGER;
  return [...modules].sort((left, right) => position(left) - position(right));
}

export type ReachOptions = {
  /** Export names whose dangling re-exports (`export { name } from "./x"`) are reach seeds. */
  danglingNames?: readonly string[];
  /** Also follow importers backward, as a C `resolveExport` does when it walks the includes of a file. */
  throughImports?: boolean;
};

export type ReachResult = {
  /** The reached modules, in the order a scan of every module visits them (`inModuleOrder`). */
  modules: ModuleIndex[];
  /** `fileIdentityKey` of every reached file, including a seed that is not an indexed module. */
  keys: Set<string>;
};

/**
 * Every module that can answer an export lookup of `seedFiles` with a declaration of those files: the
 * seeds, the modules that re-export them (`export { x } from`, `export *`, `export * as ns from`)
 * directly or through other re-exporters, the same-directory modules of a seed in an
 * implicit-compilation-unit language (Go, Java, Kotlin, C#, Swift resolve a bare name through their
 * unit peers, and peers are same-directory), the modules that hold a local export of a seed's
 * declaration from another file, and the dangling re-exports of `danglingNames`. A module outside this
 * set cannot resolve an export name to a declaration of a seed, so a per-module test that only a
 * resolving module can pass needs to run on nothing else.
 */
export function reverseReachableModules(
  index: ProjectIndex,
  seedFiles: readonly FileId[],
  options: ReachOptions = {},
): ReachResult {
  const edges = exportEdgeIndex(index);
  const importers = options.throughImports ? index.referenceCandidates : undefined;
  const reached = new Map<string, ModuleIndex | undefined>();
  const order: string[] = [];
  const add = (key: string, module?: ModuleIndex): void => {
    if (reached.has(key)) return;
    reached.set(key, module);
    order.push(key);
  };
  for (const seedFile of seedFiles) {
    const seedKey = fileIdentityKey(seedFile);
    add(seedKey, index.byFile.get(seedKey));
    const language = supportForFileWithoutHeaderSample(seedFile, index.languageExtensions)?.id;
    if (language && IMPLICIT_UNIT_LANGUAGES[language]) {
      for (const peer of modulesByDirectory(index).get(fileIdentityKey(path.dirname(seedFile))) ?? []) {
        add(fileIdentityKey(peer.file), peer);
      }
    }
    for (const exporter of edges.foreignExportersByTarget.get(seedKey) ?? [])
      add(fileIdentityKey(exporter.file), exporter);
  }
  for (const name of options.danglingNames ?? []) {
    for (const exporter of edges.reexportersBySpecifier.get(name) ?? []) add(fileIdentityKey(exporter.file), exporter);
  }
  for (let next = 0; next < order.length; next += 1) {
    const key = order[next]!;
    for (const reexporter of edges.reexportersByFrom.get(key) ?? []) add(fileIdentityKey(reexporter.file), reexporter);
    for (const importer of importers ? (candidateFilesImportingTarget(importers, key) ?? []) : []) {
      const importerKey = fileIdentityKey(importer);
      add(importerKey, index.byFile.get(importerKey));
    }
  }
  const modules: ModuleIndex[] = [];
  for (const module of reached.values()) if (module) modules.push(module);
  return { modules: inModuleOrder(index, modules), keys: new Set(reached.keys()) };
}

export type LocalExportRef = {
  readonly module: ModuleIndex;
  readonly entry: Extract<ExportEntry, { type: "local" }>;
};

const localExportsByName = perIndexCache((index): ReadonlyMap<string, readonly LocalExportRef[]> => {
  const byName = new Map<string, LocalExportRef[]>();
  for (const module of index.byFile.values()) {
    for (const entry of module.exports) {
      if (entry.type !== "local") continue;
      const list = byName.get(entry.exportedAs);
      if (list) list.push({ module, entry });
      else byName.set(entry.exportedAs, [{ module, entry }]);
    }
  }
  return byName;
});

/** Local export entries published as `exportedAs`, in module order and then entry order. */
export function localExportsNamed(index: ProjectIndex, exportedAs: string): readonly LocalExportRef[] {
  return localExportsByName(index).get(exportedAs) ?? [];
}

/**
 * C# modules with a namespace alias or `using N;` binding, keyed by the directory of each file the
 * binding reaches (`csharpNamespaceImportDirectories`): the importers whose binding targets a
 * definition's directory are the modules under that directory's key.
 */
export const csharpNamespaceImporters = perIndexCache((index): ReadonlyMap<string, readonly ModuleIndex[]> => {
  const targets = csharpNamespaceImportDirectories(index);
  const byDirectory = new Map<string, ModuleIndex[]>();
  for (const indexedModule of index.byFile.values()) {
    const module = withCsharpGlobalUsings(index, indexedModule);
    for (const imp of module.imports) {
      if (imp.csharpGlobal && typeof imp.resolved === "string") {
        const directory = fileIdentityKey(path.posix.dirname(normalizePath(imp.resolved)));
        pushDistinct(byDirectory, directory, module);
      }
      for (const target of csharpProjectUsingNamespaceFiles(imp) ?? targets.get(csharpGlobalUsingSource(imp)) ?? []) {
        pushDistinct(byDirectory, fileIdentityKey(path.posix.dirname(normalizePath(target))), module);
      }
    }
  }
  return byDirectory;
});

/** Per-definition reach proof for one compilation-global import, independent of candidate enumeration. */
export function csharpGlobalUsingReferenceMatcher(
  index: ProjectIndex,
  def: SymbolDef,
): ((binding: ImportBinding) => boolean) | undefined {
  const start = def.range.start.index;
  if (start === undefined) return undefined;
  const namespace = csharpNamespaceAt(index, def.file, start);
  if (namespace === null) return undefined;
  const definitionFile = fileIdentityKey(def.file);
  return (binding: ImportBinding): boolean => {
    if (!binding.csharpGlobal || typeof binding.resolved !== "string") return false;
    if (binding.kind === "named") {
      const target = resolveImported(index, binding, binding.imported);
      if (!target || "namespace" in target) return false;
      if (fileIdentityKey(target.file) !== definitionFile) return false;
      return target.range.start.index === start;
    }
    if (binding.kind === "star" && binding.staticMembersOf) {
      return !!def.isMember && fileIdentityKey(binding.resolved) === definitionFile;
    }
    const imported = csharpImportNamespace(binding);
    if (binding.kind === "namespace") return namespace === imported || namespace.startsWith(`${imported}.`);
    return binding.kind === "star" && namespace === imported;
  };
}

/** Global imports that can name this declaration, not every file that merely has a global System using. */
export function csharpGlobalUsingImporters(index: ProjectIndex, def: SymbolDef): readonly ModuleIndex[] {
  const importsDefinition = csharpGlobalUsingReferenceMatcher(index, def);
  if (!importsDefinition) return [];
  const directory = fileIdentityKey(path.posix.dirname(normalizePath(def.file)));
  return (csharpNamespaceImporters(index).get(directory) ?? []).filter((module) =>
    module.imports.some(importsDefinition),
  );
}

export type FlaggedModule = {
  readonly file: FileId;
  readonly key: string;
  /** Position in the module table, which the receiver scan's visited prefix is counted in. */
  readonly rank: number;
};

export type CoverageFacts = {
  /** Modules that recorded no syntax-error facts (`parseErrorRanges` unset), in table order. */
  readonly withoutParseInfo: readonly FlaggedModule[];
  /** Modules with an outermost `ERROR` or `MISSING` range, in table order. */
  readonly withParseErrors: readonly FlaggedModule[];
};

/** Per-file coverage facts every module contributes, so a lookup reads the few files it affects, not every module. */
export const coverageFacts = perIndexCache((index): CoverageFacts => {
  const withoutParseInfo: FlaggedModule[] = [];
  const withParseErrors: FlaggedModule[] = [];
  const entries = referenceModuleTable(index).entries;
  for (let rank = 0; rank < entries.length; rank += 1) {
    const entry = entries[rank]!;
    const module = index.byFile.get(fileIdentityKey(entry.file));
    if (!module) continue;
    if (module.parseErrorRanges === undefined) withoutParseInfo.push({ file: entry.file, key: entry.key, rank });
    else if (module.parseErrorRanges.length) withParseErrors.push({ file: entry.file, key: entry.key, rank });
  }
  return { withoutParseInfo, withParseErrors };
});

export type ParserReportFacts = {
  readonly entries: ReadonlyArray<{ readonly key: string; readonly file: FileId }>;
  readonly listed: ReadonlySet<string>;
};

type ParserReportLike = { files: ReadonlyArray<{ file: FileId }> };

const parserReportFacts = new WeakMap<
  ParserReportLike,
  { files: ParserReportLike["files"]; count: number; facts: ParserReportFacts }
>();

/** The files a parser degradation report lists, keyed once per report; a report whose list changed is read again. */
export function parserReportFactsFor(report: ParserReportLike): ParserReportFacts {
  const cached = parserReportFacts.get(report);
  if (cached && cached.files === report.files && cached.count === report.files.length) return cached.facts;
  const entries = report.files.map((entry) => ({ key: fileIdentityKey(entry.file), file: entry.file }));
  const facts = { entries, listed: new Set(entries.map((entry) => entry.key)) };
  parserReportFacts.set(report, { files: report.files, count: report.files.length, facts });
  return facts;
}
