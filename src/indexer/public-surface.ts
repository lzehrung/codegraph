import crypto from "node:crypto";
import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap, type LanguageSupport } from "../languages.js";
import { fileIdentityKey, isAbsoluteFilePath, normalizePath } from "../util/paths.js";
import { isJvmLanguage } from "../util/syntax-tree.js";
import { DECLARATION_RESOLVED_IMPORT_LANGUAGES } from "./import-resolution-tables.js";
import type { ImportBinding, ModuleIndex } from "./types.js";
import { indexLanguagePolicyFor } from "./index-language-policies/index.js";
import {
  emptyDeclarationNameChanges,
  type DeclarationImportRecheck,
  type DeclarationNameChanges,
  type PublicSurfaceHooks,
  type PublicSurfaceKind,
} from "./public-surface-types.js";

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

/** Bump when the hashed inputs change, so signatures from another version never compare equal. */
const PUBLIC_SURFACE_VERSION = "s1";
const SURFACE_HEX_LENGTH = 16;

/**
 * Classified from the extension map and file name alone, like the incremental plan does, so a
 * header never costs a sample read. A header the plan sees as C and extraction sees as C++ is
 * still an `api` surface: neither language declares names for other files to resolve through.
 */
export function publicSurfaceKind(file: string, languageExtensions?: LanguageExtensionMap): PublicSurfaceKind {
  const languageId = supportForFileWithoutHeaderSample(file, languageExtensions)?.id;
  if (languageId === undefined) return "api";
  if (DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(languageId)) return "content";
  return indexLanguagePolicyFor(languageId).publicSurface?.kind?.(file) ?? "api";
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

/** The language group whose declarations a declaration import can name. */
export function declarationLanguageGroup(languageId: string): string {
  return isJvmLanguage(languageId) ? "jvm" : languageId;
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
  const normalize = indexLanguagePolicyFor(support.id).publicSurface?.normalizeImportName;
  return normalize ? normalize(name, support) : (support.normalizeIdentifier?.(name) ?? name);
}

/**
 * Where a JVM module may declare names it did not list: its package when that is known, `null` when the package is
 * unknown (the file was not read in full and its clause was lost), and `undefined` when every declaration is known. A
 * module without facts was not read in full either, so its package is unknown.
 */
function jvmUncertainPackage(mod: ModuleIndex | undefined, support: LanguageSupport): string | null | undefined {
  if (!mod) return undefined;
  const facts = mod.jvmFacts;
  if (facts && !facts.incomplete) return undefined;
  if (!facts?.packageName) return null;
  return normalizeDeclarationImportName(facts.packageName, support);
}

/**
 * Records the packages whose declarations became, or stopped being, uncertain: each uncertain side of a file that
 * changed certainty, or that moved packages while incomplete. A file that stays incomplete in one package changes
 * nothing by its certainty; its names are compared like any other file's.
 */
function jvmCertaintyChanges(
  previous: ModuleIndex | undefined,
  current: ModuleIndex | undefined,
  support: LanguageSupport,
  changes: DeclarationNameChanges,
): boolean {
  if (!isJvmLanguage(support.id)) return false;
  const before = jvmUncertainPackage(previous, support);
  const after = jvmUncertainPackage(current, support);
  if (before === after) return false;
  for (const uncertain of [before, after]) {
    if (uncertain === undefined) continue;
    if (uncertain === null) changes.uncertainAnyPackage = true;
    else changes.uncertainPackages.add(uncertain);
  }
  return true;
}

function declarationImportNames(mod: ModuleIndex, support: LanguageSupport): Set<string> {
  const policy = indexLanguagePolicyFor(support.id).publicSurface;
  const specialized = policy?.declarationNames?.(mod, support);
  if (specialized !== undefined) return specialized;
  const normalize = policy?.normalizeImportName;
  const separator = policy?.nameSeparator ?? ".";
  const names = new Set<string>();
  const add = (name: string): void => {
    const normalized = normalize ? normalize(name, support) : (support.normalizeIdentifier?.(name) ?? name);
    if (!normalized) return;
    names.add(normalized);
    names.add(normalized.slice(normalized.lastIndexOf(separator) + 1));
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
  } else {
    for (const entry of mod.exports) {
      if (entry.type === "local" && !entry.target.isMember) add(entry.exportedAs);
    }
  }
  return names;
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
  const specialized = indexLanguagePolicyFor(support.id).publicSurface?.declarationNameChanges?.(previous, current);
  if (specialized !== undefined) return specialized ?? undefined;
  const changes = emptyDeclarationNameChanges();
  const certaintyChanged = jvmCertaintyChanges(previous, current, support, changes);
  if (
    previous &&
    !certaintyChanged &&
    sameDeclarationFacts(previous, current) &&
    computeApiSurface(previous, projectRoot) === computeApiSurface(current, projectRoot)
  ) {
    return undefined;
  }
  const currentNames = declarationImportNames(current, support);
  const previousNames = previous ? declarationImportNames(previous, support) : new Set<string>();
  for (const name of currentNames) if (!previousNames.has(name)) changes.added.add(name);
  for (const name of previousNames) if (!currentNames.has(name)) changes.removed.add(name);
  if (!changes.added.size && !changes.removed.size && !certaintyChanged) return undefined;
  return changes;
}

/**
 * The names a deleted declaration file stopped declaring, and the JVM certainty it stopped holding back. Without its
 * previous module what it declared is unknown, so any unresolved binding of its language group can resolve.
 */
export function deletedDeclarationNameChanges(
  previous: ModuleIndex | undefined,
  support: LanguageSupport,
): DeclarationNameChanges {
  const changes = emptyDeclarationNameChanges();
  if (!previous) {
    changes.unknownRemoval = true;
    return changes;
  }
  for (const name of declarationImportNames(previous, support)) changes.removed.add(name);
  jvmCertaintyChanges(previous, undefined, support, changes);
  return changes;
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
    merged = emptyDeclarationNameChanges();
    byLanguageGroup.set(group, merged);
  }
  for (const name of changes.added) merged.added.add(name);
  for (const name of changes.removed) merged.removed.add(name);
  for (const name of changes.uncertainPackages) merged.uncertainPackages.add(name);
  if (changes.uncertainAnyPackage) merged.uncertainAnyPackage = true;
  if (changes.unknownRemoval) merged.unknownRemoval = true;
}

