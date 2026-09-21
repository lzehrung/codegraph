import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText } from "../util/ast.js";
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
 * stores each candidate file's identifiers with that file's own spelling, so a case-variant
 * reference would be filtered out before collection ever runs.
 */
export function isPhpCaseInsensitiveSymbolKind(kind: string): boolean {
  return !!PHP_CASE_INSENSITIVE_SYMBOL_KINDS[kind];
}

export function foldPhpIdentifierCase(value: string): string {
  let folded = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[index]!;
  }
  return folded;
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

/**
 * The absolute spelling a PHP reference resolves to, using the reference's own file
 * namespace: `\Foo\Bar` is already absolute, `namespace\Foo` prefixes the current
 * namespace, and a bare or partially qualified name is relative to the current namespace.
 */
export function canonicalPhpReferenceName(
  rawName: string,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike | null,
): string | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  if (/^\\+/.test(trimmed)) return trimmed.replace(/^\\+/, "");
  const currentNamespace = readPhpNamespaceFromNode(tree, node, source);
  if (trimmed.startsWith("namespace\\")) {
    const suffix = trimmed.slice("namespace\\".length);
    if (!suffix) return currentNamespace;
    return currentNamespace ? `${currentNamespace}\\${suffix}` : suffix;
  }
  return currentNamespace ? `${currentNamespace}\\${trimmed}` : trimmed;
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

export function inferPhpQualifiedReferenceImportType(node: SyntaxNodeLike): "class" | "function" | undefined {
  let current: SyntaxNodeLike | null = node;
  while (current) {
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
