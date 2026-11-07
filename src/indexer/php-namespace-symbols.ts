import path from "node:path";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";
import {
  findPhpComposerPath,
  getPhpComposerAutoloadFiles,
  isPhpComposerClassmapExcluded,
  loadPhpComposerConfig,
} from "../util/resolution/php-composer.js";
import type { ImportBinding } from "./import-types.js";
import {
  canonicalPhpReferenceNames,
  findPhpImportAlias,
  inferPhpQualifiedReferenceImportType,
  readPhpNamespaceName,
  readPhpNamespaceFromRange,
} from "./navigation-php.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";
import type { ParsedFileContext } from "./parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { fileIdentityKey } from "../util/paths.js";
import { definitionIdentityKey } from "./reference-context.js";
import type { Binding } from "./scope-types.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import { collectParseErrorRanges } from "./parse-errors.js";

/**
 * Absolute PHP class/trait/interface spellings for `name` at `node`, in PHP lookup order.
 * A `use` alias wins; otherwise the current namespace is prepended. Class names do not fall
 * back to the global namespace. Returns null unless `node` is a class-reference form
 * (`extends`, `implements`, trait `use`, `new`, or a static class scope).
 *
 * The qualified-name index comes from `ensurePhpNamespaceSymbolIndex`. Callers await that
 * before this synchronous lookup.
 */
export function resolveIndexedPhpClassReference(
  index: ProjectIndex,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike,
  name: string,
  imports: readonly ImportBinding[] | undefined,
): SymbolDef | null {
  if (inferPhpQualifiedReferenceImportType(node) !== "class") return null;
  return resolvePhpNamespaceSymbol(index, source, tree, node, name, imports, "class");
}

/**
 * Resolves `name` from `node`'s namespace using PHP's ordered candidates. Callers that already
 * know the name is a class or function (a base clause, for example) skip the syntactic role check.
 */
export function resolvePhpNamespaceSymbol(
  index: ProjectIndex,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike,
  name: string,
  imports: readonly ImportBinding[] | undefined,
  role: "class" | "function",
): SymbolDef | null {
  if (phpAliasOwnsReference(name, imports, role)) return null;
  const candidates = canonicalPhpReferenceNames(name, source, tree, node, {
    ...(imports ? { imports } : {}),
    role,
  });
  return resolveFirstIndexedPhpSymbol(index, candidates, role);
}

/**
 * A matching `use` alias is resolved by PHP's import path, including Composer classmap
 * excludes. The namespace index must not revive a name that alias already owns.
 */
function phpAliasOwnsReference(
  name: string,
  imports: readonly ImportBinding[] | undefined,
  role: "class" | "function",
): boolean {
  if (!imports || !imports.length) return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("\\") || trimmed.startsWith("namespace\\")) return false;
  const separator = trimmed.indexOf("\\");
  const firstSegment = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const importType = separator < 0 && role === "function" ? "function" : "class";
  return findPhpImportAlias(imports, firstSegment, importType) !== null;
}

/**
 * First PHP candidate that names exactly one indexed declaration. A candidate that matches
 * more than one declaration is ambiguous and stays unresolved; later fallbacks are not tried,
 * matching PHP's ordered lookup (namespace, then global for functions only).
 */
export function resolveFirstIndexedPhpSymbol(
  index: ProjectIndex,
  candidates: readonly string[],
  role: "class" | "function",
): SymbolDef | null {
  const symbols = phpNamespaceSymbolIndexFor(index);
  if (!symbols) return null;
  const map = role === "function" ? symbols.functions : symbols.classes;
  for (const candidate of candidates) {
    const key = foldPhpIdentifierCase(candidate.trim().replace(/^\\+/, ""));
    if (!key) continue;
    const matches = map.get(key) ?? [];
    if (matches.length === 1) return matches[0] ?? null;
    if (matches.length > 1) return null;
  }
  return null;
}

/** PHP's class import namespace: classes (including traits), interfaces, and enums. */
export const PHP_CLASS_LIKE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.TypeAlias,
]);

/** PHP namespace segments fold case; the final constant identifier does not. */
function phpConstantQualifiedKey(name: string): string {
  const separator = name.lastIndexOf("\\");
  return separator < 0 ? name : foldPhpIdentifierCase(name.slice(0, separator)) + name.slice(separator);
}

type PhpNamespaceRegion = { start: number; end: number; name: string | null };
type PhpNamespaceLookup = { regions: PhpNamespaceRegion[]; cursor: number };

