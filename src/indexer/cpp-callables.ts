import { declarationMemberArity } from "../graphs/symbol-graph-detailed/ast.js";
import { callArgumentCount } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { Binding } from "./scope-types.js";

export type CppCallableShape = {
  signature: string;
  minArity: number;
  maxArity: number | null;
};

type CppCallableEntity = {
  bindings: Binding[];
  minArity: number;
  maxArity: number | null;
};

function functionDeclarator(node: SyntaxNodeLike | null): SyntaxNodeLike | null {
  let current = node;
  while (current) {
    if (current.type === "function_declarator") return current;
    if (current.type === "program") return null;
    current = current.parent;
  }
  return null;
}

function parameterName(parameter: SyntaxNodeLike): SyntaxNodeLike | null {
  let current = parameter.childForFieldName("declarator");
  while (current) {
    if (current.type === "identifier" || current.type === "field_identifier") return current;
    const nested = current.childForFieldName("name") ?? current.childForFieldName("declarator");
    if (nested) {
      current = nested;
    } else if (
      current.type === "reference_declarator" ||
      current.type === "parenthesized_declarator" ||
      current.type === "variadic_declarator"
    ) {
      current = current.namedChildren.find((child) => child.type !== "comment") ?? null;
    } else {
      return null;
    }
  }
  return null;
}

function appendFingerprintTokens(node: SyntaxNodeLike, omittedSpans: Set<string>, tokens: string[]): void {
  if (node.type === "comment" || omittedSpans.has(`${node.startIndex}:${node.endIndex}`)) return;
  if (node.type === "parameter_declaration" || node.type === "optional_parameter_declaration") {
    const name = parameterName(node);
    const defaultValue = node.childForFieldName("default_value");
    if (name) omittedSpans.add(`${name.startIndex}:${name.endIndex}`);
    if (defaultValue) {
      omittedSpans.add(`${defaultValue.startIndex}:${defaultValue.endIndex}`);
      for (let index = 0; ; index += 1) {
        const child = node.child(index);
        if (!child) break;
        if (child.type === "=") omittedSpans.add(`${child.startIndex}:${child.endIndex}`);
      }
    }
  }
  // Named-only AST walks lose operators such as & versus &&. Leaf tokens also
  // make named and abstract declarators equivalent after parameter names are removed.
  if (!node.child(0)) {
    tokens.push(node.text);
    return;
  }
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    appendFingerprintTokens(child, omittedSpans, tokens);
  }
}

function parameterFingerprint(parameter: SyntaxNodeLike): string {
  const tokens: string[] = [];
  appendFingerprintTokens(parameter, new Set<string>(), tokens);
  return JSON.stringify(tokens);
}

function parameterListIsVariadic(parameters: SyntaxNodeLike): boolean {
  for (let index = 0; ; index += 1) {
    const child = parameters.child(index);
    if (!child) return false;
    if (child.type === "..." || child.type.includes("variadic_parameter")) return true;
  }
}

export function cppCallableShapeForNode(node: SyntaxNodeLike): CppCallableShape | null {
  const declarator = functionDeclarator(node);
  const parameters = declarator?.childForFieldName("parameters");
  if (!declarator || !parameters) return null;
  const arity = declarationMemberArity(declarator, "cpp");
  if (arity === undefined) return null;
  let parameterNodes = parameters.namedChildren.filter((child) => child.type !== "comment");
  if (!arity) parameterNodes = [];
  const optionalCount = parameterNodes.filter(
    (parameter) =>
      parameter.type === "optional_parameter_declaration" || !!parameter.childForFieldName("default_value"),
  ).length;
  const suffixTokens: string[] = [];
  for (let index = 0; ; index += 1) {
    const child = declarator.child(index);
    if (!child) break;
    if (child.startIndex >= parameters.endIndex) appendFingerprintTokens(child, new Set<string>(), suffixTokens);
  }
  return {
    signature: `${parameterNodes.map(parameterFingerprint).join("|")}::${JSON.stringify(suffixTokens)}`,
    minArity: Math.max(0, arity - optionalCount),
    maxArity: parameterListIsVariadic(parameters) ? null : arity,
  };
}

export function cppBindingCallableShape(binding: Binding): CppCallableShape | null {
  return binding.node ? cppCallableShapeForNode(binding.node) : null;
}

function cppCallArgumentCount(node: SyntaxNodeLike, source: string): number | null {
  let current = node.parent;
  while (current) {
    if (current.type === "call_expression") {
      const callee = current.childForFieldName("function");
      if (callee && callee.startIndex <= node.startIndex && callee.endIndex >= node.endIndex) {
        return callArgumentCount(current, source);
      }
    }
    if (current.type === "function_definition" || current.type === "program") return null;
    current = current.parent;
  }
  return null;
}

function cppCallableEntities(bindings: readonly Binding[]): Map<string, CppCallableEntity> | null {
  const entities = new Map<string, CppCallableEntity>();
  for (const binding of bindings) {
    const shape = cppBindingCallableShape(binding);
    if (!shape) return null;
    const existing = entities.get(shape.signature);
    if (!existing) {
      entities.set(shape.signature, {
        bindings: [binding],
        minArity: shape.minArity,
        maxArity: shape.maxArity,
      });
      continue;
    }
    existing.bindings.push(binding);
    existing.minArity = Math.min(existing.minArity, shape.minArity);
    if (existing.maxArity === null || shape.maxArity === null) {
      existing.maxArity = null;
    } else {
      existing.maxArity = Math.max(existing.maxArity, shape.maxArity);
    }
  }
  return entities;
}

function preferredCppCallableBinding(entity: CppCallableEntity): Binding {
  return entity.bindings.find((binding) => cppCallableIsDefinition(binding.node)) ?? entity.bindings[0]!;
}

/** Same-shape declarations and definitions for one C++ callable binding. */
export function cppEquivalentCallableBindings(binding: Binding): readonly Binding[] {
  const collisions = binding.sameScopeFunctionBindings ?? [binding];
  const entities = cppCallableEntities(collisions);
  if (!entities) return [binding];
  for (const entity of entities.values()) {
    if (entity.bindings.includes(binding)) return entity.bindings;
  }
  return [binding];
}

export function cppSelectCallableBinding(
  bindings: readonly Binding[],
  node: SyntaxNodeLike,
  source: string,
): Binding | null {
  const declaration = bindings.find(
    (candidate) => candidate.node?.startIndex === node.startIndex && candidate.node?.endIndex === node.endIndex,
  );
  if (declaration) return declaration;

  const entities = cppCallableEntities(bindings);
  if (!entities?.size) return null;
  if (entities.size === 1) return preferredCppCallableBinding(entities.values().next().value!);

  const argumentCount = cppCallArgumentCount(node, source);
  if (argumentCount === null) return null;
  const matches = [...entities.values()].filter(
    (entity) => argumentCount >= entity.minArity && (entity.maxArity === null || argumentCount <= entity.maxArity),
  );
  // Multiple arity-viable entities stay unresolved: default arguments and
  // variadics can overlap, and this matcher does not implement C++ ranking.
  if (matches.length === 1) return preferredCppCallableBinding(matches[0]!);
  return null;
}

export function cppCallableIsDefinition(node: SyntaxNodeLike | null | undefined): boolean {
  let current = node ?? null;
  while (current) {
    if (current.type === "function_definition") return true;
    if (current.type === "declaration" || current.type === "program") return false;
    current = current.parent;
  }
  return false;
}
