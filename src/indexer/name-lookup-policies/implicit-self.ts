/**
 * Swift and C# additions to the shared name lookup order: inside a type, a proven member found
 * through the implicit `self`/`this` takes precedence over a same-named module-level name.
 */
import { nodeInStaticMemberContext } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import { csharpAliasQualifiedLookupName } from "../navigation-goto.js";
import { csharpLookupName } from "../navigation-local.js";
import { okGoToResult } from "../navigation-provenance.js";
import type { NameLookupPolicy, NameResolution, NameLookupState } from "../name-resolution.js";
import type { GoToResult } from "../types.js";

const implicitSelf = (state: NameLookupState, fallback: NameResolution | null): NameResolution => ({
  status: "deferred",
  request: { kind: "implicit-self-member", lookupName: state.lookupName },
  fallback,
});

export const swiftLookupPolicy: NameLookupPolicy = {
  // Method-local bindings still win; only module-level names yield to proven members.
  onLocal(state, local) {
    const { closestBinding, use } = state;
    if (!closestBinding || use.scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) !== closestBinding) {
      return undefined;
    }
    return implicitSelf(state, okGoToResult(use.index, local, { resolution: "exact", confidence: "high" }));
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
  onLocal(state) {
    const { closestBinding, use } = state;
    const staticMemberCall =
      closestBinding?.kind === "function" &&
      closestBinding.node?.parent?.type !== "local_function_statement" &&
      use.node.parent?.type === "invocation_expression" &&
      nodeInStaticMemberContext(use.node, use.parsed.source);
    if (!staticMemberCall) return undefined;
    return implicitSelf(state, { status: "not_found", reason: "No matching C# static member definition" });
  },
  // Partial members declared in another file reach this path only as invocation callees.
  afterCrossModule: (state, resolved) => implicitSelf(state, resolved),
};