function collectPhpNamespaceRegions(parsed: ParsedFileContext): PhpNamespaceLookup {
  const root = parsed.tree.rootNode;
  const regions: PhpNamespaceRegion[] = [];
  let openRegion: PhpNamespaceRegion | undefined;
  for (let index = 0; ; index += 1) {
    const child = root.child(index);
    if (!child) break;
    if (child.type !== "namespace_definition") continue;
    if (openRegion) openRegion.end = child.startIndex;
    const body = child.childForFieldName("body");
    const region = {
      start: child.startIndex,
      end: body ? child.endIndex : root.endIndex,
      name: readPhpNamespaceName(child, parsed.source),
    };
    regions.push(region);
    openRegion = body ? undefined : region;
  }
  return { regions, cursor: -1 };
}

function phpNamespaceAtOffset(lookup: PhpNamespaceLookup, offset: number): string | null {
  const regions = lookup.regions;
  let cursor = lookup.cursor;
  if (cursor >= 0 && offset < regions[cursor]!.start) {
    // Captures need not be source-ordered. Seek backward without scanning the tree again.
    let low = 0;
    let high = cursor;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (regions[middle]!.start <= offset) low = middle + 1;
      else high = middle;
    }
    cursor = low - 1;
  } else {
    while (cursor + 1 < regions.length && regions[cursor + 1]!.start <= offset) cursor += 1;
  }
  lookup.cursor = cursor;
  const region = regions[cursor];
  return region && offset < region.end ? region.name : null;
}

function phpCanonicalDeclarationName(
  local: SymbolDef,
  parsed: ParsedFileContext,
  namespaces: PhpNamespaceLookup,
): string {
  const offset = local.range.start.index;
  const namespace =
    offset === undefined
      ? readPhpNamespaceFromRange(parsed.tree, parsed.source, local.range)
      : phpNamespaceAtOffset(namespaces, offset);
  return (namespace ? `${namespace}\\${local.localName}` : local.localName).replace(/^\\+/, "");
}

function phpDeclarationsIncomplete(moduleEntry: ModuleIndex, parsed: ParsedFileContext): boolean {
  if (moduleEntry.parserDegraded) return true;
  if (moduleEntry.parseErrorRanges) return !!moduleEntry.parseErrorRanges.length;
  if (!(parsed.tree instanceof ProjectedSyntaxTree)) return true;
  return !!collectParseErrorRanges(parsed.tree).length;
}

export const PHP_INCOMPLETE_DECLARATION_IDENTITY = "incomplete:";

export type PhpModuleImportNames = {
  classes: Set<string>;
  functions: Set<string>;
  consts: Set<string>;
  namespaces: Set<string>;
  incomplete: boolean;
};

/** Compact declaration facts using the same qualified names and roles as PHP navigation. */
export function collectPhpModuleImportNames(moduleEntry: ModuleIndex, parsed: ParsedFileContext): PhpModuleImportNames {
  const names: PhpModuleImportNames = {
    classes: new Set(),
    functions: new Set(),
    consts: new Set(),
    namespaces: new Set(),
    incomplete: phpDeclarationsIncomplete(moduleEntry, parsed),
  };
  const namespaces = collectPhpNamespaceRegions(parsed);
  for (const local of moduleEntry.locals) {
    if (local.isMember) continue;
    const canonical = phpCanonicalDeclarationName(local, parsed, namespaces);
    if (PHP_CLASS_LIKE_KINDS.has(local.kind)) names.classes.add(foldPhpIdentifierCase(canonical));
    else if (local.kind === SymbolKind.Function) names.functions.add(foldPhpIdentifierCase(canonical));
    else if (local.kind === SymbolKind.Variable) names.consts.add(phpConstantQualifiedKey(canonical));
  }
  for (const region of namespaces.regions) {
    if (region.name) names.namespaces.add(foldPhpIdentifierCase(region.name));
  }
  return names;
}

/** Own-file declaration identities for incremental import invalidation, including each PHP symbol namespace. */
export function phpDeclarationImportNames(names: PhpModuleImportNames): string[] {
  const result: string[] = [];
  if (names.incomplete) result.push(PHP_INCOMPLETE_DECLARATION_IDENTITY);
  for (const name of names.classes) result.push(`class:${name}`);
  for (const name of names.functions) result.push(`function:${name}`);
  for (const name of names.consts) result.push(`const:${name}`);
  for (const namespace of names.namespaces) {
    let name = namespace;
    while (name) {
      result.push(`namespace:${name}`);
      const separator = name.lastIndexOf("\\");
      if (separator < 0) break;
      name = name.slice(0, separator);
    }
  }
  return result;
}

