import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { SymbolDef } from "../../indexer/types.js";
import { sliceText, unquote } from "../../util/ast.js";
import {
  getMemberAccessParts,
  memberExpressionTypeFor,
  memberPropertyIdentifierTypes,
} from "../../util/member-access.js";

export type DetailedFunctionNode = {
  name: string;
  node: SyntaxNodeLike;
  def: SymbolDef;
};

export type DetailedClassNode = {
  name: string;
  node: SyntaxNodeLike;
  def: SymbolDef;
};

export type DetailedDeclarationPassResult = {
  functionNodes: DetailedFunctionNode[];
  classNodes: DetailedClassNode[];
  constStringOf: Map<string, string>;
};

export const isIdentifierType = (sup: LanguageSupport, type: string): boolean =>
  Array.isArray(sup.nodeTypes?.identifier) && sup.nodeTypes.identifier.includes(type);
const FUNCTION_NAME_NODE_TYPES = new Set(["identifier", "field_identifier", "operator_name", "destructor_name"]);

/** C and C++ put the function name in a nested declarator, not a `name` field. */
function functionNameNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const named = node.childForFieldName("name");
  if (named) return named;
  let current = node.childForFieldName("declarator");
  while (current) {
    if (FUNCTION_NAME_NODE_TYPES.has(current.type)) return current;
    let name = current.childForFieldName("name");
    while (name?.childForFieldName("name")) name = name.childForFieldName("name");
    if (name && FUNCTION_NAME_NODE_TYPES.has(name.type)) return name;
    const nested = current.childForFieldName("declarator");
    if (nested) {
      current = nested;
      continue;
    }
    return current.namedChildren.find((child) => FUNCTION_NAME_NODE_TYPES.has(child.type)) ?? null;
  }
  return node.childForFieldName("type");
}

export function collectDetailedDeclarations(
  rootNode: SyntaxNodeLike,
  sup: LanguageSupport,
  source: string,
  locals: SymbolDef[],
): DetailedDeclarationPassResult {
  const functionNodes: DetailedFunctionNode[] = [];
  const classNodes: DetailedClassNode[] = [];
  const constStringOf = new Map<string, string>();
  const memberExpressionType = memberExpressionTypeFor(sup);
  const propertyIdentifierTypes = memberPropertyIdentifierTypes(sup);
  const functionNodeTypes = new Set([
    "function_declaration",
    "function_definition",
    "method_declaration",
    "method_definition",
    "method_signature",
    "abstract_method_signature",
    "constructor_declaration",
    "function_item",
    "function_signature_item",
    "method",
    "protocol_function_declaration",
    "singleton_method",
    // C# local functions are callable in their own right; ownership stays with the
    // enclosing method, not the containing class.
    "local_function_statement",
  ]);
  const typeNodeTypes = new Set([
    "class_declaration",
    "record_declaration",
    "abstract_class_declaration",
    "class_definition",
    "class",
    "interface_declaration",
    "module",
    "protocol_declaration",
    "trait_item",
    "trait_declaration",
    "struct_item",
    "struct_declaration",
    "class_specifier",
    "struct_specifier",
    // C/C++ unions declare members like structs (cpp.ts captures and classifies
    // union names as classes).
    "union_specifier",
    // Go methods sit beside the type, not inside it. Collect the type_spec so
    // member_of can name the receiver type the same way class bodies do.
    "type_spec",
    // Enums can implement interfaces/protocols in several supported languages
    // (Java, C#, PHP, Kotlin) - treat them as class-kind nodes so
    // emitClassInheritanceEdges sees them and wires implements/extends edges.
    "enum_declaration",
  ]);

  const findDefinition = (name: string, nameNode: SyntaxNodeLike): SymbolDef | undefined => {
    const candidates = locals.filter((local) => local.localName === name);
    const exact = candidates.find((local) => local.range.start.index === nameNode.startIndex);
    if (exact) return exact;
    const containing = candidates
      .filter(
        (local) =>
          (local.range.start.index ?? Number.POSITIVE_INFINITY) <= nameNode.startIndex &&
          (local.range.end.index ?? Number.NEGATIVE_INFINITY) >= nameNode.endIndex,
      )
      .sort(
        (left, right) =>
          (left.range.end.index ?? 0) -
          (left.range.start.index ?? 0) -
          ((right.range.end.index ?? 0) - (right.range.start.index ?? 0)),
      );
    return containing[0] ?? candidates[0];
  };

  const walk = (node: SyntaxNodeLike): void => {
    if (functionNodeTypes.has(node.type)) {
      const nameNode = functionNameNode(node);
      const name = nameNode ? sliceText(nameNode, source) : undefined;
      if (name) {
        const def = findDefinition(name, nameNode!);
        if (def) functionNodes.push({ name, node, def });
      }
    } else if (typeNodeTypes.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? sliceText(nameNode, source) : undefined;
      if (name) {
        const def = findDefinition(name, nameNode!);
        if (def) classNodes.push({ name, node, def });
      }
    } else if (
      node.type === "variable_declarator" ||
      node.type === "public_field_definition" ||
      node.type === "field_definition"
    ) {
      const nameNode = node.childForFieldName("name") ?? node.childForFieldName("property");
      const valueNode = node.childForFieldName("value");
      if (nameNode && valueNode) {
        if (valueNode.type === "string") {
          const name = sliceText(nameNode, source);
          const value = unquote(sliceText(valueNode, source));
          constStringOf.set(name, value);
        }
        const valueType = String(valueNode.type || "");
        if (/arrow_function|function/.test(valueType)) {
          const name = sliceText(nameNode, source);
          const def = findDefinition(name, nameNode);
          if (def) functionNodes.push({ name, node: valueNode, def });
        }
      }
    } else if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left && right) {
        const valueType = String(right.type || "");
        if (/arrow_function|function/.test(valueType)) {
          let name: string | null = null;
          if (left.type === memberExpressionType) {
            const { property: prop } = getMemberAccessParts(sup, left);
            if (prop && propertyIdentifierTypes.includes(prop.type)) name = sliceText(prop, source);
          } else if (left.type === "identifier") {
            name = sliceText(left, source);
          }
          if (name) {
            const def = findDefinition(name, left);
            if (def) functionNodes.push({ name, node: right, def });
          }
        }
      }
    } else if (sup.id === "ruby" && node.type === "assignment") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const receiver = right?.childForFieldName("receiver");
      const method = right?.childForFieldName("method");
      if (
        left?.type === "constant" &&
        right?.type === "call" &&
        receiver?.text === "Struct" &&
        method?.text === "new"
      ) {
        const name = sliceText(left, source);
        const def = findDefinition(name, left);
        if (def) classNodes.push({ name, node, def });
      }
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(rootNode);
  return { functionNodes, classNodes, constStringOf };
}

