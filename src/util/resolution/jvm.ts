import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildProjectSymbolIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./projectSymbols.js";

type KotlinSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
};

type JavaSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
};

const kotlinImportResolutionCache = new Map<string, string | null>();
const kotlinSymbolIndexCache = new Map<string, KotlinSymbolIndexEntry>();
const kotlinProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
const javaImportResolutionCache = new Map<string, string | null>();
const javaSymbolIndexCache = new Map<string, JavaSymbolIndexEntry>();
const javaProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();

async function readKotlinSymbolIndex(filePath: string): Promise<KotlinSymbolIndexEntry> {
  const cached = kotlinSymbolIndexCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const packageName = source.match(/^\s*package\s+([A-Za-z_][\w.]*)/m)?.[1] ?? null;
  const symbols = new Set<string>();
  const declarationPattern = /\b(?:class|object|fun|typealias|interface)\s+([A-Za-z_][\w]*)\b/g;
  for (const match of source.matchAll(declarationPattern)) {
    const symbolName = match[1];
    if (symbolName) symbols.add(symbolName);
  }

  const entry = { packageName, symbols };
  kotlinSymbolIndexCache.set(filePath, entry);
  return entry;
}

async function readJavaSymbolIndex(filePath: string): Promise<JavaSymbolIndexEntry> {
  const cached = javaSymbolIndexCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const packageName = source.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m)?.[1] ?? null;
  const symbols = new Set<string>();
  const declarationPattern = /\b(?:class|interface|enum)\s+([A-Za-z_][\w]*)\b/g;
  for (const match of source.matchAll(declarationPattern)) {
    const symbolName = match[1];
    if (symbolName) symbols.add(symbolName);
  }

  const entry = { packageName, symbols };
  javaSymbolIndexCache.set(filePath, entry);
  return entry;
}

async function getKotlinProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(
    kotlinProjectSymbolIndexCache,
    projectRoot,
    async () => await buildProjectSymbolIndex(projectRoot, ["**/*.kt", "**/*.kts"], readKotlinSymbolIndex),
  );
}

async function getJavaProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(
    javaProjectSymbolIndexCache,
    projectRoot,
    async () => await buildProjectSymbolIndex(projectRoot, ["**/*.java"], readJavaSymbolIndex),
  );
}

async function getJvmProjectSymbolIndex(
  projectRoot: string,
  languageId: "java" | "kotlin",
): Promise<LanguageProjectSymbolIndex> {
  if (languageId === "kotlin") {
    return await getKotlinProjectSymbolIndex(projectRoot);
  }
  return await getJavaProjectSymbolIndex(projectRoot);
}

export async function resolveJvmPackageImportPaths(
  projectRoot: string,
  spec: string,
  languageId: "java" | "kotlin",
): Promise<string[]> {
  const projectIndex = await getJvmProjectSymbolIndex(projectRoot, languageId);
  const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
  return packageCandidates.map((candidate) => path.resolve(candidate));
}

export async function resolveKotlinImportPath(projectRoot: string, spec: string): Promise<string | null> {
  const cacheKey = `${projectRoot}::${spec}`;
  const cached = kotlinImportResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = spec.split(".").filter(Boolean);
  const projectIndex = await getKotlinProjectSymbolIndex(projectRoot);
  if (parts.length < 2) {
    const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
    const resolved = packageCandidates[0] ? path.resolve(packageCandidates[0]) : null;
    kotlinImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = parts.slice(0, -1).join(".");
  const packageCandidates = projectIndex.filesByPackage.get(packageName) ?? [];

  if (importedName === "*") {
    const resolved = packageCandidates[0] ? path.resolve(packageCandidates[0]) : null;
    kotlinImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const symbolFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const resolvedCandidate = symbolFiles[0] ?? packageCandidates[0] ?? null;
  const resolved = resolvedCandidate ? path.resolve(resolvedCandidate) : null;
  kotlinImportResolutionCache.set(cacheKey, resolved);
  return resolved;
}

export async function resolveJavaImportPath(projectRoot: string, spec: string): Promise<string | null> {
  const cacheKey = `${projectRoot}::${spec}`;
  const cached = javaImportResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = spec.split(".").filter(Boolean);
  if (parts.length < 2) {
    javaImportResolutionCache.set(cacheKey, null);
    return null;
  }

  const projectIndex = await getJavaProjectSymbolIndex(projectRoot);
  const exactPackageFiles = projectIndex.filesByPackage.get(spec) ?? [];
  if (exactPackageFiles[0]) {
    const resolved = path.resolve(exactPackageFiles[0]);
    javaImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = parts.slice(0, -1).join(".");

  const packageCandidates = projectIndex.filesByPackage.get(packageName) ?? [];
  if (importedName === "*") {
    const resolved = packageCandidates[0] ? path.resolve(packageCandidates[0]) : null;
    javaImportResolutionCache.set(cacheKey, resolved);
    return resolved;
  }

  const symbolFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const resolvedCandidate = symbolFiles[0] ?? packageCandidates[0] ?? null;
  const resolved = resolvedCandidate ? path.resolve(resolvedCandidate) : null;
  javaImportResolutionCache.set(cacheKey, resolved);
  return resolved;
}

export function clearJvmResolutionCaches(): void {
  kotlinImportResolutionCache.clear();
  kotlinSymbolIndexCache.clear();
  kotlinProjectSymbolIndexCache.clear();
  javaImportResolutionCache.clear();
  javaSymbolIndexCache.clear();
  javaProjectSymbolIndexCache.clear();
}