/** Rehydrate own-file facts without reading or parsing an unchanged cached PHP file. */
export function phpModuleImportNamesFromDeclarations(
  identities: readonly string[],
  moduleEntry?: Pick<ModuleIndex, "parserDegraded" | "parseErrorRanges">,
): PhpModuleImportNames {
  const names: PhpModuleImportNames = {
    classes: new Set(),
    functions: new Set(),
    consts: new Set(),
    namespaces: new Set(),
    incomplete: !!(moduleEntry?.parserDegraded || moduleEntry?.parseErrorRanges?.length),
  };
  for (const identity of identities) {
    if (identity === PHP_INCOMPLETE_DECLARATION_IDENTITY) {
      names.incomplete = true;
      continue;
    }
    const separator = identity.indexOf(":");
    const role = identity.slice(0, separator);
    const name = identity.slice(separator + 1);
    if (role === "class") names.classes.add(name);
    else if (role === "function") names.functions.add(name);
    else if (role === "const") names.consts.add(name);
    else if (role === "namespace") names.namespaces.add(name);
  }
  return names;
}

/** A parsed file must declare the imported name and role; class imports can also alias namespace prefixes. */
export function phpModuleDeclaresImport(
  names: PhpModuleImportNames,
  from: string,
  role: "class" | "function" | "const",
): boolean {
  if (names.incomplete) return true;
  const name = from.trim().replace(/^\\+/, "");
  if (role === "const") return names.consts.has(phpConstantQualifiedKey(name));
  const key = foldPhpIdentifierCase(name);
  if (role === "function") return names.functions.has(key);
  if (names.classes.has(key)) return true;
  for (const namespace of names.namespaces) {
    if (namespace === key || namespace.startsWith(`${key}\\`)) return true;
  }
  return false;
}

/** A PHP use binds a qualified symbol name, even without a Composer file mapping. */
export function resolvePhpExplicitImport(
  index: ProjectIndex,
  binding: Extract<ImportBinding, { kind: "named" }>,
  role: "class" | "function" | "const",
): SymbolDef | null {
  if (binding.mechanism !== "php" || (binding.phpImportType ?? "class") !== role) return null;
  const symbols = phpNamespaceSymbolIndexFor(index);
  if (!symbols) return null;
  const qualifiedName = binding.from.trim().replace(/^\\+/, "");
  if (!qualifiedName) return null;
  const key = role === "const" ? phpConstantQualifiedKey(qualifiedName) : foldPhpIdentifierCase(qualifiedName);
  let matches: SymbolDef[] | undefined;
  if (role === "class") matches = symbols.classes.get(key);
  else if (role === "function") matches = symbols.functions.get(key);
  else matches = symbols.consts.get(key);
  if (!matches) return null;
  const resolvedFile = typeof binding.resolved === "string" ? fileIdentityKey(binding.resolved) : undefined;
  const visibility = symbols.composerAutoloadByImport.get(binding);
  let found: SymbolDef | null = null;
  for (const def of matches) {
    const fileKey = fileIdentityKey(def.file);
    if (resolvedFile) {
      if (fileKey !== resolvedFile) continue;
    } else if (visibility) {
      if (!visibility.files.has(path.resolve(def.file))) {
        const included = visibility.module.imports.some(
          (candidate) =>
            candidate.kind === "star" &&
            candidate.mechanism === "php" &&
            typeof candidate.resolved === "string" &&
            fileIdentityKey(candidate.resolved) === fileKey,
        );
        if (!included) continue;
      }
    } else if (symbols.composerExcludedFiles.has(fileKey)) {
      continue;
    }
    if (found) return null;
    found = def;
  }
  return found;
}

export type PhpNamespaceSymbolIndex = {
  classes: Map<string, SymbolDef[]>;
  functions: Map<string, SymbolDef[]>;
  consts: Map<string, SymbolDef[]>;
  functionNames: string[];
  /** Definition identity key -> canonical qualified name without a leading `\\`. */
  canonicalByDefinition: Map<string, string>;
  /** Files explicitly excluded by Composer without another autoload mapping. */
  composerExcludedFiles: Set<string>;
  /** Composer autoload files plus source-proven PHP includes for each importing module. */
  composerAutoloadByImport: WeakMap<ImportBinding, { files: ReadonlySet<string>; module: ModuleIndex }>;
  source: ProjectIndex["byFile"];
  size: number;
};

const phpNamespaceSymbolIndexes = new WeakMap<ProjectIndex, PhpNamespaceSymbolIndex>();
const phpNamespaceSymbolIndexBuilds = new WeakMap<ProjectIndex, Promise<PhpNamespaceSymbolIndex>>();

