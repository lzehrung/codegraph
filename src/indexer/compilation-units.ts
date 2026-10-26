import fs from "node:fs";
import path from "node:path";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import type { FileId, Range } from "../types.js";
import { GO_IDENTIFIER_SOURCE, JAVA_IDENTIFIER_SOURCE, KOTLIN_IDENTIFIER_SOURCE } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import { maskTrivia } from "../util/trivia.js";
import { CSHARP_FILE_LOCAL_PREFIX, csharpNamespaceAtIndex, type CsharpNamespaceRegion } from "../util/csharp-tree.js";
import { CSHARP_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRootSync } from "../util/resolution/files.js";
import { IMPORT_RESOLUTION_ROWS } from "./import-resolution-tables.js";
import type { ModuleIndex, ProjectIndex } from "./types.js";

/**
 * Proven same-compilation-unit peers for implicit bare-name visibility and shared-owner lookup
 * (C# partial classes, Swift extensions).
 *
 * The unit relation is deliberately narrow and matches the facts current resolution already
 * proves (`resolveGoPackageExport` / `resolveSiblingPackageExport`): the file's directory plus
 * its language unit identity - the `package` clause for Go and the JVM languages, declared C#
 * namespaces (including the global namespace), and the containing directory for Swift, whose
 * module identity is not declared in source. Lookup never falls back to a project-wide
 * same-name scan, so unrelated same-named declarations in other directories, packages,
 * namespaces, or modules are never bare-name peers. C# `Namespace.Type` and
 * `global::Namespace.Type` names may additionally search other same-directory C# files
 * whose namespaces are not related for bare-name lookup; that qualified set still stops
 * at the unit directory.
 *
 * Documented limits:
 * - No compiler/build-target inference: Maven/Gradle source roots, csproj items, and SwiftPM
 *   targets are not read. A package that legitimately spans directories (for example
 *   `src/main/java` and `src/test/java`) is one language-level unit that this directory-scoped
 *   relation only partially enumerates; `complete` reports `false` in that situation because
 *   same-identity files exist outside the unit directory.
 * - Go is directory-exact by language definition, so `complete` depends only on reading the
 *   package clause; the same package spelling in another directory is a different package.
 * - Java/Kotlin files without a `package` clause (the unnamed package) have no identity that
 *   groups files, so they return only themselves. `complete` is false when another indexed file
 *   has no package clause or an unreadable package, because that file might belong to the same
 *   unnamed package. When the index has no such file, this file is the whole unit and
 *   `complete` is true.
 * - Kotlin `internal` and C# `internal` declarations are hidden from module exports, so this
 *   lookup cannot see them across files; such references stay unresolved rather than being
 *   matched speculatively. Java package-private and Swift `internal` declarations are export
 *   entries and are matched normally.
 * - C# namespace visibility uses the declaration and use-site positions. A file-level lookup
 *   without a use position accepts a namespaced declaration only when every declared namespace
 *   can see it; it must not select a declaration visible in just one region.
 *
 * The aggregated facts are cached per `ProjectIndex` in memory only (like the existing package-directory
 * lookups). Go and JVM package clauses derive from indexed file sources, which the index already
 * fingerprints per file. A C# file's namespace regions are the one fact stored with its module: they come
 * from that file's own syntax tree and depend on no other file, so no lookup parses a C# file. The only
 * untracked input is the nearest `*.csproj` directory that bounds a C# alias lookup's project.
 */
export type CompilationUnitPeers = {
  files: ReadonlySet<FileId>;
  complete: boolean;
};

/** Languages whose files can name each other's top-level declarations without an import. */
export const IMPLICIT_UNIT_LANGUAGES: Readonly<Record<string, true>> = Object.fromEntries(
  Object.entries(IMPORT_RESOLUTION_ROWS).flatMap(([languageId, row]) =>
    row.implicitCompilationUnit ? [[languageId, true] as const] : [],
  ),
);

/**
 * Languages where the file itself is the whole unit: every cross-file reference must arrive
 * through an import/include/module edge the index already records.
 */
const SINGLE_FILE_UNIT_LANGUAGES: Readonly<Record<string, true>> = {
  c: true,
  cpp: true,
  js: true,
  ts: true,
  tsx: true,
  python: true,
  ruby: true,
  rust: true,
  zig: true,
};

