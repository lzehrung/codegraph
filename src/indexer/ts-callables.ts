import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { getCallableArity } from "../languages/callable-arity.js";
import type { SymbolDef } from "./types.js";

const OVERLOAD_SIGNATURE_NODE_TYPES: Record<string, true> = {
  function_signature: true,
  method_signature: true,
  abstract_method_signature: true,
};

const OVERLOAD_IMPLEMENTATION_NODE_TYPES: Record<string, true> = {
  function_declaration: true,
  generator_function_declaration: true,
  method_definition: true,
  function: true,
  function_expression: true,
};

export type TypeScriptCallableRole = "signature" | "implementation" | "other";

/**
 * TypeScript overload signatures and the following implementation are one callable.
 * The name node's ancestors distinguish a declaration-only signature from a body.
 */
export function typescriptCallableRole(node: SyntaxNodeLike | null | undefined): TypeScriptCallableRole {
  let current = node ?? null;
  while (current) {
    if (current.type === "ambient_declaration" || OVERLOAD_SIGNATURE_NODE_TYPES[current.type]) {
      return "signature";
    }
    if (OVERLOAD_IMPLEMENTATION_NODE_TYPES[current.type]) {
      return current.childForFieldName("body") ? "implementation" : "signature";
    }
    current = current.parent;
  }
  return "other";
}

export function typescriptCallableRoleAt(tree: SyntaxTreeLike, start: number, end: number): TypeScriptCallableRole {
  return typescriptCallableRole(tree.rootNode.descendantForIndex(start, end));
}

/**
 * Class, interface, enum, and namespace/module bodies each own their callables.
 * "ambient_declaration" is a declaration wrapper, not a callable container: nested
 * "internal_module"/"module" nodes are found first, while standalone ambient signatures
 * remain in the file-level group.
 */
export function typescriptCallableContainerKey(tree: SyntaxTreeLike, start: number, end: number): string {
  let current: SyntaxNodeLike | null = tree.rootNode.descendantForIndex(start, end);
  while (current) {
    if (current.type === "class_body" || current.type === "interface_body" || current.type === "enum_body") {
      return "type:" + current.startIndex;
    }
    if (current.type === "internal_module" || current.type === "module") {
      return "namespace:" + current.startIndex;
    }
    current = current.parent;
  }
  return "module";
}

/** Keep only candidates whose declaration belongs to the requested callable container. */
export function typescriptCallableCandidatesInContainer<T>(
  group: readonly T[],
  tree: SyntaxTreeLike,
  rangeOf: (entry: T) => SymbolDef["range"],
  start: number,
  end: number,
): readonly T[] {
  if (!group.length) return group;
  const containerKey = typescriptCallableContainerKey(tree, start, end);
  let matching: T[] | undefined;
  for (let index = 0; index < group.length; index += 1) {
    const entry = group[index]!;
    const range = rangeOf(entry);
    const candidateStart = range.start.index ?? 0;
    const candidateEnd = range.end.index ?? candidateStart;
    if (typescriptCallableContainerKey(tree, candidateStart, candidateEnd) === containerKey) {
      if (matching) matching.push(entry);
    } else if (!matching) {
      matching = group.slice(0, index);
    }
  }
  return matching ?? group;
}

/** Only a single implementation can stand in for every signature of an overload group. */
export function typescriptCollapsedOverloadTarget<T>(
  group: readonly T[],
  tree: SyntaxTreeLike,
  definitionOf: (entry: T) => SymbolDef,
): T | undefined {
  const first = group[0];
  if (!first) return undefined;
  const firstDefinition = definitionOf(first);
  const start = firstDefinition.range.start.index ?? 0;
  const end = firstDefinition.range.end.index ?? start;
  const candidates = typescriptCallableCandidatesInContainer(
    group,
    tree,
    (entry) => definitionOf(entry).range,
    start,
    end,
  );
  if (candidates.length !== group.length) return undefined;

  let implementation: T | undefined;
  for (const entry of candidates) {
    const def = definitionOf(entry);
    const entryStart = def.range.start.index ?? 0;
    const entryEnd = def.range.end.index ?? entryStart;
    if (typescriptCallableRoleAt(tree, entryStart, entryEnd) !== "implementation") continue;
    if (implementation) return undefined;
    implementation = entry;
  }
  return implementation;
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