export function findFirstNodeByType(node: SyntaxNodeLike, type: string): SyntaxNodeLike | null {
  for (const child of node.namedChildren ?? []) {
    if (child.type === type) return child;
    const found = findFirstNodeByType(child, type);
    if (found) return found;
  }
  return null;
}
/**
 * Parameter-list nodes shared by receiver classification and declaration arity. The union keeps
 * Kotlin `function_value_parameters` and Ruby `block_parameters` recognized; declaration arity
 * excludes the block and lambda forms because they belong to nested scopes.
 */
export const PARAMETER_LIST_NODE_TYPES: Record<string, true> = {
  block_parameters: true,
  formal_parameters: true,
  function_parameter_clause: true,
  function_value_parameters: true,
  lambda_parameters: true,
  method_parameters: true,
  parameter_list: true,
  parameters: true,
};

/**
 * Positional parameter count of a member/function declaration node, or undefined when the node
 * declares no parameter list. Swift exposes parameters as direct declaration children, so its
 * language id is required to distinguish a zero-parameter declaration from an unknown shape.
 * Shared by the receiver-call edge pass and keyword receiver navigation so overload selection
 * uses one arity scanner.
 */
export function declarationMemberArity(declarationNode: SyntaxNodeLike, languageId?: string): number | undefined {
  let parameters = declarationNode.childForFieldName("parameters");
  if (!parameters) {
    for (const type of Object.keys(PARAMETER_LIST_NODE_TYPES)) {
      if (type === "block_parameters" || type === "lambda_parameters") continue;
      parameters = findFirstNodeByType(declarationNode, type);
      if (parameters) break;
    }
  }
  if (!parameters) {
    if (languageId !== "swift") return undefined;
    return (declarationNode.namedChildren ?? []).filter((child) => child.type === "parameter").length;
  }
  return (parameters.namedChildren ?? []).filter((child) => child.type !== "comment").length;
}

export function collectNodesByType(node: SyntaxNodeLike, type: string, out: SyntaxNodeLike[]): void {
  for (const child of node.namedChildren ?? []) {
    if (child.type === type) out.push(child);
    collectNodesByType(child, type, out);
  }
}

export function scanForAliasUse(
  node: SyntaxNodeLike,
  sup: LanguageSupport,
  source: string,
  cb: (name: string, atNode: SyntaxNodeLike) => void,
): void {
  if (isIdentifierType(sup, node.type)) {
    const name = sliceText(node, source);
    cb(name, node);
  }
  for (const child of node.namedChildren) scanForAliasUse(child, sup, source, cb);
}
