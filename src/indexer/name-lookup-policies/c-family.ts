/** C and C++ additions to the shared name lookup order. */
import { cTagRole } from "../../languages/definitions/c.js";
import {
  AMBIGUOUS_CPP_OVERLOAD_REASON,
  AMBIGUOUS_CPP_USING_DECLARATION_REASON,
  AMBIGUOUS_CPP_USING_DIRECTIVE_REASON,
  AMBIGUOUS_STAR_IMPORT_REASON,
} from "../ambiguous-resolution.js";
import { cppBindingCallableShape } from "../cpp-callables.js";
import {
  cppStarImportClosure,
  cppUsingDeclarationTarget,
  resolveCppCallableBindings,
  resolveCppCollidingBinding,
  resolveCppUsingDirectiveName,
  resolveVisibleCppCallableName,
} from "../navigation-cpp.js";
import { resolveNamedDefinition } from "../navigation-local.js";
import { okGoToResult } from "../navigation-provenance.js";
import type { ParsedFileContext } from "../parse-context.js";
import type { GoToResult } from "../types.js";
import type { BareNameUse, NameLookupPolicy, NameLookupState, NameResolution } from "../name-resolution.js";

const loadParsed =
  (use: BareNameUse) =>
  (file: string): ParsedFileContext | null =>
    use.files.get(file);

/** Several included declarations of one name may be one callable; navigation recovers that. */
function deferIncludedStarRecovery(
  state: NameLookupState,
  resolved: GoToResult | null,
  cNamespace: "tag" | "ordinary" | undefined,
): NameResolution | null | undefined {
  if (resolved?.status !== "not_found" || resolved.reason !== AMBIGUOUS_STAR_IMPORT_REASON) return undefined;
  return {
    status: "deferred",
    request: { kind: "c-included-star", lookupName: state.lookupName, cNamespace },
    fallback: resolved,
  };
}

const cNamespaceOf = (node: Parameters<NonNullable<NameLookupPolicy["cNamespace"]>>[0]): "tag" | "ordinary" =>
  cTagRole(node) ? "tag" : "ordinary";

export const cLookupPolicy: NameLookupPolicy = {
  cNamespace: cNamespaceOf,
  afterCrossModule: (state, resolved) => deferIncludedStarRecovery(state, resolved, cNamespaceOf(state.use.node)),
};

/** A qualified name (`ns::f`, `Box::make`) names a namespace or static member directly. */
export function resolveCppQualifiedName(use: BareNameUse): GoToResult | undefined {
  const { index, mod, file, node, name, scopeIndex, parsed } = use;
  if (!name.includes("::")) return undefined;
  const qualifiedBindings = scopeIndex.cppQualifiedFunctionBindings.get(name);
  if (qualifiedBindings) {
    const selected = resolveCppCallableBindings(file, qualifiedBindings, node, parsed.source);
    if (!selected) return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
    return okGoToResult(index, selected, { resolution: "exact", confidence: "high" });
  }
  const visible = resolveVisibleCppCallableName(index, mod, name, node, parsed.source, loadParsed(use));
  if (visible !== undefined) {
    if (!visible) return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
    return okGoToResult(index, visible, { resolution: "exact", confidence: "high" });
  }
  return resolveNamedDefinition(index, mod, file, parsed.sup, name) ?? undefined;
}

export const cppLookupPolicy: NameLookupPolicy = {
  beforeLexical: resolveCppQualifiedName,

  // `using ns::f;` binds the name to that namespace member.
  fromClosestBinding({ use, closestBinding }) {
    const { index, mod, file, node, parsed } = use;
    const target = closestBinding ? cppUsingDeclarationTarget(closestBinding, parsed.source) : undefined;
    if (!target) return undefined;
    const visible = resolveVisibleCppCallableName(index, mod, target, node, parsed.source, loadParsed(use));
    if (visible) return okGoToResult(index, visible, { resolution: "import", confidence: "high" });
    if (visible === undefined) {
      const resolved = resolveNamedDefinition(index, mod, file, parsed.sup, target);
      if (resolved) return resolved;
    }
    return { status: "not_found", reason: AMBIGUOUS_CPP_USING_DECLARATION_REASON };
  },

  // Inside an out-of-line member definition, a member of the owner class (or its bases) hides a
  // same-named file-scope name; parameters and function locals still win.
  wrapRest({ use, closestBinding }, rest) {
    const { node, scopeIndex } = use;
    const fileScopeOrUnbound =
      !closestBinding || scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) === closestBinding;
    if (!fileScopeOrUnbound || node.parent?.type !== "call_expression") return rest();
    return {
      status: "deferred",
      request: { kind: "cpp-out-of-line-member" },
      fallback: rest(),
      hidden: { status: "not_found", reason: "No matching C++ static member definition" },
    };
  },

  // Same-scope declarations with one name are one callable or an overload set chosen by arity.
  beforeLocal({ use, closestBinding }) {
    if (!closestBinding) return undefined;
    const collision = resolveCppCollidingBinding(use.file, closestBinding, use.node, use.parsed.source);
    if (collision === undefined) return undefined;
    if (!collision) return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
    return okGoToResult(use.index, collision, { resolution: "exact", confidence: "high" });
  },

  beforeCrossModule({ use, closestBinding }) {
    const { index, mod, node, name, parsed } = use;
    if (closestBinding?.kind === "function" && cppBindingCallableShape(closestBinding)) {
      return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
    }
    const visible = resolveVisibleCppCallableName(index, mod, name, node, parsed.source, loadParsed(use));
    if (visible !== undefined) {
      if (!visible) return { status: "not_found", reason: AMBIGUOUS_CPP_OVERLOAD_REASON };
      return okGoToResult(index, visible, { resolution: "exact", confidence: "high" });
    }
    const directed = resolveCppUsingDirectiveName(index, mod, name, node, parsed.source, loadParsed(use));
    if (directed === undefined) return undefined;
    if (!directed) return { status: "not_found", reason: AMBIGUOUS_CPP_USING_DIRECTIVE_REASON };
    return okGoToResult(index, directed, { resolution: "import", confidence: "high" });
  },

  afterCrossModule: (state, resolved) => deferIncludedStarRecovery(state, resolved, undefined),

  // Visible callables and `using` directives read every file the includes reach.
  *preloadFiles(index, mod) {
    for (const imp of mod.imports) if (typeof imp.resolved === "string") yield imp.resolved;
    for (const reachable of cppStarImportClosure(index, mod)) yield reachable.file;
  },
};
