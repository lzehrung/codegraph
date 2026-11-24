import type { LanguageSupport } from "../languages.js";
import { cScopeName, cTagRole } from "../languages/definitions/c.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import {
  bindingCoversUse,
  bindingHiddenFromUse,
  closestContainingScope,
  isExplicitMethodCall,
  laterLocalBlocksOuterUse,
  pythonFunctionPendingInDefault,
  scopeAllowsUse,
  scopeIdentifierKey,
  scopeIsEmptyBody,
  scopeIsLocalGate,
  scopeNodesFor,
  typeOnlyName,
} from "./scope-nodes.js";
import type { Binding, Scope, ScopeIndex } from "./scope-types.js";
import { effectiveExplicitOrLocalBinding } from "./star-import-precedence.js";

/** Follow a C# name token through generic arguments and qualified-name segments. */
export function csharpQualifiedNameNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let qualified = node;
  while (qualified.parent) {
    const parent = qualified.parent;
    if (parent.type === "generic_name") {
      const name = parent.childForFieldName("name") ?? parent.namedChildren[0];
      if (name && name.startIndex === qualified.startIndex && name.endIndex === qualified.endIndex) {
        qualified = parent;
        continue;
      }
    }
    if (
      (parent.type === "qualified_name" || parent.type === "alias_qualified_name") &&
      parent.endIndex === qualified.endIndex
    ) {
      qualified = parent;
      continue;
    }
    break;
  }
  return qualified.type === "qualified_name" || qualified.type === "alias_qualified_name" ? qualified : null;
}

/** Python function bodies resolve module names when called, after module initialization. */
function pythonModuleLookupUsesRuntimeBindings(scope: Scope | undefined, node: SyntaxNodeLike): boolean {
  for (let current = scope; current; current = current.parent) {
    if (current.kind !== "function") continue;
    const body = current.node.childForFieldName("body");
    if (body && node.startIndex >= body.startIndex && node.endIndex <= body.endIndex) return true;
  }
  return false;
}

export function findClosestScopeBinding(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
  jvmTypeOnly = false,
  skipFunctionScope = false,
): Binding | null {
  const row = scopeNodesFor(support.id);
  const bindingRules = row.bindingRules;
  const qualifiedNameBinding = bindingRules?.qualifiedNameBinding;
  if (qualifiedNameBinding && bindingName.includes(".")) {
    return qualifiedNameBinding(
      scopeIndex,
      bindingName,
      currentNode,
      support,
      findClosestScopeBinding,
      csharpQualifiedNameNode,
    );
  }
  const canonicalName = scopeIdentifierKey(row, bindingName, currentNode, support.normalizeIdentifier);
  const normalizedName =
    row.bindingRules?.usesTagNamespace && cTagRole(currentNode) ? cScopeName(canonicalName, "tag") : canonicalName;
  let currentScope = closestContainingScope(scopeIndex, currentNode);
  if (skipFunctionScope && currentScope?.kind === "function") currentScope = currentScope.parent;

  const methodCall = isExplicitMethodCall(row, currentNode);
  const typeOnly = jvmTypeOnly || typeOnlyName(row, currentNode);
  const typeArity = bindingRules?.typeArgumentArity?.(currentNode) ?? 0;
  const rejectsTypeArity = bindingRules?.rejectsTypeArity;
  const effectiveModuleBinding = bindingRules?.effectiveModuleBinding;
  const pythonModuleLookupAtRuntime =
    !!row.moduleBindingsAtFunctionRuntime && pythonModuleLookupUsesRuntimeBindings(currentScope, currentNode);
  // A gate between the use and a scope hides that scope's local variables.
  let crossedGate = false;
  while (currentScope) {
    if (scopeIsEmptyBody(currentScope)) {
      crossedGate = true;
      currentScope = currentScope.parent;
      continue;
    }
    if (!scopeAllowsUse(row, currentScope, currentNode)) {
      currentScope = currentScope.parent;
      continue;
    }
    let binding: Binding | undefined = currentScope.map.get(normalizedName);
    if (!pythonModuleLookupAtRuntime || currentScope.kind !== "module" || methodCall) {
      while (binding) {
        const wrongNamespace = bindingHiddenFromUse(
          row,
          binding,
          currentNode,
          methodCall,
          typeOnly,
          crossedGate,
          support.normalizeIdentifier,
        );
        const wrongTypeArity = rejectsTypeArity?.(binding, currentNode, typeArity);
        if (!wrongNamespace && !wrongTypeArity) {
          const atModuleRuntime = pythonModuleLookupAtRuntime && currentScope.kind === "module";
          if (
            atModuleRuntime ||
            bindingCoversUse(row, currentScope.kind, binding, currentNode.startIndex, currentNode, support)
          ) {
            break;
          }
        }
        binding = binding.earlierSameScope;
      }
    }
    if (effectiveModuleBinding && currentScope.kind === "module" && binding) {
      const effectiveBinding = effectiveModuleBinding(
        binding,
        currentNode,
        pythonModuleLookupAtRuntime,
        pythonFunctionPendingInDefault,
        effectiveExplicitOrLocalBinding,
      );
      if (effectiveBinding) return effectiveBinding;
      currentScope = currentScope.parent;
      continue;
    }
    if (binding) return binding;
    const blockedByLaterValue =
      !typeOnly &&
      laterLocalBlocksOuterUse(
        row,
        currentScope,
        normalizedName,
        currentNode.startIndex,
        support.normalizeIdentifier,
        currentNode,
      );
    if (blockedByLaterValue) return null;
    if (scopeIsLocalGate(currentScope)) crossedGate = true;
    currentScope = currentScope.parent;
  }

  return null;
}
