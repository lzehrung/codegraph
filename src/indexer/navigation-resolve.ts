import fs from "node:fs";
import path from "node:path";
import { supportForFile } from "../languages.js";
import type { FileId } from "../types.js";
import { GO_IDENTIFIER_SOURCE, JAVA_IDENTIFIER_SOURCE, KOTLIN_IDENTIFIER_SOURCE } from "../util/identifiers.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import {
  type ExportEntry,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
  SymbolKind,
} from "./types.js";

const GO_PACKAGE_PATTERN = new RegExp(String.raw`^\s*package\s+(${GO_IDENTIFIER_SOURCE})`, "mu");
const JAVA_PACKAGE_NAME_PATTERN = new RegExp(
  String.raw`^\s*package\s+(${JAVA_IDENTIFIER_SOURCE}(?:\.${JAVA_IDENTIFIER_SOURCE})*)\s*;`,
  "mu",
);
const KOTLIN_PACKAGE_NAME_PATTERN = new RegExp(
  String.raw`^\s*package\s+(${KOTLIN_IDENTIFIER_SOURCE}(?:\.${KOTLIN_IDENTIFIER_SOURCE})*)`,
  "mu",
);

function cacheKey(file: FileId, canonicalName: string): string {
  return `${fileIdentityKey(file)}::canonical::${canonicalName}`;
}
type ModuleNameLookup = {
  normalizeIdentifier: (name: string) => string;
  localExports: Map<string, SymbolDef[]>;
  namespaceReexports: Map<string, Extract<ExportEntry, { type: "namespaceReexport" }>[]>;
  reexports: Map<string, Extract<ExportEntry, { type: "reexport" }>[]>;
  locals: Map<string, SymbolDef[]>;
};

type PackageDirectoryLookup = {
  all: ModuleIndex[];
  byName: Map<string, ModuleIndex[]>;
};

const moduleNameLookups = new WeakMap<ProjectIndex, Map<string, ModuleNameLookup>>();
const packageDirectoryLookups = new WeakMap<
  ProjectIndex,
  Map<"go" | "java" | "kotlin", Map<string, PackageDirectoryLookup>>
>();
type PackageNameCaches = Record<"go" | "jvm", Map<string, string | null>>;
const packageNameCaches = new WeakMap<ProjectIndex, PackageNameCaches>();

export type ResolveExportOptions = {
  preferredKind?: SymbolKind;
  allowLocalFallback?: boolean;
};

function moduleFor(index: ProjectIndex, file: FileId): ModuleIndex | undefined {
  return index.byFile.get(fileIdentityKey(file));
}