/**
 * Whether `specifier` can name one of `names`: exactly, by the name it imports from its container, or, for a
 * PHP `use` of a namespace, by that namespace. C++ module names are matched exactly.
 */
function specifierNamesDeclaration(
  specifier: string,
  names: ReadonlySet<string>,
  policy: PublicSurfaceHooks | undefined,
): boolean {
  if (names.has(specifier)) return true;
  if (policy?.remainingSpecifierMatches) return policy.remainingSpecifierMatches(specifier, names);
  const lastSeparator = specifier.lastIndexOf(policy?.nameSeparator ?? ".");
  return names.has(specifier.slice(lastSeparator + 1));
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
  policy: PublicSurfaceHooks | undefined,
): boolean {
  if (added.has(specifier)) return true;
  if (policy?.resolvedBindingNamesAdded) return policy.resolvedBindingNamesAdded(specifier, added);
  if (binding.kind !== "named") return false;
  const separator = policy?.nameSeparator ?? ".";
  const normalize = policy?.normalizeImportName;
  const imported = normalize
    ? normalize(binding.imported, support)
    : (support.normalizeIdentifier?.(binding.imported) ?? binding.imported);
  return added.has(`${specifier}${separator}${imported}`);
}

/**
 * A JVM file that was not read in full may declare any name of its package, so a binding that names the package, or a
 * name inside it, resolves differently (or is marked incomplete) once such a file appears, disappears, or is read in
 * full. Resolved bindings count too: another incomplete declarer makes a proven import incomplete.
 */
function jvmCertaintyAffectsBinding(
  binding: ImportBinding,
  support: LanguageSupport,
  changes: DeclarationNameChanges,
): boolean {
  if (!isJvmLanguage(support.id)) return false;
  if (changes.uncertainAnyPackage) return true;
  if (!changes.uncertainPackages.size) return false;
  const specifier = normalizeDeclarationImportName(binding.from, support);
  for (const packageName of changes.uncertainPackages) {
    if (specifier === packageName || specifier.startsWith(`${packageName}.`)) return true;
  }
  return false;
}

/**
 * What a cached import binding of an unchanged file needs after declarations changed:
 * - `resolve`: unresolved, and it names a changed name, a PHP file's declarations changed certainty, or a deleted
 *   file left no record of its declarations. Resolve it again; the file extracts again only when it now resolves.
 * - `reextract`: resolved, and it names an added name (another declarer can make it ambiguous or move its target), or
 *   a JVM file in its package changed certainty, whatever its binding state.
 * - `none`: otherwise. Removing a declaration never moves a resolved binding: the manifest edge to its target
 *   already extracts the files that import a deleted or changed file.
 */
export function declarationImportRecheck(
  binding: ImportBinding,
  support: LanguageSupport,
  changes: DeclarationNameChanges,
): DeclarationImportRecheck {
  if (jvmCertaintyAffectsBinding(binding, support, changes)) return "reextract";
  const resolved = typeof binding.resolved === "string";
  if (resolved && !changes.added.size) return "none";
  const policy = indexLanguagePolicyFor(support.id).publicSurface;
  const specialized = policy?.recheck?.(binding, support, changes);
  if (specialized !== undefined) return specialized;
  const normalize = policy?.normalizeImportName;
  const specifier = normalize
    ? normalize(binding.from, support)
    : (support.normalizeIdentifier?.(binding.from) ?? binding.from);
  if (policy?.acceptSpecifier && !policy.acceptSpecifier(specifier)) return "none";
  if (resolved) {
    return resolvedBindingNamesAddedDeclaration(binding, specifier, support, changes.added, policy)
      ? "reextract"
      : "none";
  }
  if (policy?.declarationCertaintyChanged?.(changes) || changes.unknownRemoval) return "resolve";
  if (specifierNamesDeclaration(specifier, changes.added, policy)) return "resolve";
  if (specifierNamesDeclaration(specifier, changes.removed, policy)) return "resolve";
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
