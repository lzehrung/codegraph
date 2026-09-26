import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
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

export function earliestSymbolDef(defs: readonly SymbolDef[]): SymbolDef {
  let earliest = defs[0]!;
  for (const def of defs) {
    const start = def.range.start.index ?? 0;
    const earliestStart = earliest.range.start.index ?? 0;
    if (start < earliestStart) earliest = def;
  }
  return earliest;
}
