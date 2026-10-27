import fsp from "node:fs/promises";
import path from "node:path";
import { supportById } from "../../languages.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../../worker/native-extract-worker.js";
import {
  buildDeclaredContainerIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";
import { collectJvmFileFacts, parseJvmSyntaxTree, type JvmFileFacts, type JvmLanguageId } from "../jvm-tree.js";
import { confineResolvedPath, fileIdentityKey, readUtf8WithoutBom } from "../paths.js";
import { getImportableLanguageGlobs } from "../resolution-candidates.js";
import { JVM_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRoot } from "./files.js";

type JvmImportResolutionOptions = {
  languageId: JvmLanguageId;
  fromFile: string;
};

const kotlinImportResolutionCache = new Map<string, string | null>();
const kotlinProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
const javaImportResolutionCache = new Map<string, string | null>();
const javaProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
/** The facts known per file during one build: a reused module's, a built module's, or those of a fresh parse. */
const jvmFileFactsCache = new Map<string, JvmFileFacts | null>();

/** Gives the project scan the facts a build already holds for `file`, so the scan parses nothing for it. */
export function primeJvmFileFacts(file: string, facts: JvmFileFacts): void {
  jvmFileFactsCache.set(fileIdentityKey(file), facts);
}

/** The facts of one file, or `null` when its tree is unavailable, which leaves its declarations unknown. */
async function readJvmFileFacts(filePath: string, languageId: JvmLanguageId): Promise<JvmFileFacts | null> {
  const key = fileIdentityKey(filePath);
  const cached = jvmFileFactsCache.get(key);
  if (cached !== undefined) return cached;

  const source = await readUtf8WithoutBom(filePath);
  const support = supportById(languageId);
  const tooLarge = Buffer.byteLength(source, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES;
  const tree = support && !tooLarge ? parseJvmSyntaxTree(source, support).tree : null;
  const facts = tree ? collectJvmFileFacts(tree, languageId) : null;
  jvmFileFactsCache.set(key, facts);
  return facts;
}

/** The names a file's declarations can be imported by; Java also matches a name without its ignorable characters. */
function importableNames(facts: JvmFileFacts, languageId: JvmLanguageId): Set<string> {
  const names = new Set(facts.symbols);
  if (languageId === "java") {
    const { normalizeIdentifier } = supportById("java")!;
    for (const name of facts.symbols) names.add(normalizeIdentifier(name));
  }
  return names;
}

async function getJvmLanguageProjectSymbolIndex(
  indexRoot: string,
  cache: Map<string, Promise<LanguageProjectSymbolIndex>>,
  languageId: JvmLanguageId,
): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(cache, indexRoot, async () =>
    buildDeclaredContainerIndex(indexRoot, getImportableLanguageGlobs(languageId), async (filePath) => {
      const facts = await readJvmFileFacts(filePath, languageId);
      if (!facts?.packageName) return [];
      return [{ name: facts.packageName, symbols: importableNames(facts, languageId) }];
    }),
  );
}

async function getKotlinProjectSymbolIndex(indexRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(indexRoot, kotlinProjectSymbolIndexCache, "kotlin");
}

async function getJavaProjectSymbolIndex(indexRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(indexRoot, javaProjectSymbolIndexCache, "java");
}

async function getJvmProjectSymbolIndex(
  indexRoot: string,
  languageId: JvmLanguageId,
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

export async function resolveJvmImportPath(
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
    // Kotlin can import a top-level declaration of the default package; Java cannot.
    if (options.languageId !== "kotlin") {
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
            (await readJvmFileFacts(file, "kotlin"))?.javaTypes?.includes(importedName) ? file : null,
          ),
        )
      : otherFiles;
  const symbolFiles = [...ownFiles, ...sharedFiles.filter((file): file is string => file !== null)];
  const filenameMatched: string[] = [];
  // Java alone falls back to the file named after the imported type.
  if (options.languageId === "java" && !symbolFiles.length) {
    for (const candidate of packageCandidates) {
      if (path.parse(candidate).name !== importedName) continue;
      const facts = await readJvmFileFacts(candidate, "java");
      if (!facts?.symbols.length || importableNames(facts, "java").has(importedName)) filenameMatched.push(candidate);
    }
  }
  const candidates = symbolFiles.length ? symbolFiles : filenameMatched;
  const resolved =
    candidates.length === 1 ? await confineJvmResolvedPath(projectRoot, path.resolve(candidates[0]!)) : null;
  cache.set(cacheKey, resolved);
  return resolved;
}

export function clearJvmResolutionCaches(): void {
  kotlinImportResolutionCache.clear();
  kotlinProjectSymbolIndexCache.clear();
  javaImportResolutionCache.clear();
  javaProjectSymbolIndexCache.clear();
  jvmFileFactsCache.clear();
}