function pushPhpNamespaceSymbol(map: Map<string, SymbolDef[]>, key: string, def: SymbolDef): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [def]);
    return;
  }
  const start = def.range.start.index;
  if (
    existing.some((candidate) => {
      const candidateStart = candidate.range.start.index;
      return (
        fileIdentityKey(candidate.file) === fileIdentityKey(def.file) &&
        candidate.localName === def.localName &&
        candidateStart === start
      );
    })
  ) {
    return;
  }
  existing.push(def);
}

/**
 * Qualified PHP names for one index, read once from each declaration's parsed tree.
 * `phpIndexedCanonicalNames` and same-namespace lookup share this table. A replaced
 * `byFile` map rebuilds it. Ambiguous spellings stay as multiple defs.
 */
export function ensurePhpNamespaceSymbolIndex(index: ProjectIndex): Promise<PhpNamespaceSymbolIndex> {
  const cached = phpNamespaceSymbolIndexes.get(index);
  if (cached && cached.source === index.byFile && cached.size === index.byFile.size) return Promise.resolve(cached);
  const pending = phpNamespaceSymbolIndexBuilds.get(index);
  if (pending) return pending;
  const build = buildPhpNamespaceSymbolIndex(index)
    .then((built) => {
      phpNamespaceSymbolIndexes.set(index, built);
      return built;
    })
    .finally(() => {
      if (phpNamespaceSymbolIndexBuilds.get(index) === build) phpNamespaceSymbolIndexBuilds.delete(index);
    });
  phpNamespaceSymbolIndexBuilds.set(index, build);
  return build;
}

/** Synchronous view of `ensurePhpNamespaceSymbolIndex`. Null until that builder has finished. */
export function phpNamespaceSymbolIndexFor(index: ProjectIndex): PhpNamespaceSymbolIndex | null {
  const cached = phpNamespaceSymbolIndexes.get(index);
  if (!cached || cached.source !== index.byFile || cached.size !== index.byFile.size) return null;
  return cached;
}

/**
 * A PHP class, function, or constant role names only declarations in that namespace.
 * Pass the reference node to infer the role, or the role of a `use` binding directly.
 */
export function phpReferenceRoleMatchesKind(
  nodeOrRole: SyntaxNodeLike | "class" | "function" | "const",
  kind: SymbolKind,
): boolean {
  const role =
    nodeOrRole === "class" || nodeOrRole === "function" || nodeOrRole === "const"
      ? nodeOrRole
      : (inferPhpQualifiedReferenceImportType(nodeOrRole) ?? "const");
  if (role === "class") return PHP_CLASS_LIKE_KINDS.has(kind);
  if (role === "function") return kind === SymbolKind.Function;
  return kind === SymbolKind.Variable;
}

/** Resolve a PHP role collision from same-scope bindings or module constants. */
export function resolvePhpSameScopeRoleDefinition(
  index: ProjectIndex,
  moduleEntry: ModuleIndex,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike,
  name: string,
  binding: Binding,
): SymbolDef | null {
  const role = inferPhpQualifiedReferenceImportType(node) ?? "const";
  if (findPhpImportAlias(moduleEntry.imports, name, role)) return null;
  const symbols = phpNamespaceSymbolIndexFor(index);
  if (!symbols) return null;
  const candidates = canonicalPhpReferenceNames(
    name,
    source,
    tree,
    node,
    role === "const" ? undefined : { imports: moduleEntry.imports, role },
  );
  for (const candidateName of candidates) {
    const key = role === "const" ? phpConstantQualifiedKey(candidateName) : foldPhpIdentifierCase(candidateName);
    let found: SymbolDef | null = null;
    for (const local of moduleEntry.locals) {
      if (local.isMember || !phpReferenceRoleMatchesKind(node, local.kind)) continue;
      if (role === "const") {
        // PHP const declarations are indexed as locals but not lexical scope bindings.
        if (local.localName !== name) continue;
      } else {
        let inScope = false;
        for (let current: Binding | undefined = binding; current; current = current.earlierSameScope) {
          if (
            current.def?.start.index === local.range.start.index &&
            current.def?.end.index === local.range.end.index
          ) {
            inScope = true;
            break;
          }
        }
        if (!inScope) continue;
      }
      const canonical = symbols.canonicalByDefinition.get(definitionIdentityKey(local));
      if (!canonical) continue;
      const localKey = role === "const" ? phpConstantQualifiedKey(canonical) : foldPhpIdentifierCase(canonical);
      if (localKey !== key) continue;
      if (found && definitionIdentityKey(found) !== definitionIdentityKey(local)) return null;
      found = local;
    }
    if (found) return found;
  }
  return null;
}

