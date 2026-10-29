import fsp from "node:fs/promises";
import path from "node:path";
import { supportById } from "../../languages.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../../worker/native-extract-worker.js";
import {
  buildDeclaredContainerIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";
import { collectJvmFileFacts, jvmPackageName, type JvmFileFacts } from "../jvm-tree.js";
import { parseSyntaxTree, type JvmLanguageId } from "../syntax-tree.js";
import { confineResolvedPath, fileIdentityKey, readUtf8WithoutBom } from "../paths.js";
import { getImportableLanguageGlobs } from "../resolution-candidates.js";
import { JVM_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRoot } from "./files.js";

type JvmImportResolutionOptions = {
  languageId: JvmLanguageId;
  fromFile: string;
};

/**
 * The files of a project by package and declared name, and the files whose declarations are unknown. A file with no
 * usable syntax tree is known by its package alone, so it may declare any name its language allows in that package.
 */
type JvmProjectSymbolIndex = LanguageProjectSymbolIndex & { uncheckedFilesByPackage: Map<string, string[]> };

/** What a lookup knows of one file: its facts, and whether they hold its declarations or only its package. */
type JvmFileKnowledge = { facts: JvmFileFacts; declarationsKnown: boolean };

/** A named import's target file, and whether a file with unknown declarations kept the lookup from proving it. */
type JvmImportLookup = { file: string | null; incomplete: boolean };

const kotlinImportResolutionCache = new Map<string, JvmImportLookup>();
const kotlinProjectSymbolIndexCache = new Map<string, Promise<JvmProjectSymbolIndex>>();
const javaImportResolutionCache = new Map<string, JvmImportLookup>();
const javaProjectSymbolIndexCache = new Map<string, Promise<JvmProjectSymbolIndex>>();
/** What is known per file during one build: a reused module's facts, a built module's, or those of a fresh parse. */
const jvmFileFactsCache = new Map<string, JvmFileKnowledge | null>();

/** Gives the project scan the facts a build already holds for `file`, so the scan parses nothing for it. */
export function primeJvmFileFacts(file: string, facts: JvmFileFacts): void {
  jvmFileFactsCache.set(fileIdentityKey(file), { facts, declarationsKnown: true });
}

/** How much of a file's start is parsed for its package clause when the whole file has no usable tree. */
const PACKAGE_HEAD_CHARS = 64 * 1024;

/**
 * What is known of one file. A file without a usable tree (too large, too many nodes, a parse failure) is known by its
 * package clause alone, read from a bounded parse of its head: it stays in the package index, but its declarations are
 * unknown, not empty. `null` when even that parse fails.
 */
async function readJvmFileFacts(filePath: string, languageId: JvmLanguageId): Promise<JvmFileKnowledge | null> {
  const key = fileIdentityKey(filePath);
  const cached = jvmFileFactsCache.get(key);
  if (cached !== undefined) return cached;

  const source = await readUtf8WithoutBom(filePath);
  const support = supportById(languageId);
  const tooLarge = Buffer.byteLength(source, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES;
  const tree = support && !tooLarge ? parseSyntaxTree(source, support).tree : null;
  const head = support && !tree ? parseSyntaxTree(source.slice(0, PACKAGE_HEAD_CHARS), support).tree : null;
  let known: JvmFileKnowledge | null = null;
  if (tree) known = { facts: collectJvmFileFacts(tree, languageId), declarationsKnown: true };
  else if (head) {
    known = { facts: { packageName: jvmPackageName(head, languageId), symbols: [] }, declarationsKnown: false };
  }
  jvmFileFactsCache.set(key, known);
  return known;
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
  cache: Map<string, Promise<JvmProjectSymbolIndex>>,
  languageId: JvmLanguageId,
): Promise<JvmProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(cache, indexRoot, async () => {
    const uncheckedFilesByPackage = new Map<string, string[]>();
    const index = await buildDeclaredContainerIndex(
      indexRoot,
      getImportableLanguageGlobs(languageId),
      async (filePath) => {
        const known = await readJvmFileFacts(filePath, languageId);
        const packageName = known?.facts.packageName;
        if (!known || !packageName) return [];
        if (!known.declarationsKnown) {
          uncheckedFilesByPackage.set(packageName, [...(uncheckedFilesByPackage.get(packageName) ?? []), filePath]);
        }
        return [{ name: packageName, symbols: importableNames(known.facts, languageId) }];
      },
    );
    return { ...index, uncheckedFilesByPackage };
  });
}

async function getKotlinProjectSymbolIndex(indexRoot: string): Promise<JvmProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(indexRoot, kotlinProjectSymbolIndexCache, "kotlin");
}

async function getJavaProjectSymbolIndex(indexRoot: string): Promise<JvmProjectSymbolIndex> {
  return await getJvmLanguageProjectSymbolIndex(indexRoot, javaProjectSymbolIndexCache, "java");
}