/** Go, Java, and Kotlin read a package clause. Other package-kind languages are not parsed here. */
function packageClauseLanguage(languageId: string | undefined): languageId is "go" | "java" | "kotlin" {
  return languageId === "go" || languageId === "java" || languageId === "kotlin";
}

/**
 * Languages that share one unit identity namespace. Java and Kotlin share the JVM package
 * namespace, so a Kotlin sibling in the same package is as visible as a Java one.
 */
function unitLanguageGroup(languageId: string): string {
  return IMPORT_RESOLUTION_ROWS[languageId]?.implicitCompilationUnitGroup ?? languageId;
}

const GO_PACKAGE_PATTERN = new RegExp(String.raw`^\s*package\s+(${GO_IDENTIFIER_SOURCE})`, "mu");
const JAVA_PACKAGE_NAME_PATTERN = new RegExp(
  String.raw`^\s*package\s+(${JAVA_IDENTIFIER_SOURCE}(?:\.${JAVA_IDENTIFIER_SOURCE})*)\s*;`,
  "mu",
);
const KOTLIN_PACKAGE_NAME_PATTERN = new RegExp(
  String.raw`^\s*package\s+(${KOTLIN_IDENTIFIER_SOURCE}(?:\.${KOTLIN_IDENTIFIER_SOURCE})*)`,
  "mu",
);

/** Read a JVM package clause from the same trivia-masked source used for unit peers. */
export function jvmPackageNameFromSource(source: string, languageId: "java" | "kotlin"): string | null {
  const pattern = languageId === "kotlin" ? KOTLIN_PACKAGE_NAME_PATTERN : JAVA_PACKAGE_NAME_PATTERN;
  return pattern.exec(maskTrivia(source, languageId))?.[1] ?? null;
}

type PackageDeclaration = { name: string | null; readable: boolean };
type PackageNameCaches = Record<"go" | "jvm", Map<string, PackageDeclaration>>;
const packageNameCaches = new WeakMap<ProjectIndex, PackageNameCaches>();

function packageNameCacheFor(index: ProjectIndex): PackageNameCaches {
  let caches = packageNameCaches.get(index);
  if (!caches) {
    caches = { go: new Map<string, PackageDeclaration>(), jvm: new Map<string, PackageDeclaration>() };
    packageNameCaches.set(index, caches);
  }
  return caches;
}

/**
 * Source to read a unit declaration from: the text the index already parsed when it retained
 * one, and otherwise the file itself. Reusing the retained text keeps the package consistent
 * with the symbols resolved from that same snapshot.
 */
