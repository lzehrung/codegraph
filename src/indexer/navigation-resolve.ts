import fs from "node:fs";
import path from "node:path";
import { supportForFile } from "../languages.js";
import type { FileId } from "../types.js";
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

function cacheKey(file: FileId, name: string): string {
  return `${fileIdentityKey(file)}::${name}`;
}
type ModuleNameLookup = {
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
const goPackageNameCache = new Map<FileId, string | null>();
const packageNameCache = new Map<string, string | null>();

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
      const localExports = new Map<string, SymbolDef[]>();
      const namespaceReexports = new Map<string, Extract<ExportEntry, { type: "namespaceReexport" }>[]>();
      const reexports = new Map<string, Extract<ExportEntry, { type: "reexport" }>[]>();
      const locals = new Map<string, SymbolDef[]>();
      for (const entry of moduleEntry.exports) {
        if (entry.type === "local") {
          const entries = localExports.get(entry.exportedAs) ?? [];
          entries.push(entry.target);
          localExports.set(entry.exportedAs, entries);
        } else if (entry.type === "namespaceReexport") {
          const entries = namespaceReexports.get(entry.exportedAs) ?? [];
          entries.push(entry);
          namespaceReexports.set(entry.exportedAs, entries);
        } else if (entry.type === "reexport") {
          const entries = reexports.get(entry.exportedAs) ?? [];
          entries.push(entry);
          reexports.set(entry.exportedAs, entries);
        }
      }
      for (const local of moduleEntry.locals) {
        const entries = locals.get(local.localName) ?? [];
        entries.push(local);
        locals.set(local.localName, entries);
      }
      lookups.set(fileIdentityKey(moduleEntry.file), { localExports, namespaceReexports, reexports, locals });
    }
    moduleNameLookups.set(index, lookups);
  }
  return lookups.get(fileIdentityKey(file));
}

function sameSymbolDef(left: SymbolDef, right: SymbolDef): boolean {
  if (
    fileIdentityKey(left.file) !== fileIdentityKey(right.file) ||
    left.localName !== right.localName ||
    left.kind !== right.kind
  ) {
    return false;
  }

  const leftIndex = left.range.start.index;
  const rightIndex = right.range.start.index;
  if (typeof leftIndex === "number" && typeof rightIndex === "number") {
    return leftIndex === rightIndex;
  }

  return left.range.start.line === right.range.start.line && left.range.start.column === right.range.start.column;
}

function sameResolvedExport(left: ResolvedExport, right: ResolvedExport): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "resolved" && right.kind === "resolved") {
    return sameSymbolDef(left.def, right.def);
  }
  if (left.kind === "namespace" && right.kind === "namespace") {
    return fileIdentityKey(left.file) === fileIdentityKey(right.file);
  }
  return false;
}

function readGoPackageName(filePath: string): string | null {
  const key = fileIdentityKey(filePath);
  const cached = goPackageNameCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const match = source.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m);
    const packageName = match?.[1] ?? null;
    goPackageNameCache.set(key, packageName);
    return packageName;
  } catch {
    goPackageNameCache.set(key, null);
    return null;
  }
}

function resolveGoPackageExport(index: ProjectIndex, file: FileId, exportedName: string): SymbolDef | null {
  try {
    const support = supportForFile(file);
    if (!support || support.id !== "go") return null;
    const directory = packageDirectoryLookup(index, "go").get(fileIdentityKey(path.dirname(file)));
    if (!directory) return null;
    const sourcePackage = readGoPackageName(file);
    const candidates = sourcePackage ? directory.byName.get(sourcePackage) ?? [] : directory.all;
    for (const moduleEntry of candidates) {
      const exportEntry = moduleNameLookup(index, moduleEntry.file)?.localExports.get(exportedName)?.[0];
      if (exportEntry) return exportEntry;
    }
  } catch {
    // supportForFile throws on unsupported files (for example .json)
  }
  return null;
}

function readPackageNameForLanguage(filePath: string, languageId: "java" | "kotlin"): string | null {
  const key = `${languageId}::${fileIdentityKey(filePath)}`;
  const cached = packageNameCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const packageName =
      languageId === "kotlin"
        ? (source.match(/^\s*package\s+([A-Za-z_][\w.]*)/m)?.[1] ?? null)
        : (source.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m)?.[1] ?? null);
    packageNameCache.set(key, packageName);
    return packageName;
  } catch {
    packageNameCache.set(key, null);
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
        ? readGoPackageName(moduleEntry.file)
        : readPackageNameForLanguage(moduleEntry.file, languageId);
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
  const packageName = readPackageNameForLanguage(targetFile, languageId);
  if (!packageName) return null;
  const directory = packageDirectoryLookup(index, languageId).get(fileIdentityKey(path.dirname(targetFile)));
  if (!directory) return null;
  const targetFileKey = fileIdentityKey(targetFile);
  for (const moduleEntry of directory.byName.get(packageName) ?? []) {
    if (fileIdentityKey(moduleEntry.file) === targetFileKey) continue;
    const hit = resolveExport(index, moduleEntry.file, exportedName);
    if (hit) return hit;
  }
  return null;
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
    const key = opts?.preferredKind
      ? `${cacheKey(normalizedFile, name)}::${opts.preferredKind}::${allowLocalFallback ? "local" : "export"}`
      : `${cacheKey(normalizedFile, name)}::${allowLocalFallback ? "local" : "export"}`;
    if (index.exportCache.has(key)) return index.exportCache.get(key)!;

    const cycleKey = cacheKey(normalizedFile, name);
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    const goPackageExport = resolveGoPackageExport(index, normalizedFile, name);
    if (goPackageExport && matchesPreferredKind(goPackageExport)) {
      const result: ResolvedExport = { kind: "resolved", def: goPackageExport };
      index.exportCache.set(key, result);
      return result;
    }

    for (const target of names.localExports.get(name) ?? []) {
      if (matchesPreferredKind(target)) {
        const result: ResolvedExport = { kind: "resolved", def: target };
        index.exportCache.set(key, result);
        return result;
      }
    }

    for (const entry of names.namespaceReexports.get(name) ?? []) {
      const result: ResolvedExport = {
        kind: "namespace",
        file: normalizePath(entry.fromModule),
      };
      index.exportCache.set(key, result);
      return result;
    }

    for (const entry of names.reexports.get(name) ?? []) {
      const downstream =
        resolveFromFile(entry.fromModule, entry.sourceSpecifier || name) ?? resolveFromFile(entry.fromModule, name);
      if (downstream) {
        index.exportCache.set(key, downstream);
        return downstream;
      }
    }

    const starCandidates: ResolvedExport[] = [];
    for (const entry of moduleEntry.exports) {
      if (entry.type !== "exportStar") continue;
      const downstream = resolveFromFile(entry.fromModule, name);
      if (downstream && !starCandidates.some((candidate) => sameResolvedExport(candidate, downstream))) {
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

    if (allowLocalFallback) {
      for (const local of names.locals.get(name) ?? []) {
        if (matchesPreferredKind(local)) {
          const result: ResolvedExport = { kind: "resolved", def: local };
          index.exportCache.set(key, result);
          return result;
        }
      }
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