function moduleNameLookup(index: ProjectIndex, file: FileId): ModuleNameLookup | undefined {
  let lookups = moduleNameLookups.get(index);
  if (!lookups) {
    lookups = new Map<string, ModuleNameLookup>();
    for (const moduleEntry of index.byFile.values()) {
      const normalizeIdentifier =
        supportForFile(moduleEntry.file, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
      const localExports = new Map<string, SymbolDef[]>();
      const namespaceReexports = new Map<string, Extract<ExportEntry, { type: "namespaceReexport" }>[]>();
      const reexports = new Map<string, Extract<ExportEntry, { type: "reexport" }>[]>();
      const locals = new Map<string, SymbolDef[]>();
      for (const entry of moduleEntry.exports) {
        if (entry.type === "local") {
          const canonicalName = normalizeIdentifier(entry.exportedAs);
          const entries = localExports.get(canonicalName) ?? [];
          entries.push(entry.target);
          localExports.set(canonicalName, entries);
        } else if (entry.type === "namespaceReexport") {
          const canonicalName = normalizeIdentifier(entry.exportedAs);
          const entries = namespaceReexports.get(canonicalName) ?? [];
          entries.push(entry);
          namespaceReexports.set(canonicalName, entries);
        } else if (entry.type === "reexport") {
          const canonicalName = normalizeIdentifier(entry.exportedAs);
          const entries = reexports.get(canonicalName) ?? [];
          entries.push(entry);
          reexports.set(canonicalName, entries);
        }
      }
      for (const local of moduleEntry.locals) {
        const canonicalName = normalizeIdentifier(local.localName);
        const entries = locals.get(canonicalName) ?? [];
        entries.push(local);
        locals.set(canonicalName, entries);
      }
      lookups.set(fileIdentityKey(moduleEntry.file), {
        normalizeIdentifier,
        localExports,
        namespaceReexports,
        reexports,
        locals,
      });
    }
    moduleNameLookups.set(index, lookups);
  }
  return lookups.get(fileIdentityKey(file));
}

function sameSymbolDef(index: ProjectIndex, left: SymbolDef, right: SymbolDef): boolean {
  if (fileIdentityKey(left.file) !== fileIdentityKey(right.file) || left.kind !== right.kind) {
    return false;
  }
  const normalizeIdentifier =
    supportForFile(left.file, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
  if (normalizeIdentifier(left.localName) !== normalizeIdentifier(right.localName)) {
    return false;
  }

  const leftIndex = left.range.start.index;
  const rightIndex = right.range.start.index;
  if (typeof leftIndex === "number" && typeof rightIndex === "number") {
    return leftIndex === rightIndex;
  }

  return left.range.start.line === right.range.start.line && left.range.start.column === right.range.start.column;
}

function sameResolvedExport(index: ProjectIndex, left: ResolvedExport, right: ResolvedExport): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "resolved" && right.kind === "resolved") {
    return sameSymbolDef(index, left.def, right.def);
  }
  if (left.kind === "namespace" && right.kind === "namespace") {
    return fileIdentityKey(left.file) === fileIdentityKey(right.file);
  }
  return false;
}

function packageNameCacheFor(index: ProjectIndex): PackageNameCaches {
  let caches = packageNameCaches.get(index);
  if (!caches) {
    caches = { go: new Map<string, string | null>(), jvm: new Map<string, string | null>() };
    packageNameCaches.set(index, caches);
  }
  return caches;
}

function readGoPackageName(index: ProjectIndex, filePath: string): string | null {
  const cache = packageNameCacheFor(index).go;
  const key = fileIdentityKey(filePath);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const match = GO_PACKAGE_PATTERN.exec(source);
    const packageName = match?.[1] ?? null;
    cache.set(key, packageName);
    return packageName;
  } catch {
    cache.set(key, null);
    return null;
  }
}

function resolveGoPackageExport(index: ProjectIndex, file: FileId, exportedName: string): SymbolDef | null {
  try {
    const support = supportForFile(file, index.languageExtensions);
    if (!support || support.id !== "go") return null;
    const directory = packageDirectoryLookup(index, "go").get(fileIdentityKey(path.dirname(file)));
    if (!directory) return null;
    const sourcePackage = readGoPackageName(index, file);
    const candidates = sourcePackage ? (directory.byName.get(sourcePackage) ?? []) : directory.all;
    const matches: SymbolDef[] = [];
    for (const moduleEntry of candidates) {
      const names = moduleNameLookup(index, moduleEntry.file);
      if (!names) continue;
      for (const target of names.localExports.get(names.normalizeIdentifier(exportedName)) ?? []) {
        if (!matches.some((candidate) => sameSymbolDef(index, candidate, target))) {
          matches.push(target);
        }
      }
    }
    return matches.length === 1 ? (matches[0] ?? null) : null;
  } catch {
    // supportForFile throws on unsupported files (for example .json)
  }
  return null;
}

