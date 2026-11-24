import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { normalizeCsharpIdentifier } from "./identifiers.js";

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
 * Query and switch-label bindings respect their syntax visibility boundaries.
 * Keep `conditionalBindingParents` in the C# scope row in step with the declaration forms this can hide.
 */
export function csharpBindingVisibleAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (sameNode(declaration, use)) return true;
  let child = declaration;
  const parent = declaration.parent;
  const declarationType = parent?.type;
  let possibleSwitchLabel = declarationType === "declaration_pattern" || declarationType === "declaration_expression";
  for (let loop = parent; loop; child = loop, loop = loop.parent) {
    if (possibleSwitchLabel) {
      if (loop.type === "block" || loop.type === "lambda_expression") {
        possibleSwitchLabel = false;
      } else if (loop.type === "switch_section") {
        const isLabel = child.type === "when_clause" || child.type.endsWith("_pattern");
        if (isLabel && !containsNode(loop, use)) return false;
        possibleSwitchLabel = false;
      }
    }
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

/** The names a deconstruction `var (X, (Y, _)) = ...` declares. */
function deconstructedNames(pattern: SyntaxNodeLike, out: SyntaxNodeLike[]): void {
  for (const child of pattern.namedChildren) {
    if (child.type === "identifier") out.push(child);
    else if (child.type === "tuple_pattern") deconstructedNames(child, out);
  }
}

function spells(name: SyntaxNodeLike, wanted: string): boolean {
  return normalizeCsharpIdentifier(name.text) === wanted;
}

/** The names the deconstructions of one local declaration statement declare (`var (X, Z) = ...;`). */
function deconstructedNamesOf(statement: SyntaxNodeLike): SyntaxNodeLike[] {
  const names: SyntaxNodeLike[] = [];
  for (const declaration of statement.namedChildren) {
    for (const declarator of declaration.namedChildren) {
      const pattern = declarator.namedChildren.find((child) => child.type === "tuple_pattern");
      if (pattern) deconstructedNames(pattern, names);
    }
  }
  return names;
}

/** One deconstructed name in a block: where the first statement declaring it ends, and its declaring tokens. */
type BlockDeconstruction = { firstEnd: number; tokens: Map<number, number> };

/** The deconstructed locals of a block's statements by normalized name, read once per block and tree. */
const BLOCK_DECONSTRUCTIONS = new WeakMap<SyntaxTreeLike, Map<string, ReadonlyMap<string, BlockDeconstruction>>>();

function blockDeconstructions(tree: SyntaxTreeLike, scope: SyntaxNodeLike): ReadonlyMap<string, BlockDeconstruction> {
  let blocks = BLOCK_DECONSTRUCTIONS.get(tree);
  if (!blocks) {
    blocks = new Map();
    BLOCK_DECONSTRUCTIONS.set(tree, blocks);
  }
  const key = `${scope.type}:${scope.startIndex}:${scope.endIndex}`;
  const cached = blocks.get(key);
  if (cached) return cached;
  const names = new Map<string, BlockDeconstruction>();
  for (const statement of scope.namedChildren) {
    if (statement.type !== "local_declaration_statement") continue;
    for (const name of deconstructedNamesOf(statement)) {
      const normalized = normalizeCsharpIdentifier(name.text);
      let entry = names.get(normalized);
      if (!entry) {
        // Statements are read in order, so the first one declaring a name is the earliest.
        entry = { firstEnd: statement.endIndex, tokens: new Map() };
        names.set(normalized, entry);
      }
      entry.tokens.set(name.startIndex, name.endIndex);
    }
  }
  blocks.set(key, names);
  return names;
}

/** Whether `use` is a name a deconstruction of `scope` declares, or `wanted` is one an earlier statement of it declares. */
function deconstructsBefore(tree: SyntaxTreeLike, scope: SyntaxNodeLike, use: SyntaxNodeLike, wanted: string): boolean {
  const declared = blockDeconstructions(tree, scope).get(wanted);
  if (!declared) return false;
  return declared.firstEnd <= use.startIndex || declared.tokens.get(use.startIndex) === use.endIndex;
}

/** Match the actual declaration node even where its enclosing syntax shares the same range. */
function sameBindingNode(left: SyntaxNodeLike | null | undefined, right: SyntaxNodeLike): boolean {
  if (!left) return false;
  if (left.id !== undefined && right.id !== undefined) return left.id === right.id;
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

/** Whether an anonymous method (`delegate (int X) { ... }`) declares the parameter `use` names, or one `wanted` in its body. */
function anonymousMethodBinds(method: SyntaxNodeLike, use: SyntaxNodeLike, wanted: string): boolean {
  const parameters = method.childForFieldName("parameters");
  if (!parameters) return false;
  const inParameters = parameters.startIndex <= use.startIndex && use.endIndex <= parameters.endIndex;
  return parameters.namedChildren.some((parameter) => {
    const name = parameter.childForFieldName("name");
    return !!name && (sameBindingNode(name, use) || (!inParameters && spells(name, wanted)));
  });
}

/**
 * Whether a binder the scope index does not model sits between `use` and `owner` and spells `wanted`, or declares `use`
 * itself: a deconstructed local or an anonymous method parameter. It, not a parameter or member, is the binding.
 */
export function csharpShadowedByUnmodeledBinder(
  tree: SyntaxTreeLike,
  use: SyntaxNodeLike,
  owner: SyntaxNodeLike,
  wanted: string,
): boolean {
  for (let node = use.parent; node && !sameBindingNode(node, owner); node = node.parent) {
    if (node.type === "anonymous_method_expression" && anonymousMethodBinds(node, use, wanted)) return true;
    const holdsStatements = node.type === "block" || node.type === "switch_section";
    if (holdsStatements && deconstructsBefore(tree, node, use, wanted)) return true;
  }
  return false;
}

/** A declared receiver must be the closest binding, or the enclosing anonymous method's own parameter. */
export function csharpReceiverDeclaredBindingVisible(
  tree: SyntaxTreeLike,
  receiver: SyntaxNodeLike,
  declaration: SyntaxNodeLike,
  closest: SyntaxNodeLike | null,
): boolean {
  if (sameBindingNode(closest, declaration)) {
    const wanted = normalizeCsharpIdentifier(receiver.text);
    for (let owner = receiver.parent; owner; owner = owner.parent) {
      if (containsNode(owner, declaration)) {
        return !csharpShadowedByUnmodeledBinder(tree, receiver, owner, wanted);
      }
    }
    return false;
  }
  const parameter = declaration.parent;
  const parameters = parameter?.type === "parameter" ? parameter.parent : null;
  const method = parameters?.type === "parameter_list" ? parameters.parent : null;
  if (method?.type !== "anonymous_method_expression" || !containsNode(method, receiver)) return false;
  if (containsNode(parameters, receiver)) return false;
  if (closest && containsNode(method, closest)) return false;
  return !csharpShadowedByUnmodeledBinder(tree, receiver, method, normalizeCsharpIdentifier(receiver.text));
}
