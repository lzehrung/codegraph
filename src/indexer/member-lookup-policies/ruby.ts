/** Ruby methods and generated accessors never name the local variables stored beside them. */
import {
  rubyReadsLocalAsOperand,
  rubyDeclaresLocalVariable,
  rubyMethodIsPendingAt,
  rubyMethodNameLiteral,
  rubyMethodNameOwner,
  rubyMethodNameMayReferTo,
  rubyReferenceFamilyUnproven,
  rubyTypeNameMayReach,
  rubyTypeNameCalls,
  rubyUnplacedSelfCallMayReach,
} from "../../util/ruby-tree.js";
import {
  AMBIGUOUS_RECEIVER_MEMBER_REASON,
  UNPROVEN_RUBY_CLASS_BODY_METHOD_REASON,
  UNPROVEN_RUBY_SELF_METHOD_REASON,
} from "../ambiguous-resolution.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { ParsedFileContext } from "../parse-context.js";
import { SymbolKind, type SymbolDef } from "../types.js";
import type { MemberAccessRules, MemberLookupPolicy, MemberWalkRules } from "./types.js";
import { rubyQualifiedOwner } from "./ruby-owner.js";

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

/**
 * A call through a type's name (`Config.build`) runs the last class method of that name the type declares, as a later
 * `def` replaces an earlier one, or else its last instance method, which `module_function` or `extend self` may hand to
 * the type; a local variable of the type's body or of one of its methods is no member. A call in the same file that
 * runs while the type body loads sees only the definitions before it.
 */
function typeNameMembers(
  candidates: readonly SymbolDef[],
  context: ParsedFileContext,
  sameFileUse: SyntaxNodeLike | undefined,
): readonly SymbolDef[] {
  if (candidates.length < 2) return candidates;
  let last: SymbolDef | undefined;
  let lastStart = -1;
  let lastClassMethod: SymbolDef | undefined;
  let lastClassMethodStart = -1;
  for (const candidate of candidates) {
    if (candidate.kind !== SymbolKind.Function) continue;
    const start = candidate.range.start.index;
    const end = candidate.range.end.index;
    if (start === undefined || end === undefined) return candidates;
    const declaration = context.tree.rootNode.descendantForIndex(start, end);
    if (sameFileUse && rubyMethodIsPendingAt(declaration, sameFileUse)) continue;
    if (start > lastStart) {
      last = candidate;
      lastStart = start;
    }
    if (start > lastClassMethodStart && rubyTypeNameCalls(declaration)) {
      lastClassMethod = candidate;
      lastClassMethodStart = start;
    }
  }
  const selected = lastClassMethod ?? last;
  return selected ? [selected] : candidates;
}

export const rubyMemberLookupPolicy: MemberLookupPolicy = {
  separateMemberScopes: true,
  selection: { firstDeclarationWins: true },
  ownerResolution: { lookup: { hierarchy: true }, qualified: rubyQualifiedOwner },
  typeNameMembers,
  typeNameMayReachFileMember: rubyTypeNameMayReach,
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
    // A call that no method of its own type proves may still run a top-level method, or one of a base or mixin.
    const unplacedSelfCall =
      reason === UNPROVEN_RUBY_CLASS_BODY_METHOD_REASON || reason === UNPROVEN_RUBY_SELF_METHOD_REASON;
    if (unplacedSelfCall) return rubyUnplacedSelfCallMayReach(declaration, node);
    const call = node.parent;
    if (call?.type !== "call" || call.childForFieldName("method")?.id !== node.id) return false;
    return !!call.childForFieldName("receiver");
  },
};