function readPackageNameForLanguage(
  index: ProjectIndex,
  filePath: string,
  languageId: "java" | "kotlin",
): string | null {
  const cache = packageNameCacheFor(index).jvm;
  const key = `${languageId}::${fileIdentityKey(filePath)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const packageName =
      languageId === "kotlin"
        ? (KOTLIN_PACKAGE_NAME_PATTERN.exec(source)?.[1] ?? null)
        : (JAVA_PACKAGE_NAME_PATTERN.exec(source)?.[1] ?? null);
    cache.set(key, packageName);
    return packageName;
  } catch {
    cache.set(key, null);
    return null;
  }
}

function packageDirectoryLookup(
  index: ProjectIndex,
  languageId: "go" | "java" | "kotlin",
): Map<string, PackageDirectoryLookup> {
  let byLanguage = packageDirectoryLookups.get(index);
  if (!byLanguage) {
    byLanguage = new Map<"go" | "java" | "kotlin", Map<string, PackageDirectoryLookup>>();
    packageDirectoryLookups.set(index, byLanguage);
  }
  const cached = byLanguage.get(languageId);
  if (cached) return cached;

  const directories = new Map<string, PackageDirectoryLookup>();
  for (const moduleEntry of index.byFile.values()) {
    const directoryKey = fileIdentityKey(path.dirname(moduleEntry.file));
    let directory = directories.get(directoryKey);
    if (!directory) {
      directory = { all: [], byName: new Map<string, ModuleIndex[]>() };
      directories.set(directoryKey, directory);
    }
    directory.all.push(moduleEntry);
    const packageName =
      languageId === "go"
        ? readGoPackageName(index, moduleEntry.file)
        : readPackageNameForLanguage(index, moduleEntry.file, languageId);
    if (!packageName) continue;
    const entries = directory.byName.get(packageName) ?? [];
    entries.push(moduleEntry);
    directory.byName.set(packageName, entries);
  }
  byLanguage.set(languageId, directories);
  return directories;
}
function resolveSiblingPackageExport(
  index: ProjectIndex,
  targetFile: string,
  exportedName: string,
  languageId: "java" | "kotlin",
): ResolvedExport | null {
  const packageName = readPackageNameForLanguage(index, targetFile, languageId);
  if (!packageName) return null;
  const directory = packageDirectoryLookup(index, languageId).get(fileIdentityKey(path.dirname(targetFile)));
  if (!directory) return null;
  const targetFileKey = fileIdentityKey(targetFile);
  const matches: ResolvedExport[] = [];
  for (const moduleEntry of directory.byName.get(packageName) ?? []) {
    if (fileIdentityKey(moduleEntry.file) === targetFileKey) continue;
    const hit = resolveExport(index, moduleEntry.file, exportedName);
    if (hit && !matches.some((candidate) => sameResolvedExport(index, candidate, hit))) {
      matches.push(hit);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function resolvePythonSubmodule(targetFile: string, exportedName: string): FileId | null {
  let baseDir: string;
  try {
    const targetStat = fs.statSync(targetFile);
    if (targetStat.isDirectory()) {
      baseDir = targetFile;
    } else if (path.basename(targetFile) === "__init__.py" || path.basename(targetFile) === "__init__.pyi") {
      baseDir = path.dirname(targetFile);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const moduleFile = path.join(baseDir, `${exportedName}.py`);
  const stubModuleFile = path.join(baseDir, `${exportedName}.pyi`);
  const packageInit = path.join(baseDir, exportedName, "__init__.py");
  const stubPackageInit = path.join(baseDir, exportedName, "__init__.pyi");
  const namespacePackage = path.join(baseDir, exportedName);
  for (const candidate of [moduleFile, stubModuleFile, packageInit, stubPackageInit, namespacePackage]) {
    try {
      const candidateStat = fs.statSync(candidate);
      if (candidate === namespacePackage ? candidateStat.isDirectory() : candidateStat.isFile()) {
        return normalizePath(candidate);
      }
    } catch {
      // The next candidate can still be a real submodule.
    }
  }

  return null;
}

export function resolveExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string,
  opts?: ResolveExportOptions,
): ResolvedExport | null {
  const visited = new Set<string>();
  const matchesPreferredKind = (def: SymbolDef): boolean => !opts?.preferredKind || def.kind === opts.preferredKind;
  const allowLocalFallback = opts?.allowLocalFallback ?? true;

  function resolveFromFile(fileInner: FileId, name: string): ResolvedExport | null {
    const moduleEntry = moduleFor(index, fileInner);
    if (!moduleEntry) return null;
    const names = moduleNameLookup(index, moduleEntry.file);
    if (!names) return null;
    const normalizedFile = normalizePath(moduleEntry.file);
    const canonicalName = names.normalizeIdentifier(name);
    const key = opts?.preferredKind
      ? `${cacheKey(normalizedFile, canonicalName)}::${opts.preferredKind}::${allowLocalFallback ? "local" : "export"}`
      : `${cacheKey(normalizedFile, canonicalName)}::${allowLocalFallback ? "local" : "export"}`;
    if (index.exportCache.has(key)) return index.exportCache.get(key)!;

    const cycleKey = cacheKey(normalizedFile, canonicalName);
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    const goPackageExport = resolveGoPackageExport(index, normalizedFile, canonicalName);
    if (goPackageExport && matchesPreferredKind(goPackageExport)) {
      const result: ResolvedExport = { kind: "resolved", def: goPackageExport };
      index.exportCache.set(key, result);
      return result;
    }

    const localCandidates: SymbolDef[] = [];
    for (const target of names.localExports.get(canonicalName) ?? []) {
      if (
        matchesPreferredKind(target) &&
        !localCandidates.some((candidate) => sameSymbolDef(index, candidate, target))
      ) {
        localCandidates.push(target);
      }
    }
    if (localCandidates.length === 1) {
      const target = localCandidates[0]!;
      const result: ResolvedExport = { kind: "resolved", def: target };
      index.exportCache.set(key, result);
      return result;
    }
    if (localCandidates.length) {
      index.exportCache.set(key, null);
      return null;
    }

    const namespaceCandidates = new Map<string, ResolvedExport>();
    for (const entry of names.namespaceReexports.get(canonicalName) ?? []) {
      const result: ResolvedExport = { kind: "namespace", file: normalizePath(entry.fromModule) };
      namespaceCandidates.set(fileIdentityKey(result.file), result);
    }
    if (namespaceCandidates.size === 1) {
      const result = namespaceCandidates.values().next().value!;
      index.exportCache.set(key, result);
      return result;
    }
    if (namespaceCandidates.size) {
      index.exportCache.set(key, null);
      return null;
    }

    const reexportCandidates: ResolvedExport[] = [];
    for (const entry of names.reexports.get(canonicalName) ?? []) {
      const downstream =
        resolveFromFile(entry.fromModule, entry.sourceSpecifier || canonicalName) ??
        resolveFromFile(entry.fromModule, canonicalName);
      if (downstream && !reexportCandidates.some((candidate) => sameResolvedExport(index, candidate, downstream))) {
        reexportCandidates.push(downstream);
      }
    }
    if (reexportCandidates.length === 1) {
      const result = reexportCandidates[0]!;
      index.exportCache.set(key, result);
      return result;
    }
    if (reexportCandidates.length) {
      index.exportCache.set(key, null);
      return null;
    }

    const starCandidates: ResolvedExport[] = [];
    for (const entry of moduleEntry.exports) {
      if (entry.type !== "exportStar") continue;
      const downstream = resolveFromFile(entry.fromModule, canonicalName);
      if (downstream && !starCandidates.some((candidate) => sameResolvedExport(index, candidate, downstream))) {
        starCandidates.push(downstream);
      }
    }
    const [onlyStarCandidate] = starCandidates;
    if (starCandidates.length === 1 && onlyStarCandidate) {
      index.exportCache.set(key, onlyStarCandidate);
      return onlyStarCandidate;
    }
    if (starCandidates.length) {
      index.exportCache.set(key, null);
      return null;
    }

    const localFallbackCandidates: SymbolDef[] = [];
    if (allowLocalFallback) {
      for (const local of names.locals.get(canonicalName) ?? []) {
        if (
          matchesPreferredKind(local) &&
          !localFallbackCandidates.some((candidate) => sameSymbolDef(index, candidate, local))
        ) {
          localFallbackCandidates.push(local);
        }
      }
    }
    if (localFallbackCandidates.length === 1) {
      const local = localFallbackCandidates[0]!;
      const result: ResolvedExport = { kind: "resolved", def: local };
      index.exportCache.set(key, result);
      return result;
    }
    if (localFallbackCandidates.length) {
      index.exportCache.set(key, null);
      return null;
    }

    index.exportCache.set(key, null);
    return null;
  }

  return resolveFromFile(file, exportedName);
}

function collectExportedNames(
  index: ProjectIndex,
  file: FileId,
  includeLocalFallback: boolean,
  names: Set<string>,
  visited: Set<FileId>,
): void {
  const fileKey = fileIdentityKey(file);
  if (visited.has(fileKey)) return;
  visited.add(fileKey);

  const moduleEntry = moduleFor(index, file);
  if (!moduleEntry) return;
  for (const entry of moduleEntry.exports) {
    if (entry.type === "exportStar") {
      collectExportedNames(index, entry.fromModule, includeLocalFallback, names, visited);
    } else {
      names.add(entry.exportedAs);
    }
  }
  if (includeLocalFallback) {
    for (const local of moduleEntry.locals) {
      names.add(local.localName);
    }
  }
}

export function resolveModuleExports(
  index: ProjectIndex,
  file: FileId,
  opts?: ResolveExportOptions,
): Map<string, ResolvedExport> {
  const names = new Set<string>();
  const includeLocalFallback = opts?.allowLocalFallback ?? true;
  collectExportedNames(index, file, includeLocalFallback, names, new Set<FileId>());

  const resolved = new Map<string, ResolvedExport>();
  for (const name of names) {
    const hit = resolveExport(index, file, name, opts);
    if (hit) resolved.set(name, hit);
  }
  return resolved;
}

export function resolveImported(
  index: ProjectIndex,
  imp: ImportBinding,
  exportedName: string,
): SymbolDef | { namespace: FileId } | null {
  const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return null;

  let preferredKind: SymbolKind | undefined;
  if (imp.kind === "named") {
    if (imp.phpImportType === "function") {
      preferredKind = SymbolKind.Function;
    } else if (imp.phpImportType === "class") {
      preferredKind = SymbolKind.Class;
    } else if (imp.phpImportType === "const") {
      preferredKind = SymbolKind.Variable;
    }
  }

  const hit = resolveExport(index, targetFile, exportedName, {
    ...(preferredKind ? { preferredKind } : {}),
  });
  if (hit?.kind === "resolved") return hit.def;
  if (hit?.kind === "namespace") return { namespace: hit.file };

  try {
    const support = supportForFile(targetFile);
    if (support?.id === "java" || support?.id === "kotlin") {
      const siblingHit = resolveSiblingPackageExport(index, targetFile, exportedName, support.id);
      if (siblingHit?.kind === "resolved") return siblingHit.def;
      if (siblingHit?.kind === "namespace") {
        return { namespace: siblingHit.file };
      }
    }
  } catch {
    // Unsupported file extension, cannot resolve sibling package exports.
  }

  try {
    const support = supportForFile(targetFile);
    if (support?.id === "python") {
      const submodule = resolvePythonSubmodule(targetFile, exportedName);
      if (submodule) return { namespace: submodule };
    }
  } catch {
    // Unsupported file extension, cannot resolve a Python submodule.
  }

  return null;
}
