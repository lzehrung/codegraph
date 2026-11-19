import type { SyntaxNodeLike } from "../languages/types.js";

function sameNode(left: SyntaxNodeLike | null | undefined, right: SyntaxNodeLike): boolean {
  return !!left && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

function containsNode(outer: SyntaxNodeLike | null, inner: SyntaxNodeLike): boolean {
  return !!outer && outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/** Out and pattern variables in a field or property initializer belong only to that initializer. */
export function isCsharpMemberInitializer(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (parent?.type === "property_declaration") {
    const value = parent.childForFieldName("value");
    return !!value && value.startIndex === node.startIndex && value.endIndex === node.endIndex;
  }
  if (parent?.type !== "variable_declarator" || parent.parent?.type !== "variable_declaration") return false;
  const declaration = parent.parent.parent;
  if (declaration?.type !== "field_declaration" && declaration?.type !== "event_field_declaration") return false;
  const initializer = parent.namedChildren[1];
  return !!initializer && initializer.startIndex === node.startIndex && initializer.endIndex === node.endIndex;
}

/** Whether a declaration lies in the first source or a join's inner source. */
function isCsharpQueryOuterSource(name: SyntaxNodeLike, scope: SyntaxNodeLike): boolean {
  let sawFrom = false;
  for (const clause of scope.namedChildren) {
    if (clause.type === "from_clause") {
      if (sawFrom) continue;
      sawFrom = true;
    } else if (clause.type !== "join_clause") {
      continue;
    }
    if (name.startIndex < clause.startIndex || name.endIndex > clause.endIndex) continue;
    let sourceStart: number | undefined;
    let sourceEnd = clause.endIndex;
    for (let index = 0; ; index += 1) {
      const child = clause.child(index);
      if (!child) break;
      if (child.type === "in") sourceStart = child.endIndex;
      if (clause.type === "join_clause" && child.type === "on") {
        sourceEnd = child.startIndex;
        break;
      }
    }
    return sourceStart !== undefined && name.startIndex >= sourceStart && name.endIndex <= sourceEnd;
  }
  return false;
}

/** A query's first source and each join's inner source evaluate in the enclosing scope. */
export function csharpDeclarationOutsideQuery(name: SyntaxNodeLike, scope: SyntaxNodeLike): boolean {
  if (scope.type !== "query_expression") return false;
  const declarationType = name.parent?.type;
  if (declarationType !== "declaration_expression" && declarationType !== "declaration_pattern") return false;
  if (isCsharpMemberInitializer(scope)) return false;
  return isCsharpQueryOuterSource(name, scope);
}

/** Other query expressions are lambda bodies; declarations in one do not reach another clause. */
function csharpQueryExpressionBindingVisibleAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const type = declaration.parent?.type;
  if (type !== "declaration_expression" && type !== "declaration_pattern") return true;
  let child: SyntaxNodeLike = declaration;
  for (let parent = child.parent; parent; parent = parent.parent) {
    if (parent.type === "lambda_expression" || parent.type === "block") return true;
    if (parent.parent?.type === "query_expression" && !isCsharpQueryOuterSource(declaration, parent.parent)) {
      return use.startIndex >= child.startIndex && use.endIndex <= child.endIndex;
    }
    child = parent;
  }
  return true;
}

/** Multiplication in an argument is parsed as a pointer declaration by the C# grammar. */
export function isCsharpPointerExpression(node: SyntaxNodeLike): boolean {
  const declaration = node.type === "declaration_expression" ? node : node.parent;
  if (declaration?.type !== "declaration_expression") return false;
  if (declaration.childForFieldName("type")?.type !== "pointer_type") return false;
  const argument = declaration.parent;
  if (argument?.type === "argument") {
    let hasOut = false;
    for (let i = 0; ; i += 1) {
      const child = argument.child(i);
      if (!child) break;
      if (child.type === "out") hasOut = true;
    }
    if (!hasOut) return true;
  }
  for (let current: SyntaxNodeLike | null = declaration; current; current = current.parent) {
    if (current.type === "unsafe_statement") return false;
    if (current.namedChildren.some((child) => child.type === "modifier" && child.text === "unsafe")) return false;
  }
  return true;
}

/** The declaration token of a query range variable, including query continuations. */
export function isCsharpQueryVariable(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (!parent || node.type !== "identifier") return false;
  if (parent.type === "query_expression") return true;
  if (parent.type === "from_clause") return sameNode(parent.childForFieldName("name"), node);
  if (parent.type === "let_clause" || parent.type === "join_clause" || parent.type === "join_into_clause") {
    const type = parent.childForFieldName("type");
    const name = parent.namedChildren.find((child) => child.type === "identifier" && !sameNode(type, child));
    return sameNode(name, node);
  }
  return false;
}

/**
 * Query bindings respect source-expression and range-variable visibility boundaries.
 * Keep `conditionalBindingParents` in the C# scope row in step with the declaration forms this can hide.
 */
export function csharpQueryBindingVisibleAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (sameNode(declaration, use)) return true;
  for (let loop = declaration.parent; loop; loop = loop.parent) {
    if (loop.type !== "foreach_statement") continue;
    if (!containsNode(loop.childForFieldName("right"), use)) break;
    if (containsNode(loop.childForFieldName("left"), declaration)) return false;
    const body = loop.childForFieldName("body");
    if (body?.type !== "block" && containsNode(body, declaration)) return false;
    break;
  }
  if (!isCsharpQueryVariable(declaration)) return csharpQueryExpressionBindingVisibleAt(declaration, use);
  const clause = declaration.parent!;
  const join = clause.type === "join_into_clause" ? clause.parent : clause;
  const query = join?.type === "query_expression" ? join : join?.parent;
  if (!join || query?.type !== "query_expression") return false;
  if (use.startIndex < declaration.endIndex || use.endIndex > query.endIndex) return false;
  if (clause.type === "join_clause") {
    let equalsEnd: number | undefined;
    for (let i = 0; ; i += 1) {
      const child = clause.child(i);
      if (!child) break;
      if (child.type === "equals") equalsEnd = child.endIndex;
    }
    if (equalsEnd === undefined || use.startIndex < equalsEnd) return false;
    const into = clause.namedChildren.find((child) => child.type === "join_into_clause");
    if (into && use.startIndex >= into.startIndex) return false;
  } else if (clause.type !== "query_expression" && use.startIndex < join.endIndex) {
    return false;
  }
  for (const child of query.namedChildren) {
    if (child.type !== "identifier") continue;
    if (child.startIndex > declaration.startIndex && child.endIndex <= use.startIndex) return false;
  }
  return true;
}
