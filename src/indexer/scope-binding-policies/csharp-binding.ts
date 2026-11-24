import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { csharpGenericArity, csharpTypeArgumentArity } from "../../util/csharp-tree.js";
import type { Binding, ScopeIndex } from "../scope-types.js";

/** A type name includes its syntactic arity; imports and declaration tokens keep their own binding. */
export function wrongCsharpTypeArity(binding: Binding, use: SyntaxNodeLike, arity: number): boolean {
  if (binding.import || !binding.node?.parent || binding.node.id === use.id) return false;
  if (binding.kind !== "class" && binding.kind !== "type") return false;
  const declaration = use.parent;
  const constructorName =
    declaration?.type === "constructor_declaration" || declaration?.type === "destructor_declaration";
  if (constructorName) return declaration.parent?.parent?.childForFieldName("name")?.id !== binding.node.id;
  return csharpGenericArity(binding.node.parent) !== arity;
}

/** Look through each qualified owner, checking its own type arguments. */
export function csharpQualifiedScopeBinding(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
  resolve: (index: ScopeIndex, name: string, node: SyntaxNodeLike, support: LanguageSupport) => Binding | null,
  qualifiedNameNode: (node: SyntaxNodeLike) => SyntaxNodeLike | null,
): Binding | null {
  const names = bindingName.split(".");
  const first = names.shift()!;
  let rootNode = qualifiedNameNode(currentNode) ?? currentNode;
  while (rootNode.type === "qualified_name" || rootNode.type === "alias_qualified_name") {
    const qualifier = rootNode.childForFieldName("qualifier") ?? rootNode.childForFieldName("alias");
    if (!qualifier) return null;
    rootNode = qualifier;
  }
  let owner = resolve(scopeIndex, first, rootNode, support);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    if (owner?.kind !== "class") return null;
    const body = owner.node?.parent?.childForFieldName("body");
    if (!body) return null;
    const bodyScope = scopeIndex.allScopes.find((scope) => scope.node.id === body.id);
    let nested = bodyScope?.map.get(support.normalizeIdentifier(name));
    const arity = index === names.length - 1 ? csharpTypeArgumentArity(currentNode) : 0;
    while (nested && wrongCsharpTypeArity(nested, currentNode, arity)) nested = nested.earlierSameScope;
    owner = nested ?? null;
  }
  return owner;
}
