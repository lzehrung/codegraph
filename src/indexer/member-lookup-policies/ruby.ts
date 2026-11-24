/** Ruby methods and generated accessors never name the local variables stored beside them. */
import {
  rubyReadsLocalAsOperand,
  rubyDeclaresLocalVariable,
  rubyMethodNameLiteral,
  rubyMethodNameOwner,
  rubyMethodNameMayReferTo,
  rubyReferenceFamilyUnproven,
} from "../../util/ruby-tree.js";
import { AMBIGUOUS_RECEIVER_MEMBER_REASON } from "../ambiguous-resolution.js";
import { SymbolKind } from "../types.js";
import type { MemberAccessRules, MemberLookupPolicy, MemberWalkRules } from "./types.js";

const NO_OWNER_REFINEMENTS = Promise.resolve();
const NO_CONSTRAINT_BASES = Promise.resolve([]);

// Ruby needs no overload, label, extension-part, or constraint refinements to the shared hierarchy walk.
const METHOD_WALK: MemberWalkRules = {
  spansHierarchy: false,
  memberVisible: (member) => member.kind !== SymbolKind.Variable,
  afterOwnerMatches: () => NO_OWNER_REFINEMENTS,
  selectionUse: (_visible, use) => use,
  hidesInherited: () => false,
  acceptsCall: () => true,
  fitsCall: () => true,
  standInAtFirstDeclaringLevel: false,
  partsShareBases: false,
  constraintBases: () => NO_CONSTRAINT_BASES,
};
const METHOD_WALK_RESULT = Promise.resolve(METHOD_WALK);
const METHOD_ACCESS: MemberAccessRules = {
  anyScope: false,
  use: "call",
  receiverNamesNoType: false,
  missReason: undefined,
  unnameableMember: (member) => (member.kind === SymbolKind.Variable ? AMBIGUOUS_RECEIVER_MEMBER_REASON : undefined),
};

export const rubyMemberLookupPolicy: MemberLookupPolicy = {
  memberAccessRules: () => METHOD_ACCESS,
  memberWalk: () => METHOD_WALK_RESULT,
  unprovenMembersRespectReceiverProof: true,
  referenceFamilyUnproven: rubyReferenceFamilyUnproven,
  unprovenReferenceCandidate(node, declaration) {
    if (rubyMethodNameLiteral(node)) {
      if (rubyDeclaresLocalVariable(declaration) || !rubyMethodNameOwner(node)) return false;
      return rubyMethodNameMayReferTo(declaration, node);
    }
    if (!rubyDeclaresLocalVariable(declaration)) return true;
    const call = node.parent;
    const methodToken = call?.type === "call" && call.childForFieldName("method")?.id === node.id;
    return !methodToken || rubyReadsLocalAsOperand(node, declaration);
  },
  unprovenReference(node, reason, declaration) {
    if (rubyDeclaresLocalVariable(declaration)) return rubyReadsLocalAsOperand(node, declaration);
    let owner = declaration.parent;
    if (owner?.type === "setter" || owner?.type === "string") owner = owner.parent;
    const ordinaryMethod = owner?.type === "method" || owner?.type === "singleton_method";
    // A generated accessor's indexed declaration is its attr_* argument.
    const generatedMethod = owner?.type === "argument_list" && owner.parent?.type === "call";
    if (!ordinaryMethod && !generatedMethod) return false;
    if (rubyMethodNameLiteral(node)) return !!rubyMethodNameOwner(node);
    if (reason === AMBIGUOUS_RECEIVER_MEMBER_REASON) return true;
    const call = node.parent;
    if (call?.type !== "call" || call.childForFieldName("method")?.id !== node.id) return false;
    return !!call.childForFieldName("receiver");
  },
};