async function getJvmProjectSymbolIndex(indexRoot: string, languageId: JvmLanguageId): Promise<JvmProjectSymbolIndex> {
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

/**
 * The files of `packageName` whose declarations are unknown and that may declare `name`. A Kotlin file may declare any
 * class or function of that name; a Java file can declare an importable type only in the file that its name spells.
 */
function uncheckedDeclarers(
  index: JvmProjectSymbolIndex,
  languageId: JvmLanguageId,
  packageName: string,
  name: string,
): string[] {
  const files = index.uncheckedFilesByPackage.get(packageName) ?? [];
  return languageId === "kotlin" ? files : files.filter((file) => path.parse(file).name === name);
}

async function findJvmImport(
  projectRoot: string,
  indexRoot: string,
  spec: string,
  options: JvmImportResolutionOptions,
): Promise<JvmImportLookup> {
  const parts = spec.split(".").filter(Boolean);
  const projectIndex = await getJvmProjectSymbolIndex(indexRoot, options.languageId);
  if (parts.length < 2) {
    // Kotlin can import a top-level declaration of the default package; Java cannot.
    if (options.languageId !== "kotlin") return { file: null, incomplete: false };
    const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
    const file = await confineJvmResolvedPath(
      projectRoot,
      packageCandidates[0] ? path.resolve(packageCandidates[0]) : null,
    );
    return { file, incomplete: false };
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = parts.slice(0, -1).join(".");
  const packageCandidates = projectIndex.filesByPackage.get(packageName) ?? [];

  if (importedName === "*") {
    const file = await confineJvmResolvedPath(
      projectRoot,
      packageCandidates[0] ? path.resolve(packageCandidates[0]) : null,
    );
    return { file, incomplete: false };
  }
  const otherLanguageId = options.languageId === "java" ? "kotlin" : "java";
  const otherIndex = await getJvmProjectSymbolIndex(indexRoot, otherLanguageId);

  const ownFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const otherFiles = otherIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const sharedFiles =
    options.languageId === "java"
      ? await Promise.all(
          otherFiles.map(async (file) =>
            (await readJvmFileFacts(file, "kotlin"))?.facts.javaTypes?.includes(importedName) ? file : null,
          ),
        )
      : otherFiles;
  const symbolFiles = [...ownFiles, ...sharedFiles.filter((file): file is string => file !== null)];
  const filenameMatched: string[] = [];
  // Java alone falls back to the file named after the imported type.
  if (options.languageId === "java" && !symbolFiles.length) {
    for (const candidate of packageCandidates) {
      if (path.parse(candidate).name !== importedName) continue;
      const known = await readJvmFileFacts(candidate, "java");
      if (!known?.facts.symbols.length || importableNames(known.facts, "java").has(importedName)) {
        filenameMatched.push(candidate);
      }
    }
  }
  const candidates = symbolFiles.length ? symbolFiles : filenameMatched;

  // A file whose declarations are unknown may declare the name too. A class name is unique in its package, so the one
  // file that proves a class rules out the rest; a Kotlin function can be overloaded in any other file of its package.
  const undecided = [
    ...uncheckedDeclarers(projectIndex, options.languageId, packageName, importedName),
    ...uncheckedDeclarers(otherIndex, otherLanguageId, packageName, importedName),
  ].filter((file) => !candidates.includes(file));
  let incomplete = false;
  if (undecided.length) {
    const declarer = symbolFiles.length === 1 ? symbolFiles[0] : undefined;
    const provenClass =
      !!declarer &&
      (options.languageId === "java" ||
        otherFiles.includes(declarer) ||
        !!(await readJvmFileFacts(declarer, "kotlin"))?.facts.javaTypes?.includes(importedName));
    incomplete = !provenClass;
  }
  const file =
    !incomplete && candidates.length === 1
      ? await confineJvmResolvedPath(projectRoot, path.resolve(candidates[0]!))
      : null;
  return { file, incomplete };
}

async function lookupJvmImport(
  projectRoot: string,
  spec: string,
  options: JvmImportResolutionOptions,
): Promise<JvmImportLookup> {
  const cache = options.languageId === "kotlin" ? kotlinImportResolutionCache : javaImportResolutionCache;
  const indexRoot = await jvmIndexRoot(projectRoot, options.fromFile);
  const cacheKey = `${path.resolve(projectRoot)}::${indexRoot}::${spec}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const lookup = await findJvmImport(projectRoot, indexRoot, spec, options);
  cache.set(cacheKey, lookup);
  return lookup;
}

export async function resolveJvmImportPath(
  projectRoot: string,
  spec: string,
  options: JvmImportResolutionOptions,
): Promise<string | null> {
  return (await lookupJvmImport(projectRoot, spec, options)).file;
}

/**
 * Whether a file whose declarations are unknown may declare what the named import `spec` asks for. Such an import stays
 * unresolved instead of binding a file whose uniqueness is unproven, so its importer is incomplete until that file reads.
 */
export async function jvmImportLookupIsIncomplete(
  projectRoot: string,
  spec: string,
  options: JvmImportResolutionOptions,
): Promise<boolean> {
  return (await lookupJvmImport(projectRoot, spec, options)).incomplete;
}

export function clearJvmResolutionCaches(): void {
  kotlinImportResolutionCache.clear();
  kotlinProjectSymbolIndexCache.clear();
  javaImportResolutionCache.clear();
  javaProjectSymbolIndexCache.clear();
  jvmFileFactsCache.clear();
}
