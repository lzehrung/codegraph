import crypto from "node:crypto";
import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap, type LanguageSupport } from "../languages.js";
import { fileIdentityKey, isAbsoluteFilePath, normalizePath } from "../util/paths.js";
import { isCppNamedModuleSpecifier } from "../util/resolution/cpp.js";
import { isJvmLanguage } from "../util/syntax-tree.js";
import { DECLARATION_RESOLVED_IMPORT_LANGUAGES } from "./import-resolution-tables.js";
import type { ImportBinding, ModuleIndex } from "./types.js";
import { PHP_INCOMPLETE_DECLARATION_IDENTITY } from "./php-namespace-symbols.js";
import {
  foldPhpIdentifierCase,
  normalizeCsharpQualifiedName,
  normalizeKotlinQualifiedName,
} from "../util/identifiers.js";

/**
 * A file's public surface is what other files' cached index data can derive from its content.
 *
 * A cached module keeps only its own source facts plus targets resolved from specifiers. A
 * target is chosen from file existence and config, so editing the target never changes it.
 * Content-derived data exists in three places:
 * - star-import expansion (`expand-star-imports.ts`) copies the names, kinds, and C tags of the
 *   target's local exports, or of its locals when it has none;
 * - declaration-resolved languages (`DECLARATION_RESOLVED_IMPORT_LANGUAGES`) pick import targets
 *   from the namespace, package, or module declarations of other files;
 * - Rust resolves `mod` and `#[path]` through a module tree built from other files, and a Python
 *   `from pkg import name` reads the `__init__.py` of `pkg` to decide what `name` binds.
 *
 * The first is an `api` surface: a hash of exactly those inputs plus the re-export structure, so
 * a body or signature edit leaves it unchanged. The others read arbitrary parts of the file, so
 * they are a `content` surface: every content change of such a file rebuilds its dependents.
 */
export type PublicSurfaceKind = "api" | "content";

/** Bump when the hashed inputs change, so signatures from another version never compare equal. */
const PUBLIC_SURFACE_VERSION = "s1";
const SURFACE_HEX_LENGTH = 16;
const PYTHON_PACKAGE_INIT = /^__init__\.pyi?$/iu;

/**
 * Classified from the extension map and file name alone, like the incremental plan does, so a
 * header never costs a sample read. A header the plan sees as C and extraction sees as C++ is
 * still an `api` surface: neither language declares names for other files to resolve through.
 */
export function publicSurfaceKind(file: string, languageExtensions?: LanguageExtensionMap): PublicSurfaceKind {
  const languageId = supportForFileWithoutHeaderSample(file, languageExtensions)?.id;
  if (languageId === undefined) return "api";
  if (DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(languageId) || languageId === "rust") return "content";
  if (languageId === "python" && PYTHON_PACKAGE_INIT.test(path.basename(file))) return "content";
  return "api";
}

function projectRelative(projectRoot: string, file: string): string {
  const relative = normalizePath(path.relative(projectRoot, file));
  return relative.startsWith("..") || path.isAbsolute(relative) ? normalizePath(file) : relative;
}

/**
 * Hash of the exported names, their kinds, their re-export sources, and the star-expansion
 * fallback locals. Positions, callable shapes, docstrings, and complexity are left out: no
 * importer caches them, so a body or signature edit keeps the signature.
 */
