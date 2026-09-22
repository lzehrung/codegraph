import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ImportBinding } from "./import-types.js";
import { sliceText } from "../util/ast.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";
import { SymbolKind } from "./types.js";

function readPhpNamespaceName(namespaceNode: SyntaxNodeLike, source: string): string | null {
  const namespaceName =
    namespaceNode.childForFieldName?.("name") ??
    namespaceNode.namedChildren.find((child) => child.type === "namespace_name");
  return namespaceName ? sliceText(namespaceName, source).trim() : null;
}

function findClosestPhpNamespaceDefinition(root: SyntaxNodeLike, targetIndex: number): SyntaxNodeLike | null {
  let bestMatch: SyntaxNodeLike | null = null;

  const visit = (node: SyntaxNodeLike): void => {
    if (node.startIndex > targetIndex) {
      return;
    }
    if (node.type === "namespace_definition" && (!bestMatch || node.startIndex >= bestMatch.startIndex)) {
      bestMatch = node;
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(root);
  return bestMatch;
}

function readPhpNamespaceFromNode(tree: SyntaxTreeLike, node: SyntaxNodeLike | null, source: string): string | null {
  if (!node) return null;
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "namespace_definition") {
      return readPhpNamespaceName(current, source);
    }
    current = current.parent;
  }
  const namespaceNode = findClosestPhpNamespaceDefinition(tree.rootNode, node.startIndex);
  return namespaceNode ? readPhpNamespaceName(namespaceNode, source) : null;
}

export function readPhpNamespaceFromRange(tree: SyntaxTreeLike, source: string, range: Range): string | null {
  const row = Math.max(0, range.start.line - 1);
  const column = Math.max(0, range.start.column - 1);
  const position = { row, column };
  const node = tree.rootNode.descendantForPosition(position, position);
  return readPhpNamespaceFromNode(tree, node, source);
}

/**
 * Symbol kinds whose PHP names are case-insensitive. Keyed by `SymbolKind`, which is what
 * `SymbolDef.kind` carries: PHP's richer classifier vocabulary (`trait`, `method`, `namespace`,
 * `constant`) never reaches here, because `toKind` in `locals-and-exports.ts` maps it down.
 * PHP resolves class, interface, trait, enum, and function/method names ASCII-case-insensitively;
 * a trait is classified as `class` and an enum as `type` so both land here.
 */
const PHP_CASE_INSENSITIVE_SYMBOL_KINDS: Record<string, true> = {
  [SymbolKind.Class]: true,
  [SymbolKind.Interface]: true,
  [SymbolKind.TypeAlias]: true,
  [SymbolKind.Function]: true,
};

/**
 * Symbol kinds that PHP resolves case-sensitively, so a case variant is never the same symbol.
 * Constants and enum cases collapse into `variable` alongside `$variables`, and all three are
 * case-sensitive in PHP, so the single bucket is correct rather than merely convenient.
 */
const PHP_CASE_SENSITIVE_SYMBOL_KINDS: Record<string, true> = {
  [SymbolKind.Variable]: true,
  [SymbolKind.Default]: true,
};

/**
 * Whether PHP resolves this symbol kind's name case-insensitively. Bloom-filter narrowing
 * uses this classification to fold the probe for class-like and function names while
 * variables, properties, and constants keep their exact spelling.
 */
export function isPhpCaseInsensitiveSymbolKind(kind: string): boolean {
  return !!PHP_CASE_INSENSITIVE_SYMBOL_KINDS[kind];
}

export type PhpNameComparison = "equivalent" | "different" | "unverified";

/**
 * PHP reference-name comparator. Folds class, function, and namespace spelling
 * ASCII-case-insensitively while keeping variables and constants exact. Stored names,
 * ranges, and edit text always keep their source spelling; only comparisons fold.
 *
 * `caseSensitiveForm` marks a comparison the grammar already proves case-sensitive
 * (a `variable_name` or `constant` node). `symbolKind` is the referenced symbol's
 * `SymbolKind`; a kind outside both sets cannot be classified, so a case variant
 * reports `"unverified"` instead of guessing.
 */
