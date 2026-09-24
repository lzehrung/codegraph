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
  for (let depth = 0; current && depth < 8; depth += 1) {
    const name = current.childForFieldName("name");
    if (name) {
      current = name;
      continue;
    }
    const declarator = current.childForFieldName("declarator");
    if (declarator) {
      current = declarator;
      continue;
    }
    return current.type === "identifier" || current.type === "field_identifier" ? current : null;
  }
  return null;
}

function fingerprintNode(node: SyntaxNodeLike, omittedSpans: ReadonlySet<string>): string {
  const key = `${node.startIndex}:${node.endIndex}`;
  if (omittedSpans.has(key) || node.type === "comment") return "";
  const children = node.namedChildren.filter((child) => child.type !== "comment");
  if (!children.length) return `${node.type}:${node.text.replace(/\s+/gu, "")}`;
  const parts = children.map((child) => fingerprintNode(child, omittedSpans)).filter(Boolean);
  return `${node.type}(${parts.join(",")})`;
}

function parameterFingerprint(parameter: SyntaxNodeLike): string {
  const omittedSpans = new Set<string>();
  const name = parameterName(parameter);
  const defaultValue = parameter.childForFieldName("default_value");
  if (name) omittedSpans.add(`${name.startIndex}:${name.endIndex}`);
  if (defaultValue) omittedSpans.add(`${defaultValue.startIndex}:${defaultValue.endIndex}`);
  return parameter.namedChildren
    .map((child) => fingerprintNode(child, omittedSpans))
    .filter(Boolean)
    .join(",");
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
  const suffix = declarator.text.slice(parameters.endIndex - declarator.startIndex).replace(/\s+/gu, "");
  return {
    signature: `${parameterNodes.map(parameterFingerprint).join("|")}::${suffix}`,
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
  return entity.bindings.find(cppBindingIsDefinition) ?? entity.bindings[0]!;
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
  if (matches.length === 1) return preferredCppCallableBinding(matches[0]!);
  const exactFiniteMatches = matches.filter((entity) => entity.maxArity === argumentCount);
  return exactFiniteMatches.length === 1 ? preferredCppCallableBinding(exactFiniteMatches[0]!) : null;
}

export function cppBindingIsDefinition(binding: Binding): boolean {
  let current = binding.node ?? null;
  while (current) {
    if (current.type === "function_definition") return true;
    if (current.type === "declaration" || current.type === "program") return false;
    current = current.parent;
  }
  return false;
}