export function computeApiSurface(mod: ModuleIndex, projectRoot: string): string {
  const parts: unknown[] = [];
  let hasLocalExport = false;
  for (const entry of mod.exports) {
    if (entry.type === "local") {
      hasLocalExport = true;
      parts.push([
        "l",
        entry.exportedAs,
        entry.target.kind,
        entry.target.isMember ? 1 : 0,
        entry.target.cTag ?? 0,
        entry.mechanism ?? 0,
      ]);
      continue;
    }
    parts.push([
      "r",
      entry.type,
      "exportedAs" in entry ? entry.exportedAs : 0,
      isAbsoluteFilePath(entry.fromModule) ? projectRelative(projectRoot, entry.fromModule) : entry.fromModule,
      "sourceSpecifier" in entry ? entry.sourceSpecifier : 0,
      entry.typeOnly ? 1 : 0,
    ]);
  }
  // A star import of a file without local exports binds its locals instead.
  if (!hasLocalExport) {
    for (const local of mod.locals) {
      parts.push(["f", local.localName, local.kind, local.isMember ? 1 : 0, local.cTag ?? 0]);
    }
  }
  const digest = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex");
  return `${PUBLIC_SURFACE_VERSION}:${digest.slice(0, SURFACE_HEX_LENGTH)}`;
}

/** The signature persisted with the file's manifest entry, or `undefined` for a `content` surface. */
export function publicSurfaceSignature(
  file: string,
  mod: ModuleIndex,
  projectRoot: string,
  languageExtensions?: LanguageExtensionMap,
): string | undefined {
  if (publicSurfaceKind(file, languageExtensions) === "content") return undefined;
  return computeApiSurface(mod, projectRoot);
}

/**
 * Declaration-import names that changed in one language group of a build. Java and Kotlin share a group:
 * either can import the other's declarations. A PHP name is a declared class, function, constant, or namespace
 * (and each of its prefixes) with its role dropped; `PHP_INCOMPLETE_DECLARATION_IDENTITY` stands for a file whose
 * declarations became, or stopped being, uncertain.
 */
export type DeclarationNameChanges = {
  /** Declared by a changed file now and not before: a cached binding that names one has another declarer. */
  added: Set<string>;
  /** Declared before by a changed or deleted file and not now: an unresolved binding that names one can resolve. */
  removed: Set<string>;
};

/** The language group whose declarations a declaration import can name. */
export function declarationLanguageGroup(languageId: string): string {
  return isJvmLanguage(languageId) ? "jvm" : languageId;
}

/** The separator between the segments of a name that a declaration import can spell. */
function declarationNameSeparator(support: LanguageSupport): string {
  return support.id === "php" ? "\\" : ".";
}