export function comparePhpReferenceNames(
  reference: string,
  symbol: string,
  options?: { caseSensitiveForm?: boolean; symbolKind?: string },
): PhpNameComparison {
  if (reference === symbol) return "equivalent";
  if (options?.caseSensitiveForm) return "different";
  if (foldPhpIdentifierCase(reference) !== foldPhpIdentifierCase(symbol)) return "different";
  if (options?.symbolKind && PHP_CASE_SENSITIVE_SYMBOL_KINDS[options.symbolKind]) return "different";
  if (options?.symbolKind && PHP_CASE_INSENSITIVE_SYMBOL_KINDS[options.symbolKind]) return "equivalent";
  return "unverified";
}

export function phpLastIdentifierSegment(name: string): string {
  const trimmed = name.trim().replace(/^\\+/, "");
  const suffix = trimmed.startsWith("namespace\\") ? trimmed.slice("namespace\\".length) : trimmed;
  const parts = suffix.split("\\");
  return parts[parts.length - 1] ?? suffix;
}

export type PhpCanonicalNameOptions = {
  imports?: readonly ImportBinding[];
  role?: "class" | "function";
};

function phpUseAliasTarget(
  firstSegment: string,
  imports: readonly ImportBinding[] | undefined,
  role: "class" | "function" | undefined,
): string | null {
  if (!imports) return null;
  const folded = foldPhpIdentifierCase(firstSegment);
  for (const imp of imports) {
    if (imp.kind !== "named" || imp.mechanism !== "php") continue;
    if (role === "function") {
      if (imp.phpImportType !== "function") continue;
    } else if (imp.phpImportType && imp.phpImportType !== "class") {
      continue;
    }
    if (foldPhpIdentifierCase(imp.local) !== folded) continue;
    return imp.from.replace(/^\\+/, "");
  }
  return null;
}

/**
 * The absolute spelling a PHP reference resolves to, using the reference's own file
 * namespace: `\Foo\Bar` is already absolute, `namespace\Foo` prefixes the current
 * namespace, and a bare or partially qualified name is relative to the current namespace.
 * The first segment of a relative name is resolved against `use` aliases ASCII-case-insensitively
 * before the current namespace is prefixed. Unqualified function names keep an ordered list:
 * `CurrentNamespace\name`, then the global `name`. Class names do not fall back. Consumers must
 * take the first existing candidate; the list is not an unordered set of equivalents.
 */
export function canonicalPhpReferenceNames(
  rawName: string,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike | null,
  options?: PhpCanonicalNameOptions,
): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) return [];
  if (/^\\+/.test(trimmed)) {
    const absolute = trimmed.replace(/^\\+/, "");
    return absolute ? [absolute] : [];
  }
  const currentNamespace = readPhpNamespaceFromNode(tree, node, source);
  if (trimmed.startsWith("namespace\\")) {
    const suffix = trimmed.slice("namespace\\".length);
    if (!suffix) return currentNamespace ? [currentNamespace] : [];
    return [currentNamespace ? `${currentNamespace}\\${suffix}` : suffix];
  }
  const separator = trimmed.indexOf("\\");
  const firstSegment = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const remainder = separator < 0 ? "" : trimmed.slice(separator + 1);
  const aliasTarget = phpUseAliasTarget(firstSegment, options?.imports, separator < 0 ? options?.role : "class");
  if (aliasTarget) {
    return [remainder ? `${aliasTarget}\\${remainder}` : aliasTarget];
  }
  const relative = currentNamespace ? `${currentNamespace}\\${trimmed}` : trimmed;
  if (options?.role === "function" && currentNamespace && separator < 0) {
    return [relative, trimmed];
  }
  return [relative];
}

