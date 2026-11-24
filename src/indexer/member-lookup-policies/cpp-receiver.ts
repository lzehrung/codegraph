import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import type { CppOutOfLineMemberDeclaration } from "./receiver-operation-types.js";
import type { OwnerHooks, ReceiverSyntaxDeps } from "./types.js";

/** Exact namespace/type path qualifying an out-of-line C++ definition. */
export function cppOutOfLineOwnerPath(
  node: SyntaxNodeLike,
  source: string,
  support: LanguageSupport,
  deps: ReceiverSyntaxDeps,
): string[] | null {
  if (support.id !== "cpp") return null;
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "function_definition") {
      let declarator = current.childForFieldName("declarator");
      while (declarator) {
        if (declarator.type === "qualified_identifier") {
          const path = deps.qualifiedNameSegments(declarator, source);
          path.pop();
          if (!sliceText(declarator, source).trimStart().startsWith("::")) {
            const namespaces: string[][] = [];
            let parent = current.parent;
            while (parent) {
              if (parent.type === "namespace_definition") {
                const name = parent.childForFieldName("name");
                if (name) namespaces.push(deps.qualifiedNameSegments(name, source));
              }
              parent = parent.parent;
            }
            for (const namespace of namespaces.reverse()) path.unshift(...namespace);
          }
          return path.length ? path : null;
        }
        const nested = declarator.childForFieldName("declarator") ?? declarator.namedChildren.at(-1);
        if (!nested || nested.id === declarator.id) break;
        declarator = nested;
      }
      return null;
    }
    current = current.parent;
  }
  return null;
}

function declaratorName(node: SyntaxNodeLike, sup: LanguageSupport, deps: ReceiverSyntaxDeps): SyntaxNodeLike | null {
  const functionDeclarator =
    node.type === "function_declarator" ? node : deps.findFirstNodeByType(node, "function_declarator");
  let current = functionDeclarator?.childForFieldName("declarator") ?? null;
  while (current) {
    if (
      deps.isIdentifierType(sup, current.type) ||
      current.type === "operator_name" ||
      current.type === "destructor_name"
    )
      return current;
    let name = current.childForFieldName("name");
    while (name?.childForFieldName("name")) name = name.childForFieldName("name");
    if (
      name &&
      (deps.isIdentifierType(sup, name.type) || name.type === "operator_name" || name.type === "destructor_name")
    )
      return name;
    const nested = current.childForFieldName("declarator");
    if (!nested || nested.id === current.id) return null;
    current = nested;
  }
  return null;
}

/** Unqualified name declared by an out-of-line C++ definition. */
export function cppOutOfLineMemberName(
  node: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  deps: ReceiverSyntaxDeps,
): string | null {
  if (sup.id !== "cpp") return null;
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "function_definition") {
      const name = declaratorName(current, sup, deps);
      return name ? sliceText(name, source) : null;
    }
    current = current.parent;
  }
  return null;
}

function memberArity(node: SyntaxNodeLike, deps: ReceiverSyntaxDeps): number | undefined {
  for (let current: SyntaxNodeLike | null = node; current; current = current.parent) {
    const arity = deps.declarationMemberArity(current, "cpp");
    if (arity !== undefined) return arity;
  }
  return undefined;
}

function collectDeclarations(
  node: SyntaxNodeLike,
  owner: SyntaxNodeLike,
  localName: string,
  source: string,
  sup: LanguageSupport,
  expectedArity: number | undefined,
  out: CppOutOfLineMemberDeclaration[],
  deps: ReceiverSyntaxDeps,
): void {
  const memberDeclaration = node.type === "field_declaration" || node.type === "declaration";
  if (memberDeclaration && deps.sameSyntaxNode(deps.nearestMemberContainer(node), owner)) {
    const nameNode = declaratorName(node, sup, deps);
    if (!nameNode) return;
    if (sup.normalizeIdentifier(sliceText(nameNode, source)) !== sup.normalizeIdentifier(localName)) return;
    if (deps.declarationMemberArity(node, sup.id) !== expectedArity) return;
    out.push({ node, nameNode });
    return;
  }
  for (const child of node.namedChildren)
    collectDeclarations(child, owner, localName, source, sup, expectedArity, out, deps);
}

/** Unique in-class declaration with the out-of-line definition's name and arity. */
export function cppOutOfLineMemberDeclarationNode(
  definitionName: SyntaxNodeLike,
  localName: string,
  ownerName: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  deps: ReceiverSyntaxDeps,
): CppOutOfLineMemberDeclaration | null {
  if (sup.id !== "cpp") return null;
  const owner = deps.nearestMemberContainer(ownerName);
  if (!owner) return null;
  const arity = memberArity(definitionName, deps);
  const declarations: CppOutOfLineMemberDeclaration[] = [];
  collectDeclarations(owner, owner, localName, source, sup, arity, declarations, deps);
  return declarations.length === 1 ? declarations[0]! : null;
}

export const cppQualifiedOwner: NonNullable<OwnerHooks["qualified"]> = (
  index,
  mod,
  baseName,
  path,
  _normalize,
  _sup,
  _use,
  deps,
) => deps.resolveQualifiedCppOwner(index, mod, [baseName, ...path]);
