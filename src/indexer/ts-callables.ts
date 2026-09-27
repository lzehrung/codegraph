import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { getCallableArity } from "../languages/callable-arity.js";
import type { SymbolDef } from "./types.js";

const OVERLOAD_SIGNATURE_NODE_TYPES: ReadonlySet<string> = new Set([
  "function_signature",
  "method_signature",
  "abstract_method_signature",
]);

const OVERLOAD_IMPLEMENTATION_NODE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "function",
  "function_expression",
]);

export type TypeScriptCallableRole = "signature" | "implementation" | "other";

/**
 * TypeScript overload signatures and the following implementation are one callable.
 * The name node's ancestors distinguish a declaration-only signature from a body.
 */
export function typescriptCallableRole(node: SyntaxNodeLike | null | undefined): TypeScriptCallableRole {
  let current = node ?? null;
  while (current) {
    if (current.type === "ambient_declaration" || OVERLOAD_SIGNATURE_NODE_TYPES.has(current.type)) {
      return "signature";
    }
    if (OVERLOAD_IMPLEMENTATION_NODE_TYPES.has(current.type)) {
      return current.childForFieldName("body") ? "implementation" : "signature";
    }
    current = current.parent;
  }
  return "other";
}

export function typescriptCallableRoleAt(tree: SyntaxTreeLike, start: number, end: number): TypeScriptCallableRole {
  return typescriptCallableRole(tree.rootNode.descendantForIndex(start, end));
}

/** Only a single implementation can stand in for every signature of an overload group. */
export function typescriptCollapsedOverloadTarget<T>(
  group: readonly T[],
  tree: SyntaxTreeLike,
  definitionOf: (entry: T) => SymbolDef,
): T | undefined {
  let implementation: T | undefined;
  for (const entry of group) {
    const def = definitionOf(entry);
    const start = def.range.start.index ?? 0;
    const end = def.range.end.index ?? start;
    if (typescriptCallableRoleAt(tree, start, end) !== "implementation") continue;
    if (implementation) return undefined;
    implementation = entry;
  }
  return implementation;
}

/** Class, interface, or enum body that owns the callable, or the module when it is free. */
export function typescriptCallableContainerKey(tree: SyntaxTreeLike, start: number, end: number): string {
  let current: SyntaxNodeLike | null = tree.rootNode.descendantForIndex(start, end);
  while (current) {
    if (current.type === "class_body" || current.type === "interface_body" || current.type === "enum_body") {
      return `type:${current.startIndex}`;
    }
    current = current.parent;
  }
  return "module";
}

/**
 * Collapse an overload group only when one implementation is proven. Otherwise each
 * declaration remains an arity candidate.
 */
export function typescriptCollapsedOverloadCandidates<T>(
  group: readonly T[],
  tree: SyntaxTreeLike,
  definitionOf: (entry: T) => SymbolDef,
): readonly T[] {
  if (group.length < 2) return group;
  const implementation = typescriptCollapsedOverloadTarget(group, tree, definitionOf);
  return implementation ? [implementation] : group;
}

/**
 * Select one collapsed TypeScript callable for a call with a proven argument count.
 * Unresolvable or ambiguous signature groups deliberately stay unresolved.
 */
export function typescriptSelectOverloadCandidate<T>(params: {
  group: readonly T[];
  tree: SyntaxTreeLike;
  definitionOf: (entry: T) => SymbolDef;
  declarationOf: (entry: T) => SyntaxNodeLike | null | undefined;
  source: string;
  languageId: string;
  argumentCount: number | null;
}): T | undefined {
  const candidates = typescriptCollapsedOverloadCandidates(params.group, params.tree, params.definitionOf);
  if (candidates.length === 1) return candidates[0];
  if (params.argumentCount === null) return undefined;

  let selected: T | undefined;
  for (const candidate of candidates) {
    const declaration = params.declarationOf(candidate);
    const arity = declaration
      ? getCallableArity({ languageId: params.languageId, source: params.source, declaration })
      : null;
    if (
      arity &&
      (params.argumentCount < arity.minArgs || (arity.maxArgs !== null && params.argumentCount > arity.maxArgs))
    ) {
      continue;
    }
    if (selected) return undefined;
    selected = candidate;
  }
  return selected;
}
