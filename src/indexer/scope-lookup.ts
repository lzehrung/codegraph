import type { LanguageSupport } from "../languages.js";
import { cScopeName, cTagRole } from "../languages/definitions/c.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { csharpGenericArity, csharpTypeArgumentArity } from "../util/csharp-tree.js";
import type { ImportBinding } from "./import-types.js";
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

function effectivePythonModuleScopeBinding(
  binding: Binding,
  useNode: SyntaxNodeLike,
  moduleLookupAtRuntime: boolean,
): Binding | null {
  const useStartIndex = useNode.startIndex;
  let importBinding: ImportBinding | undefined;
  let importSource: Binding | undefined;
  let localBinding: Binding | undefined;
  let latestLocalStart = -1;
  for (let candidate: Binding | undefined = binding; candidate; candidate = candidate.earlierSameScope) {
    const localStart = candidate.def?.start.index;
    const pendingFunction =
      candidate.kind === "function" && pythonFunctionPendingInDefault(candidate.def?.start.index, useNode);
    if (
      !pendingFunction &&
      localStart !== undefined &&
      (moduleLookupAtRuntime || localStart <= useStartIndex) &&
      localStart > latestLocalStart
    ) {
      localBinding = candidate;
      latestLocalStart = localStart;
    }
    if (!importBinding && candidate.import) {
      importBinding = candidate.import;
      importSource = candidate;
    }
  }
  const imports = importBinding ? [importBinding] : [];
  const effective = effectiveExplicitOrLocalBinding(
    imports,
    "python",
    () => true,
    localBinding?.def?.start.index,
    useStartIndex,
    moduleLookupAtRuntime,
  );
  if (effective?.kind === "local") return localBinding ?? null;
  if (effective?.kind === "explicit") return importSource ?? null;
  return null;
}

/** A C# type name includes its syntactic arity; imports and declaration tokens keep their own binding. */
function wrongCsharpTypeArity(binding: Binding, use: SyntaxNodeLike, arity: number): boolean {
  if (binding.import || !binding.node?.parent || binding.node.id === use.id) return false;
  if (binding.kind !== "class" && binding.kind !== "type") return false;
  const declaration = use.parent;
  const constructorName =
    declaration?.type === "constructor_declaration" || declaration?.type === "destructor_declaration";
  if (constructorName) return declaration.parent?.parent?.childForFieldName("name")?.id !== binding.node.id;
  return csharpGenericArity(binding.node.parent) !== arity;
}

export function findClosestScopeBinding(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
  jvmTypeOnly = false,
  skipFunctionScope = false,
): Binding | null {
  if (support.id === "csharp" && bindingName.includes(".")) {
    const names = bindingName.split(".");
    const first = names.shift()!;
    // Each qualifier has its own arity; the leaf's type arguments must not hide a non-generic owner.
    let rootNode = csharpQualifiedNameNode(currentNode) ?? currentNode;
    while (rootNode.type === "qualified_name" || rootNode.type === "alias_qualified_name") {
      const qualifier = rootNode.childForFieldName("qualifier") ?? rootNode.childForFieldName("alias");
      if (!qualifier) return null;
      rootNode = qualifier;
    }
    let owner = findClosestScopeBinding(scopeIndex, first, rootNode, support);
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      if (owner?.kind !== "class") return null;
      const body = owner.node?.parent?.childForFieldName("body");
      if (!body) return null;
      const bodyScope = scopeIndex.allScopes.find((scope) => scope.node.id === body.id);
      let nested = bodyScope?.map.get(support.normalizeIdentifier(name));
      const arity = index === names.length - 1 ? csharpTypeArgumentArity(currentNode) : 0;
      while (nested && wrongCsharpTypeArity(nested, currentNode, arity)) nested = nested.earlierSameScope;
      owner = nested ?? null;
    }
    return owner;
  }
  const row = scopeNodesFor(support.id);
  const canonicalName = scopeIdentifierKey(row, bindingName, currentNode, support.normalizeIdentifier);
  const normalizedName = support.id === "c" && cTagRole(currentNode) ? cScopeName(canonicalName, "tag") : canonicalName;
  let currentScope = closestContainingScope(scopeIndex, currentNode);
  if (skipFunctionScope && currentScope?.kind === "function") currentScope = currentScope.parent;

  const methodCall = isExplicitMethodCall(row, currentNode);
  const typeOnly = jvmTypeOnly || typeOnlyName(support.id, currentNode);
  const csharpArity = support.id === "csharp" ? csharpTypeArgumentArity(currentNode) : 0;
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
        const wrongCsharpArity = support.id === "csharp" && wrongCsharpTypeArity(binding, currentNode, csharpArity);
        if (!wrongNamespace && !wrongCsharpArity) {
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
    if (support.id === "python" && currentScope.kind === "module" && binding) {
      const effectiveBinding = effectivePythonModuleScopeBinding(binding, currentNode, pythonModuleLookupAtRuntime);
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
