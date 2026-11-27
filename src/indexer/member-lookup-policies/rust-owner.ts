/**
 * Rust receiver members: the methods of every `impl` block whose self type is the receiver type, then the provided
 * methods of the traits those blocks implement. This module imports no navigation module: those import the policy
 * registry, so the helpers it needs arrive as `deps`.
 */
import { rustImplSelfTypeNode } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { fileIdentityKey } from "../../util/paths.js";
import { selectMember, type MemberModel } from "../member-selection.js";
import { definitionIdentityKey } from "../reference-context.js";
import type { SymbolDef } from "../types.js";
import type { OwnerHooks } from "./types.js";

/**
 * Every Rust `impl` block whose self type is `typeName`, across inherent (`impl Circle`),
 * trait (`impl Shape for Circle`), and generic (`impl<T> Box<T>`) forms. The shared
 * self-type extraction keeps navigation and detailed-graph member ownership in agreement.
 */
function findRustImplsForType(
  root: SyntaxNodeLike,
  typeName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike[] {
  const normalized = sup.normalizeIdentifier(typeName);
  const found: SyntaxNodeLike[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "impl_item") {
      const selfType = rustImplSelfTypeNode(node, sup);
      if (selfType && sup.normalizeIdentifier(sliceText(selfType, source)) === normalized) found.push(node);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return found;
}

/** The method `member` of the Rust type `receiverDef`: an inherent method, then an implemented trait's own. */
export const selectRustReceiverMember: NonNullable<OwnerHooks["receiverMembers"]> = async (
  index,
  receiverDef,
  member,
  context,
  locals,
  _normalizeIdentifier,
  knownArgumentCount,
  deps,
) => {
  const inherent: SymbolDef[] = [];
  const implemented: SymbolDef[] = [];
  const traitMembers = new Map<string, SymbolDef[]>();
  const traitOwners: string[] = [];
  const module = index.byFile.get(fileIdentityKey(receiverDef.file));
  if (!module) return undefined;
  for (const impl of findRustImplsForType(context.tree.rootNode, receiverDef.localName, context.source, context.sup)) {
    const self = rustImplSelfTypeNode(impl, context.sup);
    const trait = impl.namedChildren.find((child) => child.type === "type_identifier" && child.id !== self?.id);
    const target = trait ? implemented : inherent;
    deps.appendDirectKeywordMembers(locals, member, impl, context, context.sup.normalizeIdentifier, undefined, target);
    if (!trait) continue;
    const traitName = sliceText(trait, context.source);
    const traitDef = deps.resolveTypeContainer(index, module, traitName, context.sup.normalizeIdentifier);
    if (!traitDef) continue;
    const ref = await deps.keywordClassRefFromDef(index, traitDef);
    if (!ref || ref.container.type !== "trait_item") continue;
    const key = definitionIdentityKey(traitDef);
    if (traitMembers.has(key)) continue;
    const matches: SymbolDef[] = [];
    deps.appendDirectKeywordMembers(
      ref.module.locals,
      member,
      ref.container,
      ref.context,
      ref.context.sup.normalizeIdentifier,
      undefined,
      matches,
    );
    traitMembers.set(key, matches);
    traitOwners.push(key);
  }
  const model: MemberModel<string, SymbolDef> = {
    ownerKey: (owner) => owner,
    members: (owner) => {
      if (owner === "inherent") return inherent;
      if (owner === "implemented") return implemented;
      return traitMembers.get(owner) ?? [];
    },
    supertypes: (owner) => {
      if (owner === "type") return ["inherent"];
      if (owner === "inherent") return ["implemented"];
      return owner === "implemented" ? traitOwners : [];
    },
    name: (def) => context.sup.normalizeIdentifier(def.localName),
    key: (def) => def.callable?.key ?? definitionIdentityKey(def),
    callable: (def) => def.callable,
    scope: () => "any",
    visible: () => true,
  };
  const selected = selectMember(["type"], model, {
    name: context.sup.normalizeIdentifier(member),
    argumentCount: knownArgumentCount ?? null,
    scope: "any",
    useFile: receiverDef.file,
    keepUniqueArityMismatch: true,
  });
  return selected.status === "unique" ? selected.member : undefined;
};
