import { fileIdentityKey, normalizePath } from "../util/paths.js";
import type { ImportBinding } from "./import-types.js";
import type { ProjectIndex } from "./types.js";

/** A module an unaliased dotted import makes nameable, by the spelling that names it. */
export type PythonImportedModule = {
  /** The leading dotted segments of the import: `a`, `a.b`, or the whole `a.b.c`. */
  phrase: string;
  /** The files that can be the module: both initializer spellings of a package, or the leaf itself. */
  files: readonly string[];
};

const INITIALIZER_NAMES = ["__init__.py", "__init__.pyi"] as const;
const INITIALIZER_SUFFIXES = INITIALIZER_NAMES.map((name) => `/${name}`);
const MODULE_SUFFIXES = [".py", ".pyi"] as const;

/**
 * An unaliased Python `import a.b.c`. It loads the leaf module `a.b.c`, which is the file its binding resolves to, yet
 * the name it binds, `a`, is the package: `a.x` is an attribute of `a`'s `__init__`, `a.b` is the package `a.b`, and only
 * the whole phrase `a.b.c` is the leaf. The helpers below read the packages back from the leaf, so every consumer of
 * the binding names the same modules.
 */
export function isPythonDottedImportBinding(imp: ImportBinding): boolean {
  if (imp.kind !== "namespace" || imp.mechanism !== "python" || imp.explicitAlias) return false;
  const [first, ...rest] = imp.from.split(".");
  return !!rest.length && imp.localNS === first;
}

/** The module path of a Python file without its extension or `__init__` initializer. */
function moduleStem(file: string): string {
  for (const suffix of INITIALIZER_SUFFIXES) {
    if (file.endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  for (const suffix of MODULE_SUFFIXES) {
    if (file.endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  return file;
}

/**
 * The modules an unaliased `import a.b.c` names, shortest first: the package `a`, the package `a.b`, and the leaf
 * `a.b.c`. The packages sit beside the leaf on disk, so the leaf's path locates them; a leaf whose path does not end with
 * the dotted name (a symlinked directory, say) names none. Existence is not checked here.
 */
export function pythonImportedModules(imp: ImportBinding): readonly PythonImportedModule[] {
  if (!isPythonDottedImportBinding(imp) || typeof imp.resolved !== "string") return [];
  const leaf = normalizePath(imp.resolved);
  const segments = imp.from.split(".");
  const dottedPath = `/${segments.join("/")}`;
  const stem = moduleStem(leaf);
  if (!stem.endsWith(dottedPath)) return [];
  const root = stem.slice(0, stem.length - dottedPath.length);
  const modules: PythonImportedModule[] = [];
  for (let count = 1; count < segments.length; count += 1) {
    const prefix = segments.slice(0, count);
    const directory = `${root}/${prefix.join("/")}`;
    modules.push({ phrase: prefix.join("."), files: INITIALIZER_NAMES.map((name) => `${directory}/${name}`) });
  }
  modules.push({ phrase: imp.from, files: [leaf] });
  return modules;
}

/** The indexed file of the first spelling that is one, or undefined when the module is not an indexed file. */
function indexedModuleFile(index: ProjectIndex, files: readonly string[]): string | undefined {
  for (const file of files) {
    const entry = index.byFile.get(fileIdentityKey(file));
    if (entry) return entry.file;
  }
  return undefined;
}

/** The indexed `__init__` of the package an unaliased `import a.b.c` binds as `a`; undefined when it is not indexed. */
export function pythonDottedImportPackageFile(index: ProjectIndex, imp: ImportBinding): string | undefined {
  const [binding] = pythonImportedModules(imp);
  return binding ? indexedModuleFile(index, binding.files) : undefined;
}

/**
 * The indexed file of every module an unaliased dotted import names, with the spelling that names it. A package
 * without an indexed `__init__` (a namespace package) is left out.
 */
export function pythonImportedModuleFiles(
  index: ProjectIndex,
  imp: ImportBinding,
): ReadonlyArray<{ phrase: string; file: string }> {
  const named: Array<{ phrase: string; file: string }> = [];
  for (const module of pythonImportedModules(imp)) {
    const file = indexedModuleFile(index, module.files);
    if (file) named.push({ phrase: module.phrase, file });
  }
  return named;
}

/** Every file a dotted import's packages can be, whether or not it is indexed: the targets a loaded `__init__` adds. */
export function pythonDottedImportPackageCandidates(imp: ImportBinding): readonly string[] {
  return pythonImportedModules(imp)
    .slice(0, -1)
    .flatMap((module) => module.files);
}

/**
 * The file a dotted spelling names through the unaliased dotted imports of a module: `a` and `a.b` are the packages
 * `import a.b.c` loads and `a.b.c` its leaf. Undefined when no such import spells `phrase`, null when one does but the
 * module is not an indexed file.
 */
export function pythonDottedPhraseFile(
  index: ProjectIndex,
  imports: readonly ImportBinding[],
  phrase: string,
): string | null | undefined {
  for (const imp of imports) {
    const module = pythonImportedModules(imp).find((candidate) => candidate.phrase === phrase);
    if (module) return indexedModuleFile(index, module.files) ?? null;
  }
  return undefined;
}

/**
 * The module a namespace export of `name` stands for. A module that runs an unaliased `import a.b.c` exports `a` as the
 * namespace of the leaf `a.b.c`, yet the name is the package: its indexed file, or undefined when the package is not
 * indexed. Any other namespace is its own file.
 */
export function pythonNamespaceExportFile(
  index: ProjectIndex,
  imports: readonly ImportBinding[],
  name: string,
  file: string,
): string | undefined {
  const exportedLeaf = fileIdentityKey(file);
  const dotted = imports.find(
    (imp) =>
      imp.kind === "namespace" &&
      imp.localNS === name &&
      typeof imp.resolved === "string" &&
      fileIdentityKey(imp.resolved) === exportedLeaf &&
      isPythonDottedImportBinding(imp),
  );
  return dotted ? pythonDottedImportPackageFile(index, dotted) : file;
}

/**
 * The names the unaliased dotted imports of a module make submodules of each package they load, keyed by that package's
 * file identity: `b` for the package `a` after an `import a.b.c`. Once such an import has run, `a.b` is that submodule,
 * whatever the package's own `__init__` declares by that name.
 */
export function pythonLoadedSubmodules(
  index: ProjectIndex,
  imports: readonly ImportBinding[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byPackage = new Map<string, Set<string>>();
  for (const imp of imports) {
    const packages = pythonImportedModules(imp).slice(0, -1);
    if (!packages.length) continue;
    const segments = imp.from.split(".");
    for (const [position, module] of packages.entries()) {
      const file = indexedModuleFile(index, module.files);
      const next = segments[position + 1];
      if (!file || !next) continue;
      const key = fileIdentityKey(file);
      const names = byPackage.get(key);
      if (names) names.add(next);
      else byPackage.set(key, new Set([next]));
    }
  }
  return byPackage;
}
