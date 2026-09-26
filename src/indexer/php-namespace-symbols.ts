import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";
import type { ImportBinding } from "./import-types.js";
import {
  canonicalPhpReferenceNames,
  findPhpImportAlias,
  inferPhpQualifiedReferenceImportType,
} from "./navigation-php.js";
import { phpNamespaceSymbolIndexFor } from "./navigation-references.js";
import type { ProjectIndex, SymbolDef } from "./types.js";

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