/**
 * PHP unqualified function lookup is `CurrentNamespace\\name`, then global `name`.
 * Walk `candidates` in that order and return the first name that already exists.
 */
export function selectFirstExistingPhpCanonicalName(
  candidates: readonly string[],
  existingNames: readonly string[],
  symbolKind: string,
): string | null {
  for (const candidate of candidates) {
    for (const existingName of existingNames) {
      if (comparePhpReferenceNames(candidate, existingName, { symbolKind }) === "equivalent") {
        return candidate;
      }
    }
  }
  return null;
}

export function canonicalPhpReferenceName(
  rawName: string,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike | null,
  options?: PhpCanonicalNameOptions,
): string | null {
  return canonicalPhpReferenceNames(rawName, source, tree, node, options)[0] ?? null;
}

/**
 * True when a reference node spells a namespace-qualified path (`App\Name`, `\App\Name`, or
 * `namespace\Name`). A bare `name` is not a qualified path, so PHP could resolve it as a
 * same-named constant rather than the class or function.
 */
export function isPhpQualifiedReferenceNode(node: SyntaxNodeLike | null): boolean {
  return node?.type === "qualified_name" || node?.type === "relative_name";
}

/**
 * True when a node sits inside a PHP `use`/`use function`/`use const` declaration. Import
 * declaration tokens are reported by the import-binding path, so the qualified-name scan must
 * not report the declaration's whole `App\Name` specifier as an additional reference site.
 */
export function isInsidePhpUseDeclaration(node: SyntaxNodeLike | null): boolean {
  let current = node?.parent ?? null;
  while (current) {
    if (current.type === "namespace_use_declaration") return true;
    current = current.parent;
  }
  return false;
}

export function getPhpQualifiedReference(node: SyntaxNodeLike | null, source: string): string | null {
  if (!node) return null;
  if (node.type === "qualified_name" || node.type === "relative_name") {
    return sliceText(node, source);
  }
  const parent = node.parent;
  if (parent && (parent.type === "qualified_name" || parent.type === "relative_name")) {
    return sliceText(parent, source);
  }
  return null;
}

export function normalizePhpQualifiedReference(
  rawName: string,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike | null,
): string | null {
  const trimmed = rawName.trim().replace(/^\\+/, "");
  if (!trimmed) return null;
  if (!trimmed.startsWith("namespace\\")) {
    return trimmed;
  }
  const currentNamespace = readPhpNamespaceFromNode(tree, node, source);
  const relativeSuffix = trimmed.slice("namespace\\".length);
  if (!relativeSuffix) {
    return currentNamespace;
  }
  if (!currentNamespace) {
    return relativeSuffix;
  }
  return `${currentNamespace}\\${relativeSuffix}`;
}

const PHP_CLASS_REFERENCE_CONTEXTS = new Set(["named_type", "base_clause", "class_interface_clause"]);

function containsNode(container: SyntaxNodeLike, node: SyntaxNodeLike): boolean {
  return container.startIndex <= node.startIndex && container.endIndex >= node.endIndex;
}

export function inferPhpQualifiedReferenceImportType(node: SyntaxNodeLike): "class" | "function" | undefined {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (PHP_CLASS_REFERENCE_CONTEXTS.has(current.type)) {
      return "class";
    }
    if (current.type === "attribute") {
      const attributeName = current.childForFieldName("name") ?? current.namedChildren[0];
      if (attributeName && containsNode(attributeName, node)) return "class";
    }
    if (current.type === "object_creation_expression") {
      return "class";
    }
    if (current.type === "function_call_expression" || current.type === "call_expression") {
      return "function";
    }
    if (
      current.type === "scoped_call_expression" ||
      current.type === "scoped_property_access_expression" ||
      current.type === "class_constant_access_expression"
    ) {
      return "class";
    }
    current = current.parent;
  }
  return undefined;
}
