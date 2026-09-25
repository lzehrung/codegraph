import fs from "node:fs";
import path from "node:path";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import type { FileId, Range } from "../types.js";
import {
  CSHARP_IDENTIFIER_SOURCE,
  GO_IDENTIFIER_SOURCE,
  JAVA_IDENTIFIER_SOURCE,
  KOTLIN_IDENTIFIER_SOURCE,
  normalizeCsharpQualifiedName,
} from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import { maskTrivia } from "../util/trivia.js";
import type { ProjectIndex } from "./types.js";

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
 * - Java/Kotlin files without a `package` clause (the unnamed package) have no provable unit
 *   beyond their own file, so they return only themselves with `complete: false`.
 * - Kotlin `internal` and C# `internal` declarations are hidden from module exports, so this
 *   lookup cannot see them across files; such references stay unresolved rather than being
 *   matched speculatively. Java package-private and Swift `internal` declarations are export
 *   entries and are matched normally.
 * - C# namespace visibility uses the declaration and use-site positions. A file-level lookup
 *   without a use position accepts a namespaced declaration only when every declared namespace
 *   can see it; it must not select a declaration visible in just one region.
 *
 * All facts are cached per `ProjectIndex` in memory only (like the existing package-directory
 * lookups) and are never persisted: they derive from indexed file paths and indexed file
 * sources, which the index already fingerprints per file. No build manifests or other
 * untracked inputs are read.
 */
export type CompilationUnitPeers = {
  files: ReadonlySet<FileId>;
  complete: boolean;
};

/** Languages whose files can name each other's top-level declarations without an import. */
export const IMPLICIT_UNIT_LANGUAGES: Readonly<Record<string, true>> = {
  go: true,
  java: true,
  kotlin: true,
  csharp: true,
  swift: true,
};

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

/**
 * Languages that share one unit identity namespace. Java and Kotlin share the JVM package
 * namespace, so a Kotlin sibling in the same package is as visible as a Java one.
 */
