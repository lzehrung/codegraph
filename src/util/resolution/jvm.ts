import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildDeclaredContainerIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";
import { JAVA_IDENTIFIER_IGNORABLE_SOURCE, JAVA_IDENTIFIER_SOURCE, KOTLIN_IDENTIFIER_SOURCE } from "../identifiers.js";
import { confineResolvedPath, readUtf8WithoutBom } from "../paths.js";
import { getImportableLanguageGlobs } from "../resolution-candidates.js";
import { buildTriviaMask } from "../trivia.js";
import { JVM_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRoot } from "./files.js";

const KOTLIN_PACKAGE_PATTERN = new RegExp(
  String.raw`^\s*package\s+(${KOTLIN_IDENTIFIER_SOURCE}(?:\.${KOTLIN_IDENTIFIER_SOURCE})*)`,
  "mu",
);
const KOTLIN_DECLARATION_PATTERN = new RegExp(
  String.raw`\b(class|object|fun|typealias|interface)\s+(${KOTLIN_IDENTIFIER_SOURCE})`,
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
const JAVA_IDENTIFIER_IGNORABLE_PATTERN = new RegExp(`[${JAVA_IDENTIFIER_IGNORABLE_SOURCE}]`, "gu");

type JvmSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
  javaImportableTypes?: Set<string>;
};

type JvmSymbolIndexReaderOptions = {
  languageId: "java" | "kotlin";
  packagePattern: RegExp;
  declarationPattern: RegExp;
  normalizeSymbol?: (symbol: string) => string;
  declarationNameGroup?: 1 | 2;
  javaImportableTypes?: boolean;
};

type JvmImportResolutionOptions = {
  languageId: "java" | "kotlin";
  allowBarePackage: boolean;
  filenameFallback: boolean;
  fromFile: string;
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

  const source = await readUtf8WithoutBom(filePath);
  const packageName = source.match(options.packagePattern)?.[1] ?? null;
  const javaImportableTypes = options.javaImportableTypes ? new Set<string>() : undefined;
  const symbols = new Set<string>();
  const trivia = buildTriviaMask(source, options.languageId);
  let depth = 0;
  let cursor = 0;
  for (const match of source.matchAll(options.declarationPattern)) {
    const matchIndex = match.index ?? 0;
    for (; cursor < matchIndex; cursor += 1) {
      if (trivia[cursor]) continue;
      if (source[cursor] === "{") depth += 1;
      else if (depth && source[cursor] === "}") depth -= 1;
    }
    if (depth || trivia[matchIndex]) continue;
    const symbolName = match[options.declarationNameGroup ?? 1];
    if (symbolName) {
      if (javaImportableTypes && (match[1] === "class" || match[1] === "object" || match[1] === "interface")) {
        javaImportableTypes.add(symbolName);
      }
      symbols.add(symbolName);
      const normalizedSymbol = options.normalizeSymbol?.(symbolName);
      if (normalizedSymbol) symbols.add(normalizedSymbol);
    }
  }

  const entry = { packageName, symbols, ...(javaImportableTypes ? { javaImportableTypes } : {}) };
  cache.set(filePath, entry);
  return entry;
}

async function readKotlinSymbolIndex(filePath: string): Promise<JvmSymbolIndexEntry> {
  return await readJvmSymbolIndex(filePath, kotlinSymbolIndexCache, {
    languageId: "kotlin",
    packagePattern: KOTLIN_PACKAGE_PATTERN,
    declarationPattern: KOTLIN_DECLARATION_PATTERN,
    declarationNameGroup: 2,
    javaImportableTypes: true,
  });
}

async function readJavaSymbolIndex(filePath: string): Promise<JvmSymbolIndexEntry> {
  return await readJvmSymbolIndex(filePath, javaSymbolIndexCache, {
    languageId: "java",
    packagePattern: JAVA_PACKAGE_PATTERN,
    declarationPattern: JAVA_DECLARATION_PATTERN,
    normalizeSymbol: (symbol) => symbol.replace(JAVA_IDENTIFIER_IGNORABLE_PATTERN, ""),
  });
}

async function getJvmLanguageProjectSymbolIndex(
  indexRoot: string,
  cache: Map<string, Promise<LanguageProjectSymbolIndex>>,
  languageId: "java" | "kotlin",
  readSymbolIndex: (filePath: string) => Promise<JvmSymbolIndexEntry>,
): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(cache, indexRoot, async () =>
    buildDeclaredContainerIndex(indexRoot, getImportableLanguageGlobs(languageId), async (filePath) => {
      const entry = await readSymbolIndex(filePath);
      if (entry.packageName === null) return [];
      return [{ name: entry.packageName, symbols: entry.symbols }];
    }),
  );
}

async function getKotlinProjectSymbolIndex(indexRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(
    indexRoot,
    kotlinProjectSymbolIndexCache,
    "kotlin",
    readKotlinSymbolIndex,
  );
}

async function getJavaProjectSymbolIndex(indexRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(indexRoot, javaProjectSymbolIndexCache, "java", readJavaSymbolIndex);
}

