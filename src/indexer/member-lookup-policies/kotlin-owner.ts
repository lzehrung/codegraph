import { kotlinExtensionReceiverTypeNode } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { selectMember } from "../member-selection.js";
import type { ParsedFileContext } from "../parse-context.js";
import { findLocalsWithinNode } from "../shared.js";
import type { SymbolDef } from "../types.js";
import type { OwnerHooks } from "./types.js";

/** Members of Any are implicit in each Kotlin type, not indexed project declarations. */
export const KOTLIN_ANY_MEMBER_ARITY: Readonly<Record<string, number>> = { equals: 1, hashCode: 0, toString: 0 };

export const kotlinOwnerSyntax: Pick<OwnerHooks, "supertypeEntry" | "implicitBase"> = {
  supertypeEntry: kotlinSupertypeEntry,
  implicitBase: { clauseType: "delegation_specifiers", members: KOTLIN_ANY_MEMBER_ARITY },
};
/**
 * Whether a Kotlin class can name its base class bare, as in `class V : Base { constructor() : super(1) }`. A class with
 * a primary constructor, or with no constructor of its own, must initialize its base class in the base list
 * (`Base(args)`), so every bare entry of such a class is an interface. Only a class that declares secondary
 * constructors and no primary constructor writes its base class bare.
 */
export function kotlinMayNameClassBare(declaration: SyntaxNodeLike): boolean {
  if (declaration.type !== "class_declaration") return false;
  if (declaration.namedChildren.some((child) => child.type === "primary_constructor")) return false;
  const body = declaration.namedChildren.find((child) => child.type === "class_body");
  return !!body?.namedChildren.some((member) => member.type === "secondary_constructor");
}

/**
 * How a Kotlin base-list entry names its supertype. A constructor call (`Base(args)`) is a class by its syntax. A bare
 * name (`Base`, or the type of `Face by delegate`) is an interface, or, in a class that may name its base class bare, a
 * class: the declaration it resolves to decides which.
 */
export type KotlinSupertypeEntry = "invoked" | "bare";

/** Kotlin base-list nodes whose direct `user_type` child is the whole supertype the entry names. */
const KOTLIN_SUPERTYPE_ENTRY_TYPES: Record<string, true> = { delegation_specifier: true, explicit_delegation: true };

/**
 * The form of the base-list entry that `identifier` names, or `null` when the identifier is not a whole type name: a
 * qualifier (`Outer` in `Outer.Inner`), a function type's parameter or return type, or a delegate expression (`d` in
 * `Face by d`) proves no supertype.
 */
export function kotlinSupertypeEntry(identifier: SyntaxNodeLike): KotlinSupertypeEntry | null {
  for (let current = identifier.parent; current && current.type !== "delegation_specifiers"; current = current.parent) {
    if (current.type === "constructor_invocation") return "invoked";
  }
  const type = identifier.parent;
  if (type?.type !== "user_type") return null;
  const qualified = type.namedChildren.filter((child) => child.type === "identifier").length > 1;
  if (qualified) return null;
  const entry = type.parent;
  if (!entry || !KOTLIN_SUPERTYPE_ENTRY_TYPES[entry.type]) return null;
  return "bare";
}

/**
 * Kotlin extension functions declared `fun Type.member()` for a receiver type, searched across the receiver type's own
 * declaring file. An ordinary class member never carries a receiver-type prefix, so this never matches a real member
 * and cannot shadow one.
 */
function kotlinExtensionFunctionsNamedOnType(
  locals: readonly SymbolDef[],
  member: string,
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef[] {
  const matches: SymbolDef[] = [];
  const normalizedType = normalizeIdentifier(typeName);
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "function_declaration") {
      const receiverType = kotlinExtensionReceiverTypeNode(node, targetContext.sup);
      if (receiverType && normalizeIdentifier(sliceText(receiverType, targetContext.source)) === normalizedType) {
        for (const local of findLocalsWithinNode(locals, member, node, normalizeIdentifier)) {
          if (!matches.includes(local)) matches.push(local);
        }
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(targetContext.tree.rootNode);
  return matches;
}

/** The extension function `member` that the file of the Kotlin type `receiverDef` declares for that type. */
export const kotlinExtensionMember: NonNullable<OwnerHooks["receiverMembers"]> = (
  index,
  receiverDef,
  member,
  context,
  locals,
  normalizeIdentifier,
  knownArgumentCount,
  deps,
) => {
  const extensionMatches = kotlinExtensionFunctionsNamedOnType(
    locals,
    member,
    receiverDef.localName,
    context,
    normalizeIdentifier,
  );
  if (!extensionMatches.length) return undefined;
  const selected = selectMember([receiverDef], deps.indexedMemberModel(index, extensionMatches, context.sup.id), {
    name: member,
    argumentCount: knownArgumentCount ?? null,
    scope: "any",
    useFile: receiverDef.file,
    keepUniqueArityMismatch: true,
  });
  return selected.status === "unique" ? selected.member : undefined;
};