/** Verify a class candidate proven visible through imports also names this exact PHP class. */
export function phpClassReferenceMatchesDefinition(
  index: ProjectIndex,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike,
  name: string,
  imports: readonly ImportBinding[],
  def: SymbolDef,
): boolean {
  if (!PHP_CLASS_LIKE_KINDS.has(def.kind)) return false;
  const canonical = phpNamespaceSymbolIndexFor(index)?.canonicalByDefinition.get(definitionIdentityKey(def));
  if (!canonical) return false;
  const expected = foldPhpIdentifierCase(canonical);
  return canonicalPhpReferenceNames(name, source, tree, node, { imports, role: "class" }).some(
    (candidate) => foldPhpIdentifierCase(candidate.replace(/^\\+/, "")) === expected,
  );
}

async function buildPhpNamespaceSymbolIndex(index: ProjectIndex): Promise<PhpNamespaceSymbolIndex> {
  const classes = new Map<string, SymbolDef[]>();
  const functions = new Map<string, SymbolDef[]>();
  const consts = new Map<string, SymbolDef[]>();
  const functionNames: string[] = [];
  const seenFunctionNames = new Set<string>();
  const canonicalByDefinition = new Map<string, string>();
  const composerExcludedFiles = new Set<string>();
  const composerAutoloadByImport: PhpNamespaceSymbolIndex["composerAutoloadByImport"] = new WeakMap();

  const phpModules: ModuleIndex[] = [];
  for (const moduleEntry of index.byFile.values()) {
    if (supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.id === "php") {
      phpModules.push(moduleEntry);
    }
  }

  const parsedByFile = new Map<string, ParsedFileContext | null>();
  await Promise.all(
    phpModules.map(async (moduleEntry) => {
      const key = fileIdentityKey(moduleEntry.file);
      try {
        const parsed = await ensureParsedContextForIndex(index, moduleEntry.file);
        parsedByFile.set(key, parsed.sup.id === "php" ? parsed : null);
      } catch (error) {
        rethrowStaleQuerySource(error);
        parsedByFile.set(key, null);
      }
      if (index.projectRoot) {
        const composerPath = await findPhpComposerPath(index.projectRoot, moduleEntry.file);
        if (composerPath) {
          const config = await loadPhpComposerConfig(composerPath);
          if (config) {
            const excluded = isPhpComposerClassmapExcluded(moduleEntry.file, config);
            const hasPhpImports = moduleEntry.imports.some(
              (binding) => binding.kind === "named" && binding.mechanism === "php",
            );
            if (excluded || hasPhpImports) {
              const autoloadFiles = await getPhpComposerAutoloadFiles(composerPath, config);
              if (excluded && !autoloadFiles.has(path.resolve(moduleEntry.file))) composerExcludedFiles.add(key);
              if (hasPhpImports) {
                const visibility = { files: autoloadFiles, module: moduleEntry };
                for (const binding of moduleEntry.imports) {
                  if (binding.kind === "named" && binding.mechanism === "php") {
                    composerAutoloadByImport.set(binding, visibility);
                  }
                }
              }
            }
          }
        }
      }
    }),
  );

  for (const moduleEntry of phpModules) {
    const parsed = parsedByFile.get(fileIdentityKey(moduleEntry.file)) ?? null;
    if (!parsed) continue;
    const namespaces = collectPhpNamespaceRegions(parsed);
    for (const local of moduleEntry.locals) {
      if (local.isMember) continue;
      const canonical = phpCanonicalDeclarationName(local, parsed, namespaces);
      const cacheKey = definitionIdentityKey(local);
      if (!canonical) continue;
      canonicalByDefinition.set(cacheKey, canonical);
      const folded = foldPhpIdentifierCase(canonical);
      if (PHP_CLASS_LIKE_KINDS.has(local.kind)) pushPhpNamespaceSymbol(classes, folded, local);
      else if (local.kind === SymbolKind.Function) {
        pushPhpNamespaceSymbol(functions, folded, local);
        if (!seenFunctionNames.has(folded)) {
          seenFunctionNames.add(folded);
          functionNames.push(canonical);
        }
      } else if (local.kind === SymbolKind.Variable)
        pushPhpNamespaceSymbol(consts, phpConstantQualifiedKey(canonical), local);
    }
  }

  return {
    classes,
    functions,
    consts,
    functionNames,
    canonicalByDefinition,
    composerExcludedFiles,
    composerAutoloadByImport,
    source: index.byFile,
    size: index.byFile.size,
  };
}
