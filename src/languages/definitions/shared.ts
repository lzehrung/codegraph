import type { SyntaxNodeLike } from "../types.js";

/**
 * Hook shapes repeated across the language definitions: `isDeclarationName` as a
 * parent-name-field check, `classifyDefinition` as a parent-type switch, and the scope
 * predicates as node-type unions. Each definition supplies only its per-language data.
 */

/** True when `node` is the child named `field` of a parent whose type is listed. */
export function isNameFieldOnParent(node: SyntaxNodeLike, parentTypes: readonly string[], field = "name"): boolean {
  const parent = node.parent;
  if (!parent || !parentTypes.includes(parent.type)) return false;
  return parent.childForFieldName(field)?.id === node.id;
}

/**
 * True when `node` is the `name` child of a listed parent type, falling back to the
 * `property` child for grammars that spell class fields either way.
 */
export function isNameOrPropertyFieldOnParent(node: SyntaxNodeLike, parentTypes: readonly string[]): boolean {
  const parent = node.parent;
  if (!parent || !parentTypes.includes(parent.type)) return false;
  const name = parent.childForFieldName("name") ?? parent.childForFieldName("property");
  return name?.id === node.id;
}

/** True when `node`'s direct parent has one of the listed types. */
export function hasParentType(node: SyntaxNodeLike, parentTypes: readonly string[]): boolean {
  return parentTypes.includes(node.parent?.type ?? "");
}

/**
 * True when `node`'s parent type and its own type form one of the listed pairs, for
 * grammars that name declarations positionally instead of through a `name` field.
 */
export function matchesParentTypePairs(node: SyntaxNodeLike, pairs: readonly (readonly [string, string])[]): boolean {
  const parentType = node.parent?.type;
  if (!parentType) return false;
  return pairs.some(([parent, child]) => parent === parentType && child === node.type);
}

/** A classification entry is a kind, or a kind gated on the node being the parent's named field. */
export type ParentTypeClassification = string | { kind: string; nameField?: string };

/**
 * Builds `classifyDefinition` from a parent-type map. Non-matching parents (or a name-field
 * entry whose node is not the field child) classify as `fallback`.
 */
export function classifyByParentType(
  mapping: Readonly<Record<string, ParentTypeClassification>>,
  fallback = "variable",
): (node: SyntaxNodeLike) => string {
  return (node: SyntaxNodeLike): string => {
    const parent = node.parent;
    if (!parent) return fallback;
    const entry = mapping[parent.type];
    if (entry === undefined) return fallback;
    if (typeof entry === "string") return entry;
    if (entry.nameField !== undefined && parent.childForFieldName(entry.nameField)?.id !== node.id) {
      return fallback;
    }
    return entry.kind;
  };
}

/** Node-type membership predicate for `createsBlockScope` / `createsFunctionScope`. */
export function nodeTypeIn(types: readonly string[]): (node: SyntaxNodeLike) => boolean {
  const nodeTypes = new Set(types);
  return (node: SyntaxNodeLike): boolean => nodeTypes.has(node.type);
}
