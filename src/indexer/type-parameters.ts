import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { sliceText } from "../util/ast.js";

/** Type-parameter list nodes across the TypeScript, Java, Rust, Swift, C#, Kotlin, Go, and C++ grammars. */
const TYPE_PARAMETER_LIST_TYPES: Readonly<Record<string, true>> = {
  type_parameters: true,
  type_parameter_list: true,
  template_parameter_list: true,
};

const NAME_NODE_TYPES: Readonly<Record<string, true>> = {
  identifier: true,
  type_identifier: true,
};

function isNameNode(node: SyntaxNodeLike): boolean {
  return !!NAME_NODE_TYPES[node.type];
}

/** The names one type-parameter declaration introduces: Go `[K, V I]` declares two, every other form one. */
export function declaredNameNodes(parameter: SyntaxNodeLike): SyntaxNodeLike[] {
  if (parameter.type === "template_template_parameter_declaration") {
    return parameter.namedChildren
      .filter((child) => child.type === "type_parameter_declaration")
      .flatMap((child) => declaredNameNodes(child));
  }
  if (parameter.type === "type_parameter_declaration") return parameter.namedChildren.filter(isNameNode);
  const name = parameter.namedChildren.find(isNameNode) ?? parameter.childForFieldName("name");
  return name ? [name] : [];
}

/** Go receiver type parameters: the type arguments of `func (b Box[T]) M()` declare `T`. */
function goReceiverNameNodes(method: SyntaxNodeLike): SyntaxNodeLike[] {
  const receiver = method.childForFieldName("receiver");
  const parameter = receiver?.namedChildren.find((child) => child.type === "parameter_declaration");
  let type = parameter?.childForFieldName("type") ?? null;
  while (type && (type.type === "pointer_type" || type.type === "parenthesized_type")) {
    type = type.namedChildren[0] ?? null;
  }
  if (type?.type !== "generic_type") return [];
  const argumentList = type.namedChildren.find((child) => child.type === "type_arguments");
  return (argumentList?.namedChildren ?? [])
    .map((element) => (element.type === "type_elem" ? element.namedChildren[0] : element))
    .filter((name): name is SyntaxNodeLike => !!name && name.type === "type_identifier");
}

/** Python PEP 695 `[T, T: I, *Ts, **P]`: the list is one `type_parameter` node whose `type` children name the parameters. */
function pythonListNameNodes(list: SyntaxNodeLike): SyntaxNodeLike[] {
  return list.namedChildren.flatMap((entry) => {
    let name: SyntaxNodeLike | undefined = entry.namedChildren[0];
    if (name?.type === "constrained_type") name = name.namedChildren[0]?.namedChildren[0];
    else if (name?.type === "splat_type") name = name.namedChildren[0];
    return name?.type === "identifier" ? [name] : [];
  });
}

function isPythonTypeParameterList(node: SyntaxNodeLike): boolean {
  return node.type === "type_parameter" && node.namedChildren.every((child) => child.type === "type");
}

/** Name nodes of the type parameters `declaration` itself declares. */
function declarationNameNodes(declaration: SyntaxNodeLike, use: SyntaxNodeLike): SyntaxNodeLike[] {
  const names: SyntaxNodeLike[] = [];
  for (const child of declaration.namedChildren) {
    // A declaration's parameter list precedes everything inside it, so later siblings cannot hold it.
    if (child.startIndex > use.startIndex) break;
    if (isPythonTypeParameterList(child)) {
      names.push(...pythonListNameNodes(child));
      continue;
    }
    if (!TYPE_PARAMETER_LIST_TYPES[child.type]) continue;
    for (const parameter of child.namedChildren) names.push(...declaredNameNodes(parameter));
  }
  if (declaration.type === "method_declaration") names.push(...goReceiverNameNodes(declaration));
  return names;
}

/**
 * Generic type parameters visible at `node`: those declared by the enclosing declarations (function, method, type,
 * `template`). A type parameter is a type variable, never a nominal type, whatever a same-named class declares.
 */
export function typeParameterNamesInScope(node: SyntaxNodeLike, source: string): Set<string> {
  const names = new Set<string>();
  for (let current: SyntaxNodeLike | null = node; current?.parent; current = current.parent) {
    for (const name of declarationNameNodes(current, node)) names.add(sliceText(name, source));
  }
  return names;
}

/** Whether `name` at `node` is a generic type parameter of an enclosing declaration. */
export function bindsTypeParameter(
  name: string,
  node: SyntaxNodeLike,
  source: string,
  support: LanguageSupport,
): boolean {
  const normalized = support.normalizeIdentifier(name);
  for (let current: SyntaxNodeLike | null = node; current?.parent; current = current.parent) {
    for (const declared of declarationNameNodes(current, node)) {
      if (support.normalizeIdentifier(sliceText(declared, source)) === normalized) return true;
    }
  }
  return false;
}