function sameNames(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

/** Declaration facts omit body positions; C# namespace-region offsets are intentionally ignored. */
function sameDeclarationFacts(previous: ModuleIndex, current: ModuleIndex): boolean {
  const oldJvm = previous.jvmFacts;
  const newJvm = current.jvmFacts;
  if (oldJvm || newJvm) {
    if (!oldJvm || !newJvm || oldJvm.packageName !== newJvm.packageName) return false;
    return sameNames(oldJvm.symbols, newJvm.symbols) && sameNames(oldJvm.javaTypes, newJvm.javaTypes);
  }
  const oldCsharp = previous.csharpNamespaceFacts;
  const newCsharp = current.csharpNamespaceFacts;
  if (oldCsharp || newCsharp) {
    if (!oldCsharp || !newCsharp || oldCsharp.regions.length !== newCsharp.regions.length) return false;
    if (!sameNames(oldCsharp.types, newCsharp.types)) return false;
    return oldCsharp.regions.every((region, index) => region.name === newCsharp.regions[index]!.name);
  }
  return sameNames(previous.declaredContainers, current.declaredContainers);
}

/** Match source-spelled declaration facts and specifiers with their language's identifier identity. */
export function normalizeDeclarationImportName(name: string, support: LanguageSupport): string {
  if (support.id === "csharp") {
    const normalized = normalizeCsharpQualifiedName(name);
    return normalized.startsWith("global::") ? normalized.slice("global::".length) : normalized;
  }
  if (support.id === "kotlin") return normalizeKotlinQualifiedName(name);
  const normalized = support.normalizeIdentifier?.(name) ?? name;
  if (support.id === "php") return foldPhpIdentifierCase(normalized).replace(/^\\+/u, "");
  return normalized;
}

function declarationImportNames(mod: ModuleIndex, support: LanguageSupport): Set<string> {
  if (support.id === "php" && mod.phpDeclarationNames)
    return phpDeclarationImportNamesOf(phpDeclarationIdentities(mod));
  const names = new Set<string>();
  const add = (name: string): void => {
    const normalized = normalizeDeclarationImportName(name, support);
    if (!normalized) return;
    names.add(normalized);
    if (support.id === "cpp") return;
    names.add(normalized.slice(normalized.lastIndexOf(declarationNameSeparator(support)) + 1));
  };
  if (mod.jvmFacts) {
    const packageName = mod.jvmFacts.packageName;
    if (packageName) add(packageName);
    for (const name of mod.jvmFacts.symbols) {
      add(name);
      if (packageName) add(`${packageName}.${name}`);
    }
  } else if (mod.csharpNamespaceFacts) {
    for (const region of mod.csharpNamespaceFacts.regions) add(region.name);
    for (const name of mod.csharpNamespaceFacts.types) add(name);
  } else if (support.id === "cpp") {
    for (const name of mod.declaredContainers ?? []) add(name);
  } else {
    for (const entry of mod.exports) {
      if (entry.type === "local" && !entry.target.isMember) add(entry.exportedAs);
    }
  }
  return names;
}

/** A PHP declaration identity without its role (`class:`, `function:`, `const:`, `namespace:`), folded like a specifier. */
function phpIdentityName(identity: string): string {
  if (identity === PHP_INCOMPLETE_DECLARATION_IDENTITY) return identity;
  return foldPhpIdentifierCase(identity.slice(identity.indexOf(":") + 1));
}

/**
 * A PHP module's own-file declaration identities, including the incomplete marker. A row that recorded its parse
 * state only as diagnostics still counts as incomplete.
 */
function phpDeclarationIdentities(mod: ModuleIndex | undefined): Set<string> {
  const identities = new Set(mod?.phpDeclarationNames);
  if (mod?.parserDegraded || mod?.parseErrorRanges?.length) identities.add(PHP_INCOMPLETE_DECLARATION_IDENTITY);
  return identities;
}

/**
 * The namespaces that directly hold a class, function, or constant of a PHP module. `use Lib;` binds a file whose
 * package is exactly `Lib`, which no namespace identity records on its own: each stands for every prefix of a deeper
 * namespace too, so moving a file from `Lib\Sub` to `Lib` adds no identity for `Lib`.
 */
function phpDeclaredPackages(identities: ReadonlySet<string>): Set<string> {
  const packages = new Set<string>();
  for (const identity of identities) {
    if (identity === PHP_INCOMPLETE_DECLARATION_IDENTITY || identity.startsWith("namespace:")) continue;
    const qualified = identity.slice(identity.indexOf(":") + 1);
    const separator = qualified.lastIndexOf("\\");
    if (separator > 0) packages.add(foldPhpIdentifierCase(qualified.slice(0, separator)));
  }
  return packages;
}

/** Every name a PHP module declares for import matching: identities without their roles, and its declared packages. */
function phpDeclarationImportNamesOf(identities: ReadonlySet<string>): Set<string> {
  const names = new Set(Array.from(identities, phpIdentityName));
  for (const name of phpDeclaredPackages(identities)) names.add(name);
  return names;
}

/**
 * The PHP names a file started or stopped declaring. Identities are compared with their roles, so a class that
 * becomes a function of the same name changes both roles. Namespaces and their prefixes are identities too, and so
 * are the packages that hold declarations, so moving a file into another namespace changes names even when every
 * class keeps its spelling.
 */
function phpDeclarationNameChanges(
  previous: ModuleIndex | undefined,
  current: ModuleIndex,
): DeclarationNameChanges | undefined {
  const before = phpDeclarationIdentities(previous);
  const after = phpDeclarationIdentities(current);
  const added = new Set<string>();
  for (const identity of after) if (!before.has(identity)) added.add(phpIdentityName(identity));
  const removed = new Set<string>();
  for (const identity of before) if (!after.has(identity)) removed.add(phpIdentityName(identity));
  const packagesBefore = phpDeclaredPackages(before);
  const packagesAfter = phpDeclaredPackages(after);
  for (const name of packagesAfter) if (!packagesBefore.has(name)) added.add(name);
  for (const name of packagesBefore) if (!packagesAfter.has(name)) removed.add(name);
  if (!added.size && !removed.size) return undefined;
  return { added, removed };
}

/**
 * The declaration-import names a changed file started or stopped declaring, or `undefined` when none changed.
 * A body edit compares the same API surface used by the extraction waves plus stored package/namespace
 * facts, without inspecting any importers. Without a previous module every current name counts as new and
 * no removal is known.
 */
export function declarationNameChanges(
  previous: ModuleIndex | undefined,
  current: ModuleIndex,
  support: LanguageSupport,
  projectRoot: string,
): DeclarationNameChanges | undefined {
  // PHP records qualified declarations and namespaces by role, so a namespace-only move or a role change is a name
  // change even when every exported spelling is unchanged.
  if (support.id === "php" && current.phpDeclarationNames) return phpDeclarationNameChanges(previous, current);
  if (
    previous &&
    sameDeclarationFacts(previous, current) &&
    computeApiSurface(previous, projectRoot) === computeApiSurface(current, projectRoot)
  ) {
    return undefined;
  }
  const currentNames = declarationImportNames(current, support);
  const previousNames = previous ? declarationImportNames(previous, support) : new Set<string>();
  const added = new Set<string>();
  for (const name of currentNames) if (!previousNames.has(name)) added.add(name);
  const removed = new Set<string>();
  for (const name of previousNames) if (!currentNames.has(name)) removed.add(name);
  if (!added.size && !removed.size) return undefined;
  return { added, removed };
}

/** The names a deleted declaration file stopped declaring. Without its previous module none are known. */
export function deletedDeclarationNameChanges(
  previous: ModuleIndex | undefined,
  support: LanguageSupport,
): DeclarationNameChanges {
  return {
    added: new Set<string>(),
    removed: previous ? declarationImportNames(previous, support) : new Set<string>(),
  };
}

/** Folds one file's changes into the group of its language. */
export function recordDeclarationNameChanges(
  byLanguageGroup: Map<string, DeclarationNameChanges>,
  support: LanguageSupport,
  changes: DeclarationNameChanges,
): void {
  const group = declarationLanguageGroup(support.id);
  let merged = byLanguageGroup.get(group);
  if (!merged) {
    merged = { added: new Set<string>(), removed: new Set<string>() };
    byLanguageGroup.set(group, merged);
  }
  for (const name of changes.added) merged.added.add(name);
  for (const name of changes.removed) merged.removed.add(name);
}

/**
 * Whether `specifier` can name one of `names`: exactly, by the name it imports from its container, or, for a
 * PHP `use` of a namespace, by that namespace. C++ module names are matched exactly.
 */
function specifierNamesDeclaration(specifier: string, support: LanguageSupport, names: ReadonlySet<string>): boolean {
  if (names.has(specifier)) return true;
  if (support.id === "cpp") return false;
  const lastSeparator = specifier.lastIndexOf(declarationNameSeparator(support));
  if (names.has(specifier.slice(lastSeparator + 1))) return true;
  return support.id === "php" && lastSeparator >= 0 && names.has(specifier.slice(0, lastSeparator));
}

/**
 * Whether a resolved binding spells the qualified name of a newly declared type, package, namespace, or module.
 * PHP declarations are qualified too. A PHP module without qualified facts records only unqualified names, so
 * its binding also matches by the name it imports. A named binding also depends on the member it imports from
 * `from`: a C# alias keeps the namespace of the type it found as `from`.
 */
function resolvedBindingNamesAddedDeclaration(
  binding: ImportBinding,
  specifier: string,
  support: LanguageSupport,
  added: ReadonlySet<string>,
): boolean {
  if (added.has(specifier)) return true;
  const separator = declarationNameSeparator(support);
  if (support.id === "php") return added.has(specifier.slice(specifier.lastIndexOf(separator) + 1));
  if (binding.kind !== "named" || support.id === "cpp") return false;
  return added.has(`${specifier}${separator}${normalizeDeclarationImportName(binding.imported, support)}`);
}

/**
 * A PHP file that cannot be read in full proves any import, so a file whose parse state changed (an error appeared
 * or was fixed, or the file was deleted with one) can move any unresolved PHP binding, whatever names it declares.
 */
function phpDeclarationCertaintyChanged(support: LanguageSupport, changes: DeclarationNameChanges): boolean {
  if (support.id !== "php") return false;
  return (
    changes.added.has(PHP_INCOMPLETE_DECLARATION_IDENTITY) || changes.removed.has(PHP_INCOMPLETE_DECLARATION_IDENTITY)
  );
}

/**
 * What a cached import binding of an unchanged file needs after declarations changed:
 * - `resolve`: unresolved, and it names a changed name or a PHP file's declarations changed certainty. Resolve it
 *   again; the file extracts again only when it now resolves.
 * - `reextract`: resolved, and it names an added name. Another declarer can make it ambiguous or move its target.
 * - `none`: otherwise. Removing a declaration never moves a resolved binding: the manifest edge to its target
 *   already extracts the files that import a deleted or changed file.
 */
export type DeclarationImportRecheck = "none" | "resolve" | "reextract";

export function declarationImportRecheck(
  binding: ImportBinding,
  support: LanguageSupport,
  changes: DeclarationNameChanges,
): DeclarationImportRecheck {
  const resolved = typeof binding.resolved === "string";
  if (resolved && !changes.added.size) return "none";
  // Includes name files, not module declarations. An existing header's body cannot make its missing path
  // appear, so never re-resolve includes here.
  if (support.id === "cpp" && "includeForm" in binding && binding.includeForm) return "none";
  const specifier = normalizeDeclarationImportName(binding.from, support);
  if (support.id === "cpp" && !isCppNamedModuleSpecifier(specifier)) return "none";
  if (resolved) {
    return resolvedBindingNamesAddedDeclaration(binding, specifier, support, changes.added) ? "reextract" : "none";
  }
  if (phpDeclarationCertaintyChanged(support, changes)) return "resolve";
  if (specifierNamesDeclaration(specifier, support, changes.added)) return "resolve";
  if (specifierNamesDeclaration(specifier, support, changes.removed)) return "resolve";
  return "none";
}

/** Resolved project files that `mod` re-exports from (`export * from`, `export { x } from`, `export * as ns from`). */
export function reexportedFiles(mod: ModuleIndex): string[] {
  const files: string[] = [];
  for (const entry of mod.exports) {
    if (entry.type !== "local" && isAbsoluteFilePath(entry.fromModule)) files.push(entry.fromModule);
  }
  return files;
}

/**
 * Closes `surfaceChanged` under re-exporting: a file that re-exports from a file whose surface
 * changed exposes different names itself, so its own importers are affected too.
 * Keys are `fileIdentityKey` values; `modules` holds the freshly extracted modules by the same key.
 */
export function propagateReexportSurfaceChanges(
  modules: ReadonlyMap<string, ModuleIndex>,
  surfaceChanged: Set<string>,
): void {
  const reexporters = new Map<string, string[]>();
  for (const [key, mod] of modules) {
    for (const target of reexportedFiles(mod)) {
      const targetKey = fileIdentityKey(target);
      const bucket = reexporters.get(targetKey);
      if (bucket) bucket.push(key);
      else reexporters.set(targetKey, [key]);
    }
  }
  const queue = [...surfaceChanged];
  for (let head = 0; head < queue.length; head += 1) {
    for (const reexporter of reexporters.get(queue[head]!) ?? []) {
      if (surfaceChanged.has(reexporter)) continue;
      surfaceChanged.add(reexporter);
      queue.push(reexporter);
    }
  }
}
