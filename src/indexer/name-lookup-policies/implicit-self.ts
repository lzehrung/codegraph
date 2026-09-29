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
import { csharpLookupName, definitionForBinding } from "../navigation-local.js";
import { csharpUsingStaticFiles, withCsharpUsingStatic } from "./csharp-using-static.js";
import { okGoToResult } from "../navigation-provenance.js";
import { resolveCsharpQualifiedName } from "../navigation-resolve.js";
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

/**
 * The use is the name of a same-scope overload that a later declaration replaced in the scope map
 * (`int Two(int a)` before `int Two(int a, int b)`). A declaration's own name resolves to that
 * declaration, not to the last overload.
 */
function ownOverloadDeclaration({ use, closestBinding }: NameLookupState): GoToResult | undefined {
  const { node, file, parsed } = use;
  for (let binding = closestBinding?.earlierSameScope; binding; binding = binding.earlierSameScope) {
    if (binding.node?.startIndex !== node.startIndex || binding.node.endIndex !== node.endIndex) continue;
    const own = definitionForBinding(binding, file, node, parsed.sup, parsed.source, parsed.tree);
    return own ? okGoToResult(use.index, own, { resolution: "exact", confidence: "high" }) : undefined;
  }
  return undefined;
}

/** The use is the callee of a receiverless call (`f()`). */
const isImplicitSelfCall = ({ use }: NameLookupState): boolean =>
  implicitSelfCallee(use.parsed.sup.id, use.node.parent ?? use.node)?.id === use.node.id;

export const swiftLookupPolicy: NameLookupPolicy = {
  fromClosestBinding: ownOverloadDeclaration,
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

/**
 * A qualified C# type name (`P.Mix`) the directory-scoped lookup missed, resolved through the
 * file's `using P;` across every directory that declares `P`.
 */
function csharpQualifiedThroughUsing({ use, lookupName }: NameLookupState): GoToResult | null {
  if (!lookupName.includes(".")) return null;
  const hit = resolveCsharpQualifiedName(use.index, use.mod, lookupName, use.node.startIndex);
  return hit?.kind === "resolved"
    ? okGoToResult(use.index, hit.def, { resolution: "import", confidence: "high" })
    : null;
}

export const csharpLookupPolicy: NameLookupPolicy = {
  lookupName: (use) => csharpLookupName(use.node, use.parsed.source, use.name),
  fromClosestBinding: ownOverloadDeclaration,
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
  // Without a member, `using static` members join the namespace-level answer.
  afterCrossModule: (state, resolved) =>
    implicitSelf(
      state,
      withCsharpUsingStatic(state.use, state.lookupName, resolved ?? csharpQualifiedThroughUsing(state)),
    ),
  preloadFiles: (_index, mod) => csharpUsingStaticFiles(mod),
};

/**
 * Java and Kotlin: a type method bound lexically still needs static-scope and overload checks,
 * and an inherited member beats a same-file top-level (Kotlin) function, a same-package
 * declaration, or an import.
 */
export const jvmLookupPolicy: NameLookupPolicy = {
  // Java methods and variables are separate namespaces: `int hit = 0; hit();` still calls the
  // method. A Kotlin local holding a function is callable, so Kotlin keeps the binding.
  ignoresBinding: (use, binding) =>
    use.parsed.sup.id === "java" &&
    binding.kind !== "function" &&
    implicitSelfCallee("java", use.node.parent ?? use.node)?.id === use.node.id,
  fromClosestBinding: ownOverloadDeclaration,
  onLocal(state, local) {
    if (state.closestBinding?.kind !== "function" || !isImplicitSelfCall(state)) return undefined;
    if (!bindsAtFileScope(state) && !bindsTypeMethod(state)) return undefined;
    return implicitSelf(state, lexical(state, local));
  },
  afterCrossModule: (state, resolved) => implicitSelf(state, resolved),
};
