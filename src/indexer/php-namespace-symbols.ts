import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";
import type { ImportBinding } from "./import-types.js";
import {
  canonicalPhpReferenceNames,
  findPhpImportAlias,
  inferPhpQualifiedReferenceImportType,
  readPhpNamespaceFromRange,
} from "./navigation-php.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { fileIdentityKey } from "../util/paths.js";
import { definitionIdentityKey } from "./reference-context.js";

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

const PHP_CLASS_LIKE_KINDS: ReadonlySet<string> = new Set([
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.TypeAlias,
]);

export type PhpNamespaceSymbolIndex = {
  classes: Map<string, SymbolDef[]>;
  functions: Map<string, SymbolDef[]>;
  namesByKind: Map<string, string[]>;
  /** Definition identity key -> canonical qualified name without a leading `\\`. */
  canonicalByDefinition: Map<string, string>;
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

async function buildPhpNamespaceSymbolIndex(index: ProjectIndex): Promise<PhpNamespaceSymbolIndex> {
  const classes = new Map<string, SymbolDef[]>();
  const functions = new Map<string, SymbolDef[]>();
  const namesByKind = new Map<string, string[]>();
  const seenByKind = new Map<string, Set<string>>();
  const canonicalByDefinition = new Map<string, string>();

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
        const parsed = await ensureParsedContext(moduleEntry.file, index.parsed?.get(key), index.languageExtensions);
        parsedByFile.set(key, parsed.sup.id === "php" ? parsed : null);
      } catch {
        parsedByFile.set(key, null);
      }
    }),
  );

  for (const moduleEntry of phpModules) {
    const parsed = parsedByFile.get(fileIdentityKey(moduleEntry.file)) ?? null;
    for (const local of moduleEntry.locals) {
      if (local.isMember) continue;
      if (!parsed) continue;
      const phpNamespace = readPhpNamespaceFromRange(parsed.tree, parsed.source, local.range);
      const canonical = (phpNamespace ? `${phpNamespace}\\${local.localName}` : local.localName).replace(/^\\+/, "");
      const cacheKey = definitionIdentityKey(local);
      if (!canonical) continue;
      canonicalByDefinition.set(cacheKey, canonical);
      const folded = foldPhpIdentifierCase(canonical);
      if (PHP_CLASS_LIKE_KINDS.has(local.kind)) pushPhpNamespaceSymbol(classes, folded, local);
      else if (local.kind === SymbolKind.Function) pushPhpNamespaceSymbol(functions, folded, local);
      let names = namesByKind.get(local.kind);
      let seen = seenByKind.get(local.kind);
      if (!names || !seen) {
        names = [];
        seen = new Set();
        namesByKind.set(local.kind, names);
        seenByKind.set(local.kind, seen);
      }
      if (!seen.has(folded)) {
        seen.add(folded);
        names.push(canonical);
      }
    }
  }

  return { classes, functions, namesByKind, canonicalByDefinition, source: index.byFile, size: index.byFile.size };
}
