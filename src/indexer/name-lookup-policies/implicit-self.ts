/**
 * Swift, C#, Java, and Kotlin additions to the shared name lookup order: inside a type, a member
 * reached through the implicit `self`/`this` (including an inherited one) is settled by the
 * member lookup, which applies static scope and overload selection, and it takes precedence over
 * a same-named module-level name or import.
 */
import {
  nearestMemberContainer,
  nodeInStaticMemberContext,
} from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import {
  csharpAliasQualifiedLookupName,
  implicitSelfCallee,
  isDirectKeywordMemberDeclaration,
} from "../navigation-goto.js";
import { csharpLookupName } from "../navigation-local.js";
import { okGoToResult } from "../navigation-provenance.js";
import type { NameLookupPolicy, NameLookupState, NameResolution } from "../name-resolution-types.js";
import type { GoToResult, SymbolDef } from "../types.js";

const implicitSelf = (state: NameLookupState, fallback: NameResolution | null): NameResolution => ({
  status: "deferred",
  request: { kind: "implicit-self-member", lookupName: state.lookupName },
  fallback,
});

const lexical = (state: NameLookupState, local: SymbolDef): GoToResult =>
  okGoToResult(state.use.index, local, { resolution: "exact", confidence: "high" });

/** The closest binding is declared in the file's top scope (module-level function or type). */
const bindsAtFileScope = ({ use, closestBinding }: NameLookupState): boolean =>
  !!closestBinding && use.scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) === closestBinding;

/**
 * The closest binding is a method declared directly in a type body. Overloads bound this way are
 * not grouped by the scope lookup, so the member lookup chooses among them; a function declared
 * inside a method body is not a member and keeps its lexical binding.
 */
function bindsTypeMethod({ closestBinding }: NameLookupState): boolean {
  const declaration = closestBinding?.kind === "function" ? closestBinding.node?.parent : undefined;
  const container = declaration ? nearestMemberContainer(declaration) : null;
  return !!declaration && !!container && isDirectKeywordMemberDeclaration(declaration, container);
}

/** The use is the callee of a receiverless call (`f()`). */
const isImplicitSelfCall = ({ use }: NameLookupState): boolean =>
  implicitSelfCallee(use.parsed.sup.id, use.node.parent ?? use.node)?.id === use.node.id;

export const swiftLookupPolicy: NameLookupPolicy = {
  // Swift checks every bare name through `self`; method-local bindings still win.
  onLocal(state, local) {
    if (!bindsAtFileScope(state) && !bindsTypeMethod(state)) return undefined;
    return implicitSelf(state, lexical(state, local));
  },
  afterCrossModule(state, resolved: GoToResult | null) {
    // A member reached only by name, not through `self`, is not a module-level target.
    const memberOnly = resolved?.status === "ok" && !!resolved.definition.isMember;
    return implicitSelf(
      state,
      memberOnly ? { status: "not_found", reason: "No matching Swift member definition" } : resolved,
    );
  },
};

export const csharpLookupPolicy: NameLookupPolicy = {
  lookupName: (use) => csharpLookupName(use.node, use.parsed.source, use.name),
  crossModuleName: ({ use, lookupName }) =>
    csharpAliasQualifiedLookupName(use.node, use.parsed.source, lookupName, use.mod.imports),
  // A static member function reaches only static members of its type.
  onLocal(state, local) {
    if (!bindsTypeMethod(state) || !isImplicitSelfCall(state)) return undefined;
    const staticContext = nodeInStaticMemberContext(state.use.node, state.use.parsed.source);
    return implicitSelf(
      state,
      staticContext
        ? { status: "not_found", reason: "No matching C# static member definition" }
        : lexical(state, local),
    );
  },
  // Partial members declared in another file reach this path only as invocation callees.
  afterCrossModule: (state, resolved) => implicitSelf(state, resolved),
};

/**
 * Java and Kotlin: a type method bound lexically still needs static-scope and overload checks,
 * and an inherited member beats a same-file top-level (Kotlin) function, a same-package
 * declaration, or an import.
 */
export const jvmLookupPolicy: NameLookupPolicy = {
  onLocal(state, local) {
    if (state.closestBinding?.kind !== "function" || !isImplicitSelfCall(state)) return undefined;
    if (!bindsAtFileScope(state) && !bindsTypeMethod(state)) return undefined;
    return implicitSelf(state, lexical(state, local));
  },
  afterCrossModule: (state, resolved) => implicitSelf(state, resolved),
};
