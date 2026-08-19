import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildProjectSymbolIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./projectSymbols.js";
import { JAVA_IDENTIFIER_IGNORABLE_SOURCE, JAVA_IDENTIFIER_SOURCE, KOTLIN_IDENTIFIER_SOURCE } from "../identifiers.js";

const KOTLIN_PACKAGE_PATTERN = new RegExp(
  String.raw`^\s*package\s+(${KOTLIN_IDENTIFIER_SOURCE}(?:\.${KOTLIN_IDENTIFIER_SOURCE})*)`,
  "mu",
);
const KOTLIN_DECLARATION_PATTERN = new RegExp(
  String.raw`\b(?:class|object|fun|typealias|interface)\s+(${KOTLIN_IDENTIFIER_SOURCE})`,
  "gu",
);
const JAVA_PACKAGE_PATTERN = new RegExp(
  String.raw`^\s*package\s+(${JAVA_IDENTIFIER_SOURCE}(?:\.${JAVA_IDENTIFIER_SOURCE})*)\s*;`,
  "mu",
);
const JAVA_DECLARATION_PATTERN = new RegExp(
  String.raw`(?:\b(?:class|interface|enum|record)|@interface)\s+(${JAVA_IDENTIFIER_SOURCE})`,
  "gu",
);

type JvmSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
};

type JvmSymbolIndexReaderOptions = {
  packagePattern: RegExp;
  declarationPattern: RegExp;
  normalizeSymbol?: (symbol: string) => string;
};

const kotlinImportResolutionCache = new Map<string, string | null>();
const kotlinSymbolIndexCache = new Map<string, JvmSymbolIndexEntry>();
const kotlinProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
const javaImportResolutionCache = new Map<string, string | null>();
const javaSymbolIndexCache = new Map<string, JvmSymbolIndexEntry>();
const javaProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();

async function readJvmSymbolIndex(
  filePath: string,
  cache: Map<string, JvmSymbolIndexEntry>,
  options: JvmSymbolIndexReaderOptions,
): Promise<JvmSymbolIndexEntry> {
  const cached = cache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const packageName = source.match(options.packagePattern)?.[1] ?? null;
  const symbols = new Set<string>();
  for (const match of source.matchAll(options.declarationPattern)) {
    const symbolName = match[1];
    if (symbolName) {
      symbols.add(symbolName);
      const normalizedSymbol = options.normalizeSymbol?.(symbolName);
      if (normalizedSymbol) symbols.add(normalizedSymbol);
    }
  }

  const entry = { packageName, symbols };
  cache.set(filePath, entry);
  return entry;
}

async function readKotlinSymbolIndex(filePath: string): Promise<JvmSymbolIndexEntry> {
  return await readJvmSymbolIndex(filePath, kotlinSymbolIndexCache, {
    packagePattern: KOTLIN_PACKAGE_PATTERN,
    declarationPattern: KOTLIN_DECLARATION_PATTERN,
  });
}

async function readJavaSymbolIndex(filePath: string): Promise<JvmSymbolIndexEntry> {
  return await readJvmSymbolIndex(filePath, javaSymbolIndexCache, {
    packagePattern: JAVA_PACKAGE_PATTERN,
    declarationPattern: JAVA_DECLARATION_PATTERN,
    normalizeSymbol: (symbol) => symbol.replace(new RegExp(JAVA_IDENTIFIER_IGNORABLE_SOURCE, "gu"), ""),
  });
}

async function getJvmLanguageProjectSymbolIndex(
  projectRoot: string,
  cache: Map<string, Promise<LanguageProjectSymbolIndex>>,
  includeGlobs: string[],
  readSymbolIndex: (filePath: string) => Promise<JvmSymbolIndexEntry>,
): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(
    cache,
    projectRoot,
    async () => await buildProjectSymbolIndex(projectRoot, includeGlobs, readSymbolIndex),
  );
}

async function getKotlinProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(
    projectRoot,
    kotlinProjectSymbolIndexCache,
    ["**/*.kt", "**/*.kts"],
    readKotlinSymbolIndex,
  );
}

async function getJavaProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(
    projectRoot,
    javaProjectSymbolIndexCache,
    ["**/*.java"],
    readJavaSymbolIndex,
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
  const resolved = symbolFiles.length === 1 ? path.resolve(symbolFiles[0]!) : null;
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
  const filenameMatched = packageCandidates.filter((candidate) => path.basename(candidate, ".java") === importedName);
  const candidates = symbolFiles.length ? symbolFiles : filenameMatched;
  const resolved = candidates.length === 1 ? path.resolve(candidates[0]!) : null;
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