async function getJvmProjectSymbolIndex(
  indexRoot: string,
  languageId: "java" | "kotlin",
): Promise<LanguageProjectSymbolIndex> {
  if (languageId === "kotlin") {
    return await getKotlinProjectSymbolIndex(indexRoot);
  }
  return await getJavaProjectSymbolIndex(indexRoot);
}

async function confineJvmResolvedPath(projectRoot: string, resolved: string | null): Promise<string | null> {
  const confined = await confineResolvedPath(projectRoot, resolved);
  if (!confined) return null;
  try {
    const st = await fsp.stat(confined);
    if (st.isDirectory()) return null;
  } catch {
    return null;
  }
  return confined;
}

async function jvmIndexRoot(projectRoot: string, fromFile: string): Promise<string> {
  return await resolveNearestManifestRoot(projectRoot, fromFile, JVM_PACKAGE_MANIFEST_NAMES);
}

export async function resolveJvmPackageImportPaths(
  projectRoot: string,
  spec: string,
  fromFile: string,
): Promise<string[]> {
  const indexRoot = await jvmIndexRoot(projectRoot, fromFile);
  const [javaIndex, kotlinIndex] = await Promise.all([
    getJavaProjectSymbolIndex(indexRoot),
    getKotlinProjectSymbolIndex(indexRoot),
  ]);
  const packageFiles = new Set(javaIndex.filesByPackage.get(spec) ?? []);
  for (const file of kotlinIndex.filesByPackage.get(spec) ?? []) packageFiles.add(file);
  const packageCandidates = [...packageFiles].sort((left, right) => left.localeCompare(right));
  const confined: string[] = [];
  for (const candidate of packageCandidates) {
    const hit = await confineJvmResolvedPath(projectRoot, candidate);
    if (hit) confined.push(hit);
  }
  return confined;
}

async function resolveJvmImportPath(
  projectRoot: string,
  spec: string,
  options: JvmImportResolutionOptions,
): Promise<string | null> {
  const cache = options.languageId === "kotlin" ? kotlinImportResolutionCache : javaImportResolutionCache;
  const indexRoot = await jvmIndexRoot(projectRoot, options.fromFile);
  const cacheKey = `${path.resolve(projectRoot)}::${indexRoot}::${spec}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = spec.split(".").filter(Boolean);
  const projectIndex = await getJvmProjectSymbolIndex(indexRoot, options.languageId);
  if (parts.length < 2) {
    if (!options.allowBarePackage) {
      cache.set(cacheKey, null);
      return null;
    }
    const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
    const resolved = await confineJvmResolvedPath(
      projectRoot,
      packageCandidates[0] ? path.resolve(packageCandidates[0]) : null,
    );
    cache.set(cacheKey, resolved);
    return resolved;
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = parts.slice(0, -1).join(".");
  const packageCandidates = projectIndex.filesByPackage.get(packageName) ?? [];

  if (importedName === "*") {
    const resolved = await confineJvmResolvedPath(
      projectRoot,
      packageCandidates[0] ? path.resolve(packageCandidates[0]) : null,
    );
    cache.set(cacheKey, resolved);
    return resolved;
  }
  const otherIndex = await getJvmProjectSymbolIndex(indexRoot, options.languageId === "java" ? "kotlin" : "java");

  const ownFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const otherFiles = otherIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const sharedFiles =
    options.languageId === "java"
      ? await Promise.all(
          otherFiles.map(async (file) =>
            (await readKotlinSymbolIndex(file)).javaImportableTypes?.has(importedName) ? file : null,
          ),
        )
      : otherFiles;
  const symbolFiles = [...ownFiles, ...sharedFiles.filter((file): file is string => file !== null)];
  const filenameMatched: string[] = [];
  if (options.filenameFallback && !symbolFiles.length) {
    for (const candidate of packageCandidates) {
      if (path.parse(candidate).name !== importedName) continue;
      const entry = await readJavaSymbolIndex(candidate);
      if (!entry.symbols.size || entry.symbols.has(importedName)) filenameMatched.push(candidate);
    }
  }
  const candidates = symbolFiles.length ? symbolFiles : filenameMatched;
  const resolved =
    candidates.length === 1 ? await confineJvmResolvedPath(projectRoot, path.resolve(candidates[0]!)) : null;
  cache.set(cacheKey, resolved);
  return resolved;
}

export async function resolveKotlinImportPath(
  projectRoot: string,
  spec: string,
  fromFile: string,
): Promise<string | null> {
  return await resolveJvmImportPath(projectRoot, spec, {
    languageId: "kotlin",
    allowBarePackage: true,
    filenameFallback: false,
    fromFile,
  });
}

export async function resolveJavaImportPath(
  projectRoot: string,
  spec: string,
  fromFile: string,
): Promise<string | null> {
  return await resolveJvmImportPath(projectRoot, spec, {
    languageId: "java",
    allowBarePackage: false,
    filenameFallback: true,
    fromFile,
  });
}

export function clearJvmResolutionCaches(): void {
  kotlinImportResolutionCache.clear();
  kotlinSymbolIndexCache.clear();
  kotlinProjectSymbolIndexCache.clear();
  javaImportResolutionCache.clear();
  javaSymbolIndexCache.clear();
  javaProjectSymbolIndexCache.clear();
}
