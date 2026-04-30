import fs from "node:fs";
import path from "node:path";
import { supportForFile } from "../languages.js";
import type { FileId } from "../types.js";
import { type ImportBinding, type ProjectIndex, type ResolvedExport, type SymbolDef, SymbolKind } from "./types.js";

function cacheKey(file: FileId, name: string): string {
  return `${file}::${name}`;
}

const goPackageNameCache = new Map<FileId, string | null>();
const packageNameCache = new Map<string, string | null>();

function readGoPackageName(filePath: string): string | null {
  const cached = goPackageNameCache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const match = source.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m);
    const packageName = match?.[1] ?? null;
    goPackageNameCache.set(filePath, packageName);
    return packageName;
  } catch {
    goPackageNameCache.set(filePath, null);
    return null;
  }
}

function resolveGoPackageExport(index: ProjectIndex, file: FileId, exportedName: string): SymbolDef | null {
  try {
    const support = supportForFile(file);
    if (!support || support.id !== "go") return null;
    const baseDir = path.dirname(file);
    const sourcePackage = readGoPackageName(file);
    for (const [filePath, moduleEntry] of index.byFile) {
      if (path.dirname(filePath) !== baseDir) continue;
      if (sourcePackage && readGoPackageName(filePath) !== sourcePackage) {
        continue;
      }
      for (const entry of moduleEntry.exports) {
        if (entry.type === "local" && entry.exportedAs === exportedName) {
          return entry.target;
        }
      }
    }
  } catch {
    // supportForFile throws on unsupported files (for example .json)
  }
  return null;
}

function readPackageNameForLanguage(filePath: string, languageId: "java" | "kotlin"): string | null {
  const key = `${languageId}::${filePath}`;
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

function resolveSiblingPackageExport(
  index: ProjectIndex,
  targetFile: string,
  exportedName: string,
  languageId: "java" | "kotlin",
): ResolvedExport | null {
  const packageName = readPackageNameForLanguage(targetFile, languageId);
  if (!packageName) return null;
  const targetDir = path.dirname(targetFile);
  for (const filePath of index.byFile.keys()) {
    if (filePath === targetFile || path.dirname(filePath) !== targetDir) {
      continue;
    }
    if (readPackageNameForLanguage(filePath, languageId) !== packageName) {
      continue;
    }
    const hit = resolveExport(index, filePath, exportedName);
    if (hit) return hit;
  }
  return null;
}

export function resolveExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string,
  opts?: { preferredKind?: SymbolKind },
): ResolvedExport | null {
  const visited = new Set<string>();
  const matchesPreferredKind = (def: SymbolDef): boolean => !opts?.preferredKind || def.kind === opts.preferredKind;

  function resolveFromFile(fileInner: FileId, name: string): ResolvedExport | null {
    const normalizedFile = fileInner.replace(/\\/g, "/");
    const moduleEntry = index.byFile.get(normalizedFile);
    if (!moduleEntry) return null;
    const key = opts?.preferredKind
      ? `${cacheKey(normalizedFile, name)}::${opts.preferredKind}`
      : cacheKey(normalizedFile, name);
    if (index.exportCache.has(key)) return index.exportCache.get(key)!;

    const cycleKey = `${normalizedFile}::${name}`;
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    const goPackageExport = resolveGoPackageExport(index, normalizedFile, name);
    if (goPackageExport && matchesPreferredKind(goPackageExport)) {
      const result: ResolvedExport = { kind: "resolved", def: goPackageExport };
      index.exportCache.set(key, result);
      return result;
    }

    for (const entry of moduleEntry.exports) {
      if (entry.type === "local" && entry.exportedAs === name && matchesPreferredKind(entry.target)) {
        const result: ResolvedExport = { kind: "resolved", def: entry.target };
        index.exportCache.set(key, result);
        return result;
      }
    }

    for (const entry of moduleEntry.exports) {
      if (entry.type === "namespaceReexport" && entry.exportedAs === name) {
        const result: ResolvedExport = {
          kind: "namespace",
          file: entry.fromModule,
        };
        index.exportCache.set(key, result);
        return result;
      }
    }

    for (const entry of moduleEntry.exports) {
      if (entry.type === "reexport" && entry.exportedAs === name && typeof entry.fromModule === "string") {
        const downstream =
          resolveFromFile(entry.fromModule, entry.sourceSpecifier || name) ?? resolveFromFile(entry.fromModule, name);
        if (downstream) {
          index.exportCache.set(key, downstream);
          return downstream;
        }
      }
    }

    for (const entry of moduleEntry.exports) {
      if (entry.type === "exportStar" && typeof entry.fromModule === "string") {
        const downstream = resolveFromFile(entry.fromModule, name);
        if (downstream) {
          index.exportCache.set(key, downstream);
          return downstream;
        }
      }
    }

    const local = moduleEntry.locals.find(
      (candidate) => candidate.localName === name && matchesPreferredKind(candidate),
    );
    if (local) {
      const result: ResolvedExport = { kind: "resolved", def: local };
      index.exportCache.set(key, result);
      return result;
    }

    index.exportCache.set(key, null);
    return null;
  }

  return resolveFromFile(file, exportedName);
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
      const base =
        fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory() ? targetFile : path.dirname(targetFile);
      const subCandidates = [
        path.join(base, `${exportedName}.py`),
        path.join(base, exportedName, "__init__.py"),
        path.join(base, exportedName),
      ];
      for (const candidate of subCandidates) {
        try {
          if (fs.existsSync(candidate)) {
            return {
              file: candidate.replace(/\\/g, "/"),
              localName: exportedName,
              kind: SymbolKind.Variable,
              range: {
                start: { line: 1, column: 1, index: 0 },
                end: { line: 1, column: 1, index: 0 },
              },
            };
          }
        } catch {
          // fallback resolution continues
        }
      }
      return {
        file: targetFile.replace(/\\/g, "/"),
        localName: exportedName,
        kind: SymbolKind.Variable,
        range: {
          start: { line: 1, column: 1, index: 0 },
          end: { line: 1, column: 1, index: 0 },
        },
      };
    }
  } catch {
    // Unsupported file extension, cannot resolve detailed import.
  }

  return null;
}
