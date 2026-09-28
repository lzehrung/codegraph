import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { SymbolDef } from "../../indexer/types.js";
import { sliceText, unquote } from "../../util/ast.js";
import { isJsTsLanguage } from "../../languages/js-family.js";
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
const FUNCTION_EXPRESSION_TYPES = new Set(["function_expression", "function", "generator_function"]);

/**
 * A named JavaScript/TypeScript function expression that no binding names: an object property
 * value (`{ value: function render() {} }`), a callback, or an IIFE. It is a caller in its own
 * right. A function expression that a declarator or assignment binds is recorded under that name.
 */
function isStandaloneNamedFunctionExpression(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  if (!isJsTsLanguage(sup.id) || !FUNCTION_EXPRESSION_TYPES.has(node.type) || !node.childForFieldName("name")) {
    return false;
  }
  const parent = node.parent;
  if (parent?.type === "variable_declarator" && parent.childForFieldName("value")?.id === node.id) return false;
  return !(parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id);
}

function functionNameNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const named = node.childForFieldName("name");
  if (named) return named;
  let current = node.childForFieldName("declarator");
  while (current) {
    if (FUNCTION_NAME_NODE_TYPES.has(current.type)) return current;
    let name = current.childForFieldName("name");
    while (name?.childForFieldName("name")) name = name.childForFieldName("name");
    if (name && FUNCTION_NAME_NODE_TYPES.has(name.type)) return name;
    const nested =
      current.childForFieldName("declarator") ??
      current.namedChildren.find((child) => child.type.includes("declarator")) ??
      null;
    if (nested && nested.id !== current.id) {
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
    "generator_function_declaration",
    "function_definition",
    "method_declaration",
    "method_definition",
    "method_signature",
    "abstract_method_signature",
    "function_signature",
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
    "object_declaration",
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

  /** A definition whose name starts inside `nameNode`, without falling back to a same-named one. */
  const findDefinitionAt = (name: string, nameNode: SyntaxNodeLike): SymbolDef | undefined =>
    locals.find(
      (local) =>
        local.localName === name &&
        (local.range.start.index ?? Number.NEGATIVE_INFINITY) >= nameNode.startIndex &&
        (local.range.start.index ?? Number.POSITIVE_INFINITY) < nameNode.endIndex,
    );

  const walk = (node: SyntaxNodeLike): void => {
    if (functionNodeTypes.has(node.type) || isStandaloneNamedFunctionExpression(sup, node)) {
      const nameNode = functionNameNode(node);
      const name = nameNode ? sliceText(nameNode, source) : undefined;
      if (name) {
        const def = findDefinition(name, nameNode!);
        if (def) functionNodes.push({ name, node, def });
      }
    } else if (
      typeNodeTypes.has(node.type) ||
      ((sup.id === "ts" || sup.id === "tsx") &&
        node.type === "type_alias_declaration" &&
        node.childForFieldName("value")?.type === "object_type")
    ) {
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
          // A member target (`exports.handler = function () {}`) binds only a definition declared at
          // that assignment; a same-named declaration elsewhere in the file is a different symbol.
          let def: SymbolDef | undefined;
          if (name)
            def =
              left.type === memberExpressionType
                ? (findDefinitionAt(name, left) ?? findDefinitionAt(name, right))
                : findDefinition(name, left);
          if (name && def) {
            functionNodes.push({ name, node: right, def });
          } else {
            // Otherwise a named function expression is the caller under its own name.
            const ownName = FUNCTION_EXPRESSION_TYPES.has(right.type) ? right.childForFieldName("name") : null;
            const ownDef = ownName ? findDefinitionAt(sliceText(ownName, source), ownName) : undefined;
            if (ownName && ownDef) functionNodes.push({ name: sliceText(ownName, source), node: right, def: ownDef });
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
 * C/C++ trailing parameter-list markers that accept zero or more arguments and so are not fixed
 * positional parameters. tree-sitter-c spells a bare `...` as a named `variadic_parameter`;
 * tree-sitter-cpp spells a parameter pack `T... name` as `variadic_parameter_declaration` (its
 * bare `...` is an unnamed token the parser already omits from the named children). Go's
 * `variadic_parameter_declaration` shares the C++ name but is a different language's rest form,
 * so callers gate on the C/C++ language ids.
 */
const VARIADIC_PARAMETER_MARKER_TYPES: Record<string, true> = {
  variadic_parameter: true,
  variadic_parameter_declaration: true,
};

/** Whether a parameter node is a C/C++ variadic marker rather than a fixed positional parameter. */
export function isVariadicParameterMarker(node: SyntaxNodeLike): boolean {
  return !!VARIADIC_PARAMETER_MARKER_TYPES[node.type];
}

/**
 * Positional parameter count of a member/function declaration node, or undefined when the node
 * declares no parameter list. Swift exposes parameters as direct declaration children, so its
 * language id is required to distinguish a zero-parameter declaration from an unknown shape.
 * Used for public declaration metadata and C++ declaration correspondence, never to establish
 * accepted call ranges. Receiver call selection uses the shared callable ranges instead.
 *
 * The count is the number of *required-or-defaulted* fixed parameters; C/C++ variadic markers are
 * excluded because they accept zero arguments, while each language's own maximum-arity handling
 * keeps their upper bound unbounded.
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
  let positionalParameters = (parameters.namedChildren ?? []).filter((child) => child.type !== "comment");
  if (languageId === "c" || languageId === "cpp") {
    positionalParameters = positionalParameters.filter((child) => !isVariadicParameterMarker(child));
  }
  if (languageId === "kotlin") {
    // kotlin-ng keeps default values as bare `expression` siblings and `vararg` as
    // `parameter_modifiers` beside the parameter they modify; only `parameter`
    // nodes occupy positional argument slots.
    positionalParameters = positionalParameters.filter((child) => child.type === "parameter");
  }
  if (languageId === "java") {
    // An explicit receiver parameter (`Box this`) is not a call argument.
    positionalParameters = positionalParameters.filter((child) => child.type !== "receiver_parameter");
  }
  if ((languageId === "c" || languageId === "cpp") && positionalParameters.length === 1) {
    const parameterParts = positionalParameters[0]!.namedChildren.filter((child) => child.type !== "comment");
    if (
      parameterParts.length === 1 &&
      parameterParts[0]?.type === "primitive_type" &&
      parameterParts[0].text === "void"
    ) {
      return 0;
    }
  }
  return positionalParameters.length;
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