function unitDeclarationSource(index: ProjectIndex, filePath: string, fileKey: string): string | null {
  const retained = index.parsed?.get(fileKey)?.source;
  if (retained !== undefined) return retained;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * The declared package name of a Go or JVM file, or `null` when the file declares none (or its
 * source cannot be read). Cached per index so unit facts are read at most once per snapshot.
 */
function packageDeclarationFor(
  index: ProjectIndex,
  filePath: string,
  languageId: "go" | "java" | "kotlin",
): PackageDeclaration {
  const fileKey = fileIdentityKey(filePath);
  const cache = languageId === "go" ? packageNameCacheFor(index).go : packageNameCacheFor(index).jvm;
  const cacheKey = languageId === "go" ? fileKey : `${languageId}::${fileKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const source = unitDeclarationSource(index, filePath, fileKey);
  let packageName: string | null = null;
  if (source !== null) {
    if (languageId === "go") {
      packageName = GO_PACKAGE_PATTERN.exec(maskTrivia(source, "go"))?.[1] ?? null;
    } else {
      packageName = jvmPackageNameFromSource(source, languageId);
    }
  }
  const declaration = { name: packageName, readable: source !== null };
  cache.set(cacheKey, declaration);
  return declaration;
}

/** The declared package name, or null when absent or unreadable. */
export function getPackageDeclarationName(
  index: ProjectIndex,
  filePath: string,
  languageId: "go" | "java" | "kotlin",
): string | null {
  return packageDeclarationFor(index, filePath, languageId).name;
}

/**
 * The C# namespace regions of a file, read from its module's own facts, or `null` when its tree was
 * unavailable when it was indexed. Nothing is parsed here: the facts were stored with the module.
 */
export function getCsharpNamespaceRegions(
  index: ProjectIndex,
  filePath: string,
): readonly CsharpNamespaceRegion[] | null {
  return index.byFile.get(fileIdentityKey(filePath))?.csharpNamespaceFacts?.regions ?? null;
}

type UnitIdentity =
  | { kind: "package"; name: string | null; readable: boolean }
  | { kind: "namespaces"; regions: readonly CsharpNamespaceRegion[] | null }
  | { kind: "directory" }
  | { kind: "single-file" }
  | { kind: "unsupported" };

type UnitFact = {
  file: FileId;
  group: string;
  dirKey: string;
  identity: UnitIdentity;
};

const unitFactCaches = new WeakMap<ProjectIndex, Map<string, UnitFact>>();

function unitFactFor(index: ProjectIndex, file: FileId): UnitFact {
  let cache = unitFactCaches.get(index);
  if (!cache) {
    cache = new Map<string, UnitFact>();
    unitFactCaches.set(index, cache);
  }
  const fileKey = fileIdentityKey(file);
  const cached = cache.get(fileKey);
  if (cached) return cached;

  const support = supportForFileWithoutHeaderSample(file, index.languageExtensions);
  const languageId = support?.id;
  const unitKind = languageId === undefined ? undefined : IMPORT_RESOLUTION_ROWS[languageId]?.implicitCompilationUnit;
  let identity: UnitIdentity;
  if (unitKind === "package" && packageClauseLanguage(languageId)) {
    const declaration = packageDeclarationFor(index, file, languageId);
    identity = { kind: "package", name: declaration.name, readable: declaration.readable };
  } else if (unitKind === "namespace") {
    identity = { kind: "namespaces", regions: getCsharpNamespaceRegions(index, file) };
  } else if (unitKind === "module") {
    identity = { kind: "directory" };
  } else if (languageId !== undefined && SINGLE_FILE_UNIT_LANGUAGES[languageId]) {
    identity = { kind: "single-file" };
  } else {
    identity = { kind: "unsupported" };
  }
  const fact: UnitFact = {
    file,
    group: languageId === undefined ? "unsupported" : unitLanguageGroup(languageId),
    dirKey: fileIdentityKey(path.dirname(file)),
    identity,
  };
  cache.set(fileKey, fact);
  return fact;
}

/**
 * C# namespace names are related when they are equal, one nests inside the other, or either is
 * the global namespace. Two files are potentially visible to each other as bare names when any
 * pair of their declared namespaces is related. A file that also declares unrelated namespaces
 * is still not a bare-name peer of those namespaces; qualified lookup uses the same-directory
 * set instead.
 */
function csharpNamespacesRelated(left: string, right: string): boolean {
  if (left === right || left === "" || right === "") return true;
  return left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function csharpNamespacesComparable(
  left: readonly CsharpNamespaceRegion[],
  right: readonly CsharpNamespaceRegion[],
): boolean {
  // A file without any namespace declaration lives entirely in the global namespace, which is
  // an ancestor of every namespace and comparable with all of them.
  if (!left.length || !right.length) return true;
  for (const leftRegion of left) {
    for (const rightRegion of right) {
      if (csharpNamespacesRelated(leftRegion.name, rightRegion.name)) return true;
    }
  }
  return false;
}

/** The normalized C# namespace enclosing `position` in a file (`""` for global), or `null` when unreadable. */
export function csharpNamespaceAt(index: ProjectIndex, filePath: string, position: number): string | null {
  const regions = getCsharpNamespaceRegions(index, filePath);
  return regions ? csharpNamespaceAtIndex(regions, position) : null;
}

type CsharpDeclaredNames = {
  source: ProjectIndex["byFile"];
  size: number;
  /** Importer directory to its project boundary key: the directory its namespace imports scan, `""` for the root. */
  boundaries: Map<string, string>;
  /** Project boundary to the names its C# files declare; `null` when one of those files' declarations is unknown. */
  names: Map<string, ReadonlySet<string> | null>;
};

const csharpDeclaredNameCaches = new WeakMap<ProjectIndex, CsharpDeclaredNames>();

/**
 * The names the indexed C# files under `boundaryKey` declare (every indexed C# file when it is empty), from the
 * namespace regions and types each module records. `null` when one of those files has no recorded facts.
 */
function aggregateCsharpDeclaredNames(index: ProjectIndex, boundaryKey: string): ReadonlySet<string> | null {
  const boundaryPrefix = boundaryKey.endsWith("/") ? boundaryKey : `${boundaryKey}/`;
  const names = new Set<string>();
  // Declaring `A.B.T` also makes `A` and `A.B` exist, so each prefix is a declared name too.
  const addDeclaredName = (name: string): void => {
    for (let dot = name.indexOf("."); dot >= 0; dot = name.indexOf(".", dot + 1)) names.add(name.slice(0, dot));
    names.add(name);
  };
  for (const moduleEntry of index.byFile.values()) {
    if (supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.id !== "csharp") continue;
    if (boundaryKey && !fileIdentityKey(moduleEntry.file).startsWith(boundaryPrefix)) continue;
    const facts = moduleEntry.csharpNamespaceFacts;
    if (!facts) return null;
    for (const region of facts.regions) {
      if (region.name) addDeclaredName(region.name);
    }
    for (const type of facts.types) {
      if (!type.startsWith(CSHARP_FILE_LOCAL_PREFIX)) addDeclaredName(type);
    }
  }
  return names;
}

/**
 * The names the indexed C# files of `file`'s project declare, or `null` when one of them has no recorded
 * declarations. The project is the directory that `resolveCsharpNamespaceImportPaths` scans for `file`: its
 * nearest `*.csproj` directory, else the project root. Each module records only its own declarations; they are
 * combined here, once per index and project, so an added, changed, or deleted file changes the answer without
 * touching any other file's cached module.
 */
function csharpProjectDeclaredNames(index: ProjectIndex, file: FileId): ReadonlySet<string> | null {
  let cached = csharpDeclaredNameCaches.get(index);
  if (!cached || cached.source !== index.byFile || cached.size !== index.byFile.size) {
    cached = { source: index.byFile, size: index.byFile.size, boundaries: new Map(), names: new Map() };
    csharpDeclaredNameCaches.set(index, cached);
  }
  const directoryKey = fileIdentityKey(path.dirname(file));
  let boundaryKey = cached.boundaries.get(directoryKey);
  if (boundaryKey === undefined) {
    const projectRoot = index.projectRoot;
    const projectKey = projectRoot
      ? fileIdentityKey(resolveNearestManifestRootSync(projectRoot, file, CSHARP_PACKAGE_MANIFEST_NAMES))
      : "";
    // The project root bounds every indexed file, so only a project below it restricts which files count.
    boundaryKey = projectRoot && projectKey === fileIdentityKey(projectRoot) ? "" : projectKey;
    cached.boundaries.set(directoryKey, boundaryKey);
  }
  let names = cached.names.get(boundaryKey);
  if (names === undefined) {
    names = aggregateCsharpDeclaredNames(index, boundaryKey);
    cached.names.set(boundaryKey, names);
  }
  return names;
}

/**
 * Whether `namespaceName` or one of its enclosing namespaces (the global namespace excluded) has a
 * namespace or type member called `name` in any indexed C# file of `mod`'s project, or a `file` type of
 * that name in `mod`'s own file, the only one that can see it. Unknown when an indexed C# file of the project
 * has no recorded declarations, which answers `true` because that file could declare it.
 */
export function csharpNamespaceChainDeclares(
  index: ProjectIndex,
  mod: ModuleIndex,
  namespaceName: string,
  name: string,
): boolean {
  const names = csharpProjectDeclaredNames(index, mod.file);
  if (!names) return true;
  for (let end = namespaceName.length; end > 0; end = namespaceName.lastIndexOf(".", end - 1)) {
    const declared = `${namespaceName.slice(0, end)}.${name}`;
    if (names.has(declared) || mod.csharpNamespaceFacts?.types.includes(CSHARP_FILE_LOCAL_PREFIX + declared))
      return true;
  }
  return false;
}

/**
 * Whether an indexed C# file of `mod`'s project has no recorded declarations because its syntax tree was
 * unavailable. That file could declare any type, so a type found once in the project is not proven the only one.
 */
export function csharpProjectDeclarationsUnknown(index: ProjectIndex, mod: ModuleIndex): boolean {
  return !csharpProjectDeclaredNames(index, mod.file);
}

function csharpNamespaceVisibleFromUseFile(
  declarationNamespace: string,
  useRegions: readonly CsharpNamespaceRegion[],
  useIndex?: number,
): boolean {
  // The global namespace is the last step of every bare-name lookup.
  if (declarationNamespace === "") return true;
  const visibleFrom = (name: string): boolean =>
    name === declarationNamespace || name.startsWith(`${declarationNamespace}.`);
  if (useIndex !== undefined) return visibleFrom(csharpNamespaceAtIndex(useRegions, useIndex));
  return !!useRegions.length && useRegions.every((region) => visibleFrom(region.name));
}

/**
 * True when a top-level declaration at `declaration` in `declarationFile` can be named without
 * an import from within `useFile`. Both files must already share a compilation unit (see
 * `getCompilationUnitPeers`); this refines the file-level relation at declaration granularity,
 * which only matters for C# files that declare several namespaces. For every other unit
 * language the file-level identity is the full visibility rule.
 */
export function isUnitBareNameVisible(args: {
  index: ProjectIndex;
  declarationFile: FileId;
  declaration: Range;
  useFile: FileId;
  useIndex?: number;
  qualification?: string;
}): boolean {
  const declarationFact = unitFactFor(args.index, args.declarationFile);
  if (declarationFact.identity.kind !== "namespaces") return true;
  const declarationRegions = declarationFact.identity.regions;
  if (!declarationRegions) return true;
  const useFact = unitFactFor(args.index, args.useFile);
  if (useFact.identity.kind !== "namespaces") return true;
  const useRegions = useFact.identity.regions;
  if (!useRegions) return false;
  if (args.qualification !== undefined) {
    const declared = csharpNamespaceAtIndex(declarationRegions, args.declaration.start.index);
    const qualifier = args.qualification;
    if (qualifier.startsWith("global::")) return declared === qualifier.slice("global::".length);
    let enclosing = csharpNamespaceAtIndex(useRegions, args.useIndex);
    while (enclosing) {
      if (declared === `${enclosing}.${qualifier}`) return true;
      const separator = enclosing.lastIndexOf(".");
      enclosing = separator < 0 ? "" : enclosing.slice(0, separator);
    }
    return declared === qualifier;
  }
  return csharpNamespaceVisibleFromUseFile(
    csharpNamespaceAtIndex(declarationRegions, args.declaration.start.index),
    useRegions,
    args.useIndex,
  );
}

function identityCompatible(own: UnitIdentity, other: UnitIdentity): boolean {
  switch (own.kind) {
    case "package":
      return other.kind === "package" && own.name === other.name;
    case "namespaces":
      return (
        other.kind === "namespaces" &&
        own.regions !== null &&
        other.regions !== null &&
        csharpNamespacesComparable(own.regions, other.regions)
      );
    case "directory":
      return other.kind === "directory";
    default:
      return false;
  }
}

type CsharpNamespaceIndex = {
  /** Only directories with readable namespace facts contribute to bare-name completeness. */
  directories: Set<string>;
  globalDirs: Set<string>;
  exactDirs: Map<string, Set<string>>;
  descendantDirs: Map<string, Set<string>>;
};

type UnitFactIndex = {
  /** Language group -> directory identity key -> files in that directory, from paths only. */
  filesByGroupDir: Map<string, Map<string, FileId[]>>;
  /** Language group -> directory identity key -> facts in that directory. */
  byGroupDir: Map<string, Map<string, UnitFact[]>>;
  /** Language group -> directory -> package name -> facts that declare that package. */
  byGroupDirPackage: Map<string, Map<string, Map<string, UnitFact[]>>>;
  /** Language group -> package name -> directories that declare it. */
  packageDirs: Map<string, Map<string, Set<string>>>;
  /** Language group -> directories containing an indexed source whose unit identity is unreadable. */
  unreadableDirs: Map<string, Set<string>>;
  csharpNamespaces: CsharpNamespaceIndex;
  /** Language groups whose sources have been read into the fact maps. */
  extractedGroups: Set<string>;
  /** `${group}\0${dirKey}` directories whose sources have been read into the fact maps. */
  extractedDirs: Set<string>;
};

type CachedUnitFactIndex = {
  facts: UnitFactIndex;
  peers: Map<string, CompilationUnitPeers>;
  source: ProjectIndex["byFile"];
  size: number;
  languageExtensions: ProjectIndex["languageExtensions"];
};

const unitFactIndexes = new WeakMap<ProjectIndex, CachedUnitFactIndex>();

function mapEntry<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing) return existing;
  const created = create();
  map.set(key, created);
  return created;
}

function recordCsharpNamespaces(
  namespaces: CsharpNamespaceIndex,
  dirKey: string,
  regions: readonly CsharpNamespaceRegion[],
): void {
  namespaces.directories.add(dirKey);
  if (!regions.length) namespaces.globalDirs.add(dirKey);
  for (const region of regions) {
    const name = region.name;
    if (!name) {
      namespaces.globalDirs.add(dirKey);
      continue;
    }
    mapEntry(namespaces.exactDirs, name, () => new Set<string>()).add(dirKey);
    let dot = name.indexOf(".");
    while (dot >= 0) {
      mapEntry(namespaces.descendantDirs, name.slice(0, dot), () => new Set<string>()).add(dirKey);
      dot = name.indexOf(".", dot + 1);
    }
  }
}

function emptyCsharpNamespaces(): CsharpNamespaceIndex {
  return {
    directories: new Set<string>(),
    globalDirs: new Set<string>(),
    exactDirs: new Map<string, Set<string>>(),
    descendantDirs: new Map<string, Set<string>>(),
  };
}

function createUnitFactIndex(): UnitFactIndex {
  return {
    filesByGroupDir: new Map(),
    byGroupDir: new Map(),
    byGroupDirPackage: new Map(),
    packageDirs: new Map(),
    unreadableDirs: new Map(),
    csharpNamespaces: emptyCsharpNamespaces(),
    extractedGroups: new Set<string>(),
    extractedDirs: new Set<string>(),
  };
}

function recordUnitFact(grouped: UnitFactIndex, fact: UnitFact): void {
  if (fact.identity.kind === "single-file" || fact.identity.kind === "unsupported") return;

  mapEntry(
    mapEntry(grouped.byGroupDir, fact.group, () => new Map()),
    fact.dirKey,
    () => [] as UnitFact[],
  ).push(fact);
  if (
    (fact.identity.kind === "package" && !fact.identity.readable) ||
    (fact.identity.kind === "namespaces" && fact.identity.regions === null)
  ) {
    mapEntry(grouped.unreadableDirs, fact.group, () => new Set<string>()).add(fact.dirKey);
  }

  if (fact.identity.kind === "package" && fact.identity.name !== null) {
    const packageName = fact.identity.name;
    mapEntry(
      mapEntry(
        mapEntry(grouped.byGroupDirPackage, fact.group, () => new Map()),
        fact.dirKey,
        () => new Map(),
      ),
      packageName,
      () => [] as UnitFact[],
    ).push(fact);
    mapEntry(
      mapEntry(grouped.packageDirs, fact.group, () => new Map()),
      packageName,
      () => new Set<string>(),
    ).add(fact.dirKey);
  }

  if (fact.group === "csharp" && fact.identity.kind === "namespaces" && fact.identity.regions) {
    recordCsharpNamespaces(grouped.csharpNamespaces, fact.dirKey, fact.identity.regions);
  }
}

function extractedDirKey(group: string, dirKey: string): string {
  return `${group}\0${dirKey}`;
}

function extractDirFacts(index: ProjectIndex, grouped: UnitFactIndex, group: string, dirKey: string): void {
  const key = extractedDirKey(group, dirKey);
  if (grouped.extractedDirs.has(key)) return;
  for (const file of grouped.filesByGroupDir.get(group)?.get(dirKey) ?? []) {
    recordUnitFact(grouped, unitFactFor(index, file));
  }
  // Registered once every file is recorded: a directory that failed midway is read again, not trusted half-filled.
  grouped.extractedDirs.add(key);
}

function extractGroupFacts(index: ProjectIndex, grouped: UnitFactIndex, group: string): void {
  if (grouped.extractedGroups.has(group)) return;
  for (const dirKey of grouped.filesByGroupDir.get(group)?.keys() ?? []) {
    extractDirFacts(index, grouped, group, dirKey);
  }
  grouped.extractedGroups.add(group);
}

function ensureFactsFor(index: ProjectIndex, grouped: UnitFactIndex, own: UnitFact): void {
  // Swift completeness is a path question; skip source reads until a package or namespace
  // identity actually needs them.
  if (own.identity.kind === "directory") return;
  // Go packages are directory-exact, so other Go directories are never peers and must not
  // be opened just to build this file's set.
  if (own.group === "go") {
    extractDirFacts(index, grouped, own.group, own.dirKey);
    return;
  }
  extractGroupFacts(index, grouped, own.group);
}

/**
 * Group unit files once per `ProjectIndex` so each file's peer set is derived from a shared
 * directory/package index instead of visiting every indexed module again.
 *
 * The grouping scan uses configured extensions and paths only. Package clauses and C# namespaces
 * are read later, and only for the language group (and, for Go, directory) of the file whose
 * peers were requested, so a Go lookup never opens JVM sources and a JVM lookup never opens
 * Go sources. The cache is tied to the index's `byFile` map identity, size, and language
 * extension mapping so a warm index that later gains, loses, or remaps files rebuilds instead
 * of returning stale peers.
 */
function cachedUnitFactIndexFor(index: ProjectIndex): CachedUnitFactIndex {
  const cached = unitFactIndexes.get(index);
  if (
    cached &&
    cached.source === index.byFile &&
    cached.size === index.byFile.size &&
    cached.languageExtensions === index.languageExtensions
  ) {
    return cached;
  }
  if (cached && (cached.source !== index.byFile || cached.languageExtensions !== index.languageExtensions)) {
    unitFactCaches.delete(index);
    packageNameCaches.delete(index);
  }

  const facts = createUnitFactIndex();
  for (const moduleEntry of index.byFile.values()) {
    const languageId = supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.id;
    if (!languageId || !IMPLICIT_UNIT_LANGUAGES[languageId]) continue;
    const group = unitLanguageGroup(languageId);
    const dirKey = fileIdentityKey(path.dirname(moduleEntry.file));
    mapEntry(
      mapEntry(facts.filesByGroupDir, group, () => new Map()),
      dirKey,
      () => [] as FileId[],
    ).push(moduleEntry.file);
  }

  const built: CachedUnitFactIndex = {
    facts,
    peers: new Map<string, CompilationUnitPeers>(),
    source: index.byFile,
    size: index.byFile.size,
    languageExtensions: index.languageExtensions,
  };
  unitFactIndexes.set(index, built);
  return built;
}

function groupHasOtherDirectory(
  dirs: { readonly size: number; has(key: string): boolean } | undefined,
  dirKey: string,
): boolean {
  if (!dirs || dirs.size === 0) return false;
  return dirs.size > 1 || !dirs.has(dirKey);
}

function csharpRelatedNamespaceOutside(
  regions: readonly CsharpNamespaceRegion[],
  ownDirKey: string,
  namespaces: CsharpNamespaceIndex,
): boolean {
  if (!regions.length || regions.some((region) => !region.name)) {
    return groupHasOtherDirectory(namespaces.directories, ownDirKey);
  }
  if (groupHasOtherDirectory(namespaces.globalDirs, ownDirKey)) return true;
  for (const region of regions) {
    let name = region.name;
    while (name) {
      if (groupHasOtherDirectory(namespaces.exactDirs.get(name), ownDirKey)) return true;
      const dot = name.lastIndexOf(".");
      name = dot < 0 ? "" : name.slice(0, dot);
    }
    if (groupHasOtherDirectory(namespaces.descendantDirs.get(region.name), ownDirKey)) return true;
  }
  return false;
}

/**
 * Every indexed file that shares a proven compilation unit with `file`, including `file`
 * itself. `complete` is `false` when the unit boundary cannot be proven: the identity is
 * unreadable, the language's unit is not file/directory derivable, or same-identity files
 * exist outside the unit directory so the unit may extend beyond it. Consumers must retain
 * the proven peer set and report partial coverage instead of implying that every possible
 * peer was considered.
 *
 * Pass `csharpQualifiedName` for C# `Namespace.Type` / `global::Namespace.Type` lookup so
 * same-directory files whose namespaces are not related for bare names are still searched.
 * Qualified names can also cross otherwise unrelated namespaces outside the directory,
 * so those files leave the qualified candidate set incomplete. Other languages ignore the flag.
 */
export function getCompilationUnitPeers(
  index: ProjectIndex,
  file: FileId,
  options?: { csharpQualifiedName?: boolean },
): CompilationUnitPeers {
  const cached = cachedUnitFactIndexFor(index);
  const fileKey = fileIdentityKey(file);
  const cacheKey = options?.csharpQualifiedName ? `${fileKey}::qualified` : fileKey;
  const previous = cached.peers.get(cacheKey);
  if (previous) return previous;

  const result = computeUnitPeers(index, cached.facts, unitFactFor(index, file), !!options?.csharpQualifiedName);
  cached.peers.set(cacheKey, result);
  return result;
}

/** Another indexed JVM file with no package clause might share the unnamed package. */
function jvmGroupHasOtherUnnamedFile(grouped: UnitFactIndex, own: UnitFact): boolean {
  const dirs = grouped.byGroupDir.get(own.group);
  if (!dirs) return false;
  const ownKey = fileIdentityKey(own.file);
  for (const facts of dirs.values()) {
    for (const fact of facts) {
      if (fileIdentityKey(fact.file) === ownKey) continue;
      if (fact.identity.kind === "package" && fact.identity.name === null) return true;
    }
  }
  return false;
}

function computeUnitPeers(
  index: ProjectIndex,
  grouped: UnitFactIndex,
  own: UnitFact,
  includeUnrelatedCsharpDirectoryPeers = false,
): CompilationUnitPeers {
  const files = new Set<FileId>([own.file]);
  if (own.identity.kind === "single-file") return { files, complete: true };
  if (own.identity.kind === "unsupported") return { files, complete: false };

  ensureFactsFor(index, grouped, own);
  const dirFacts = grouped.byGroupDir.get(own.group)?.get(own.dirKey) ?? [];
  const groupDirs = grouped.filesByGroupDir.get(own.group);
  const unreadableDirs = grouped.unreadableDirs.get(own.group);
  const hasUnreadablePeer = own.group === "go" ? !!unreadableDirs?.has(own.dirKey) : !!unreadableDirs?.size;

  if (own.identity.kind === "package") {
    if (own.identity.name === null) {
      // A missing or unreadable `package` clause has no proven identity. Go keeps its
      // historical whole-directory lookup in that case. The JVM unnamed package cannot group
      // files, so peers stay this file; the unit is complete only when no other indexed file
      // could still belong to that unnamed package.
      if (own.group === "go") {
        for (const fact of dirFacts) files.add(fact.file);
        return { files, complete: false };
      }
      return { files, complete: !hasUnreadablePeer && !jvmGroupHasOtherUnnamedFile(grouped, own) };
    }
    const packageFacts = grouped.byGroupDirPackage.get(own.group)?.get(own.dirKey)?.get(own.identity.name) ?? [];
    for (const fact of packageFacts) files.add(fact.file);
    // Go packages are exactly one directory by language definition, so the directory is the
    // whole unit as long as the package clause is readable. A JVM package can span
    // directories (for example sibling source roots), so its unit is only proven while no
    // same-package file sits outside the directory this relation enumerates.
    const complete =
      !hasUnreadablePeer &&
      (own.group === "go" ||
        !groupHasOtherDirectory(grouped.packageDirs.get(own.group)?.get(own.identity.name), own.dirKey));
    return { files, complete };
  }

  if (own.identity.kind === "namespaces") {
    if (!own.identity.regions) return { files, complete: false };
    for (const fact of dirFacts) {
      if (
        includeUnrelatedCsharpDirectoryPeers &&
        fact.identity.kind === "namespaces" &&
        fact.identity.regions !== null
      ) {
        files.add(fact.file);
        continue;
      }
      if (identityCompatible(own.identity, fact.identity)) files.add(fact.file);
    }
    const complete =
      !hasUnreadablePeer &&
      (includeUnrelatedCsharpDirectoryPeers
        ? !groupHasOtherDirectory(groupDirs, own.dirKey)
        : !csharpRelatedNamespaceOutside(own.identity.regions, own.dirKey, grouped.csharpNamespaces));
    return { files, complete };
  }

  for (const file of groupDirs?.get(own.dirKey) ?? []) files.add(file);
  // Swift module membership is not declared in source; a same-module file outside the
  // directory would belong to the same implicit unit but cannot be proven to.
  return { files, complete: !groupHasOtherDirectory(groupDirs, own.dirKey) };
}
