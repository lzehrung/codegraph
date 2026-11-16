/**
 * Ruby additions to the shared name lookup order. Every class and module of a file shares the file scope, so scope
 * alone would bind a bare name to a method of an unrelated type, and a local that the scope index does not model would
 * bind to a method of its name. The policy keeps a method to the types that can call it and a local to its own scope.
 */
import { fileIdentityKey } from "../../util/paths.js";
import {
  rubyDeclaresLocalVariable,
  rubyIsBlockTypeMethod,
  rubyMayBuildTypesWithBlocks,
  rubyMethodIsOwnedAt,
  rubyMethodVisibleAt,
  rubyNamesLocalVariable,
  rubyReadsLocalAsOperand,
} from "../../util/ruby-tree.js";
import { definitionForBinding } from "../navigation-local.js";
import { okGoToResult } from "../navigation-provenance.js";
import { scopeIdentifierKey, scopeNodesFor } from "../scope-nodes.js";
import { SymbolKind, type GoToResult, type SymbolDef } from "../types.js";
import type { BareNameUse, NameLookupPolicy, NameLookupState, NameResolution } from "../name-resolution-types.js";
import type { Binding } from "../scope-types.js";

const UNMODELED_LOCAL_REASON = "A Ruby local variable that the scope index does not bind";

/**
 * When an earlier `def` is replaced by a later `attr_*`, that `def`'s own declaration token still names itself, never
 * the later accessor.
 */
function declarationNamesItself({ use, closestBinding }: NameLookupState): GoToResult | undefined {
  if (!use.scopeIndex.hasGeneratedMembers || !closestBinding?.generatedOwner) return undefined;
  const { node, file } = use;
  for (
    let binding: Binding | undefined = closestBinding.earlierSameScope;
    binding;
    binding = binding.earlierSameScope
  ) {
    if (binding.generatedOwner) continue;
    if (binding.node?.startIndex !== node.startIndex || binding.node.endIndex !== node.endIndex) continue;
    const def = use.mod.locals.find(
      (local) =>
        fileIdentityKey(local.file) === fileIdentityKey(file) &&
        local.range.start.index === node.startIndex &&
        local.range.end.index === node.endIndex,
    );
    return def ? okGoToResult(use.index, def, { resolution: "exact", confidence: "high" }) : undefined;
  }
  return undefined;
}

/**
 * A name the syntax binds as a local variable (a multiple assignment, a pattern, a rescue variable, a lambda parameter)
 * is that local, never a method of the same spelling. The scope index models only some of these, and a local it holds
 * is answered by the shared lookup.
 */
function unmodeledLocal({ use, closestBinding }: NameLookupState): NameResolution | undefined {
  if (closestBinding?.kind === "local" || closestBinding?.kind === "param") return undefined;
  if (!rubyNamesLocalVariable(use.node)) return undefined;
  return { status: "not_found", reason: UNMODELED_LOCAL_REASON };
}

/**
 * A method that the type around the use declares itself names it, before a method of a base, a mixin, or an includer
 * that the file declares later: the scope lookup would take the later declaration.
 */
function ownTypeMethod({ use, closestBinding }: NameLookupState): GoToResult | undefined {
  if (closestBinding?.kind !== "function" || !closestBinding.node) return undefined;
  if (rubyMethodIsOwnedAt(closestBinding.node, use.node)) return undefined;
  const sup = use.parsed.sup;
  for (let binding = closestBinding.earlierSameScope; binding; binding = binding.earlierSameScope) {
    const declaration = binding.node;
    if (binding.kind !== "function" || !declaration || !rubyMethodIsOwnedAt(declaration, use.node)) continue;
    if (binding.generatedOwner && !sup.generatedMemberVisibleAt?.(binding.generatedOwner, use.node)) continue;
    const own = definitionForBinding(binding, use.file, use.node, sup, use.parsed.source, use.parsed.tree);
    return own ? okGoToResult(use.index, own, { resolution: "exact", confidence: "high" }) : undefined;
  }
  return undefined;
}

/** Whether a generated method (`attr_reader :name`) of this file is what the cross-module lookup found. */
function foundGeneratedMember(use: BareNameUse, lookupName: string, definition: SymbolDef): boolean {
  if (!use.scopeIndex.hasGeneratedMembers) return false;
  const sup = use.parsed.sup;
  const key = scopeIdentifierKey(scopeNodesFor(sup.id), lookupName, use.node, sup.normalizeIdentifier);
  return !!use.scopeIndex.bindings
    .get(key)
    ?.some((binding) => binding.generatedOwner && binding.def?.start.index === definition.range.start.index);
}

/**
 * A method of a type that a block builds (`Base = Struct.new(:a) { def run }`) binds in that block's scope, which no use
 * outside the block reaches, so a use in a type connected to it finds no binding. That type's method is the answer.
 */
function blockTypeMethod(use: BareNameUse, lookupName: string): GoToResult | undefined {
  if (!rubyMayBuildTypesWithBlocks(use.parsed.tree.rootNode)) return undefined;
  let found: SymbolDef | undefined;
  for (const local of use.mod.locals) {
    if (local.kind !== SymbolKind.Function || local.localName !== lookupName) continue;
    if (fileIdentityKey(local.file) !== fileIdentityKey(use.file)) continue;
    const start = local.range.start.index;
    const end = local.range.end.index;
    if (start === undefined || end === undefined) continue;
    const declaration = use.parsed.tree.rootNode.descendantForIndex(start, end);
    if (rubyIsBlockTypeMethod(declaration) && rubyMethodVisibleAt(declaration, use.node)) found = local;
  }
  return found ? okGoToResult(use.index, found, { resolution: "exact", confidence: "high" }) : undefined;
}

export const rubyLookupPolicy: NameLookupPolicy = {
  fromClosestBinding(state) {
    return declarationNamesItself(state) ?? unmodeledLocal(state) ?? ownTypeMethod(state);
  },
  onUnboundLocal({ use, lookupName }) {
    return blockTypeMethod(use, lookupName);
  },
  /**
   * The same-file fallback below the scope lookup binds a name by its spelling alone, so it must not answer where the
   * scope lookup refused: a generated or declared method of a type that cannot call it, or a local variable, which only
   * the scope it is bound in can name.
   */
  afterCrossModule({ use, lookupName }, resolved) {
    if (resolved?.status !== "ok") return undefined;
    const { definition } = resolved;
    if (fileIdentityKey(definition.file) !== fileIdentityKey(use.file)) return undefined;
    if (foundGeneratedMember(use, lookupName, definition)) return null;
    const start = definition.range.start.index;
    const end = definition.range.end.index;
    if (start === undefined || end === undefined) return undefined;
    const declaration = use.parsed.tree.rootNode.descendantForIndex(start, end);
    if (definition.kind === SymbolKind.Variable) {
      if (!rubyDeclaresLocalVariable(declaration)) return undefined;
      // `c0&mask` is a read of the local `c0` that the parser took for a call, so the local is the answer.
      return rubyReadsLocalAsOperand(use.node, declaration, use.parsed.source) ? undefined : null;
    }
    if (definition.kind === SymbolKind.Function && !rubyMethodVisibleAt(declaration, use.node)) return null;
    return undefined;
  },
};
