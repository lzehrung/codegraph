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
 * The files of a project by package and declared name, and the files whose declarations are not all in it. A file is
 * `incomplete` when it has no usable syntax tree or a syntax error left declarations unread: it is in its package with
 * the names that were read, and may declare any other name its language allows there. A file whose package could not
 * be read at all is `unplaced`: it may be in any package, and may declare any name.
 */
type JvmProjectSymbolIndex = LanguageProjectSymbolIndex & {
  incompleteFilesByPackage: Map<string, string[]>;
  unplacedFiles: string[];
};

/** A named import's target file, and whether an incomplete file kept the lookup from proving it. */
type JvmImportLookup = { file: string | null; incomplete: boolean };

const kotlinImportResolutionCache = new Map<string, JvmImportLookup>();
const kotlinProjectSymbolIndexCache = new Map<string, Promise<JvmProjectSymbolIndex>>();
const javaImportResolutionCache = new Map<string, JvmImportLookup>();
const javaProjectSymbolIndexCache = new Map<string, Promise<JvmProjectSymbolIndex>>();
/** The facts known per file during one build: a reused module's, a built module's, or those of a fresh parse. */
const jvmFileFactsCache = new Map<string, JvmFileFacts | null>();

/** Gives the project scan the facts a build already holds for `file`, so the scan parses nothing for it. */
export function primeJvmFileFacts(file: string, facts: JvmFileFacts): void {
  jvmFileFactsCache.set(fileIdentityKey(file), facts);
}

/** How much of a file's start is parsed for its package clause when the whole file has no usable tree. */
const PACKAGE_HEAD_CHARS = 64 * 1024;

/**
 * The facts of one file. A file without a usable tree (too large, too many nodes, a parse failure) is known by its
 * package clause alone, read from a bounded parse of its head: it stays in the package index with no names, marked
 * `incomplete`. `null` when even that parse fails.
 */
async function readJvmFileFacts(filePath: string, languageId: JvmLanguageId): Promise<JvmFileFacts | null> {
  const key = fileIdentityKey(filePath);
  const cached = jvmFileFactsCache.get(key);
  if (cached !== undefined) return cached;

  const source = await readUtf8WithoutBom(filePath);
  const support = supportById(languageId);
  const tooLarge = Buffer.byteLength(source, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES;
  const tree = support && !tooLarge ? parseSyntaxTree(source, support).tree : null;
  const head = support && !tree ? parseSyntaxTree(source.slice(0, PACKAGE_HEAD_CHARS), support).tree : null;
  let facts: JvmFileFacts | null = null;
  if (tree) facts = collectJvmFileFacts(tree, languageId);
  else if (head) facts = { packageName: jvmPackageName(head, languageId), symbols: [], incomplete: true };
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
  cache: Map<string, Promise<JvmProjectSymbolIndex>>,
  languageId: JvmLanguageId,
): Promise<JvmProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(cache, indexRoot, async () => {
    const incompleteFilesByPackage = new Map<string, string[]>();
    const unplacedFiles: string[] = [];
    const index = await buildDeclaredContainerIndex(
      indexRoot,
      getImportableLanguageGlobs(languageId),
      async (filePath) => {
        // A file that cannot be read or parsed at all is kept as unplaced, not dropped, so no lookup proves a name
        // past it.
        const facts = await readJvmFileFacts(filePath, languageId).catch(() => null);
        if (!facts) {
          unplacedFiles.push(filePath);
          return [];
        }
        const packageName = facts.packageName;
        if (!packageName) return [];
        if (facts.incomplete) {
          incompleteFilesByPackage.set(packageName, [...(incompleteFilesByPackage.get(packageName) ?? []), filePath]);
        }
        return [{ name: packageName, symbols: importableNames(facts, languageId) }];
      },
    );
    return { ...index, incompleteFilesByPackage, unplacedFiles };
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
 * The files that may declare `name` in `packageName` although their declarations are not all known: its incomplete
 * files, and every file whose package is unknown. A Kotlin file may declare any class, function, or typealias of that
 * name. A Java file declares a type that another package can import only in the file its name spells; an importer in
 * the package itself can also name a package-private type of any file.
 */
function incompleteDeclarers(
  index: JvmProjectSymbolIndex,
  languageId: JvmLanguageId,
  packageName: string,
  name: string,
  importerSharesPackage: boolean,
): string[] {
  const files = [...(index.incompleteFilesByPackage.get(packageName) ?? []), ...index.unplacedFiles];
  if (languageId === "kotlin" || importerSharesPackage) return files;
  return files.filter((file) => path.parse(file).name === name);
}

/** The package of a dotted name: everything before its last segment. */
function packageOf(spec: string): string {
  return spec.split(".").filter(Boolean).slice(0, -1).join(".");
}

async function findJvmImport(
  projectRoot: string,
  indexRoot: string,
  spec: string,
  options: JvmImportResolutionOptions,
  importerSharesPackage: boolean,
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
  const packageName = packageOf(spec);
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

  // An incomplete file may declare the name too. A Java import names a type, and a type that a file proves rules out
  // another type of that name. A Kotlin import names every declaration of its name, and a function or typealias can
  // share the name of a class, so nothing a file proves rules out an incomplete Kotlin file. Two known declarers
  // already leave the import unresolved, so a further one cannot change the answer.
  const incompleteFiles = [
    ...incompleteDeclarers(projectIndex, options.languageId, packageName, importedName, importerSharesPackage),
    ...incompleteDeclarers(otherIndex, otherLanguageId, packageName, importedName, importerSharesPackage),
  ];
  const provenType = options.languageId === "java" && symbolFiles.length > 0;
  const incomplete =
    candidates.length <= 1 && !provenType && incompleteFiles.some((file) => !candidates.includes(file));
  const file =
    !incomplete && candidates.length === 1
      ? await confineJvmResolvedPath(projectRoot, path.resolve(candidates[0]!))
      : null;
  return { file, incomplete };
}

/**
 * Whether the importing file may be in `packageName`: it is, or its package could not be read. Only an importer of the
 * package itself can name a package-private Java type of that package.
 */
async function importerMayShare(options: JvmImportResolutionOptions, packageName: string): Promise<boolean> {
  const facts = await readJvmFileFacts(options.fromFile, options.languageId).catch(() => null);
  return !facts || facts.packageName === packageName;
}

/**
 * The file a named import (`com.acme.Type`) names, and whether an incomplete file kept the lookup from proving it. An
 * incomplete lookup has no file: callers must not guess one from the name, and its importer is incomplete until that
 * file reads. Every form of import asks this for its `from` name: the type, the owner of a static member, or the type
 * of a wildcard.
 */
export async function lookupJvmImport(
  projectRoot: string,
  spec: string,
  options: JvmImportResolutionOptions,
): Promise<JvmImportLookup> {
  const cache = options.languageId === "kotlin" ? kotlinImportResolutionCache : javaImportResolutionCache;
  const indexRoot = await jvmIndexRoot(projectRoot, options.fromFile);
  const importerSharesPackage = await importerMayShare(options, packageOf(spec));
  const cacheKey = `${path.resolve(projectRoot)}::${indexRoot}::${importerSharesPackage ? "shares" : "apart"}::${spec}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const lookup = await findJvmImport(projectRoot, indexRoot, spec, options, importerSharesPackage);
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

export function clearJvmResolutionCaches(): void {
  kotlinImportResolutionCache.clear();
  kotlinProjectSymbolIndexCache.clear();
  javaImportResolutionCache.clear();
  javaProjectSymbolIndexCache.clear();
  jvmFileFactsCache.clear();
}