function unitLanguageGroup(languageId: string): string {
  if (languageId === "java" || languageId === "kotlin") return "jvm";
  return languageId;
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

/**
 * A C# namespace declaration and the source span it governs. A block-scoped namespace spans
 * from its `namespace` keyword to the matching `}`; a file-scoped one spans to end of file.
 * Nested block scopes compose their names (`Outer` and `Outer.Inner`), so the innermost region
 * containing a declaration is its namespace.
 */
export type CsharpNamespaceRegion = {
  name: string;
  start: number;
  end: number;
};

// A namespace name may be qualified (`namespace A.B { }`) and either block-scoped (closing
// `{`) or file-scoped (closing `;`). Mirrors the composition rule in
// `util/resolution/csharp.ts`, extended with spans so per-declaration namespaces can be read.
const CSHARP_NAMESPACE_DECLARATION_PATTERN = new RegExp(
  String.raw`(?<![\w@.])namespace\s+(${CSHARP_IDENTIFIER_SOURCE}(?:\s*\.\s*${CSHARP_IDENTIFIER_SOURCE})*)\s*[;{]`,
  "gu",
);

function collectCsharpNamespaceRegions(source: string): CsharpNamespaceRegion[] {
  const masked = maskTrivia(source, "csharp");
  const regions: CsharpNamespaceRegion[] = [];
  const scopes: Array<{ openedDepth: number; name: string; region: CsharpNamespaceRegion }> = [];
  let depth = 0;
  let cursor = 0;
  for (const match of masked.matchAll(CSHARP_NAMESPACE_DECLARATION_PATTERN)) {
    const matchIndex = match.index ?? 0;
    for (; cursor < matchIndex; cursor += 1) {
      const ch = masked[cursor];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        while (scopes.length && scopes[scopes.length - 1]!.openedDepth >= depth) {
          scopes.pop()!.region.end = cursor;
        }
      }
    }
    const namespaceName = match[1];
    if (!namespaceName) continue;
    // `namespace @P` and `namespace P` declare one namespace; compare normalized segments.
    const normalized = normalizeCsharpQualifiedName(namespaceName);
    const terminator = masked[matchIndex + match[0].length - 1];
    cursor = matchIndex + match[0].length;
    if (terminator !== "{") {
      // A file-scoped namespace is always top level and does not open a scope.
      regions.push({ name: normalized, start: matchIndex, end: masked.length });
      continue;
    }
    const enclosing = scopes.length ? scopes[scopes.length - 1]!.name : null;
    const qualified = enclosing ? `${enclosing}.${normalized}` : normalized;
    const region: CsharpNamespaceRegion = { name: qualified, start: matchIndex, end: masked.length };
    regions.push(region);
    scopes.push({ openedDepth: depth, name: qualified, region });
    depth += 1;
  }
  for (; cursor < masked.length; cursor += 1) {
    if (masked[cursor] === "{") {
      depth += 1;
    } else if (masked[cursor] === "}") {
      depth -= 1;
      while (scopes.length && scopes[scopes.length - 1]!.openedDepth >= depth) {
        scopes.pop()!.region.end = cursor;
      }
    }
  }
  while (scopes.length) {
    scopes.pop()!.region.end = masked.length;
  }
  return regions;
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

const csharpRegionCaches = new WeakMap<ProjectIndex, Map<string, readonly CsharpNamespaceRegion[] | null>>();

/**
 * Source to read a unit declaration from: the text the index already parsed when it retained
 * one, and otherwise the file itself. Reusing the retained text keeps the package or namespace
 * consistent with the symbols resolved from that same snapshot.
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
    const masked = maskTrivia(source, languageId);
    if (languageId === "go") {
      packageName = GO_PACKAGE_PATTERN.exec(masked)?.[1] ?? null;
    } else {
      const pattern = languageId === "kotlin" ? KOTLIN_PACKAGE_NAME_PATTERN : JAVA_PACKAGE_NAME_PATTERN;
      packageName = pattern.exec(masked)?.[1] ?? null;
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
 * The C# namespace regions of a file, or `null` when its source cannot be read. Cached per
 * index alongside the package-clause facts.
 */
export function getCsharpNamespaceRegions(
  index: ProjectIndex,
  filePath: string,
): readonly CsharpNamespaceRegion[] | null {
  const fileKey = fileIdentityKey(filePath);
  let cache = csharpRegionCaches.get(index);
  if (!cache) {
    cache = new Map<string, readonly CsharpNamespaceRegion[] | null>();
    csharpRegionCaches.set(index, cache);
  }
  const cached = cache.get(fileKey);
  if (cached !== undefined) return cached;
  const source = unitDeclarationSource(index, filePath, fileKey);
  const regions = source === null ? null : collectCsharpNamespaceRegions(source);
  cache.set(fileKey, regions);
  return regions;
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

  const languageId = supportForFileWithoutHeaderSample(file, index.languageExtensions)?.id;
  let identity: UnitIdentity;
  if (languageId === "go" || languageId === "java" || languageId === "kotlin") {
    const declaration = packageDeclarationFor(index, file, languageId);
    identity = { kind: "package", name: declaration.name, readable: declaration.readable };
  } else if (languageId === "csharp") {
    identity = { kind: "namespaces", regions: getCsharpNamespaceRegions(index, file) };
  } else if (languageId === "swift") {
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

function csharpNamespaceAtIndex(regions: readonly CsharpNamespaceRegion[], position: number | undefined): string {
  if (position === undefined) return "";
  let innermost: CsharpNamespaceRegion | undefined;
  for (const region of regions) {
    if (position < region.start || position >= region.end) continue;
    if (!innermost || region.start >= innermost.start) innermost = region;
  }
  return innermost?.name ?? "";
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
  grouped.extractedDirs.add(key);
  for (const file of grouped.filesByGroupDir.get(group)?.get(dirKey) ?? []) {
    recordUnitFact(grouped, unitFactFor(index, file));
  }
}

function extractGroupFacts(index: ProjectIndex, grouped: UnitFactIndex, group: string): void {
  if (grouped.extractedGroups.has(group)) return;
  grouped.extractedGroups.add(group);
  const dirs = grouped.filesByGroupDir.get(group);
  if (!dirs) return;
  for (const dirKey of dirs.keys()) {
    extractDirFacts(index, grouped, group, dirKey);
  }
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
    csharpRegionCaches.delete(index);
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
      // historical whole-directory lookup in that case; the JVM unnamed package has no
      // provable membership beyond the file itself.
      if (own.group === "go") {
        for (const fact of dirFacts) files.add(fact.file);
      }
      return { files, complete: false };
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
