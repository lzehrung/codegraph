import { withCsharpGlobalUsings } from "./csharp-global-usings.js";
import type { LanguageSupport } from "../languages.js";
import { getCallArgumentCount } from "../languages/callable-arity.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import { cppSelectCallableBinding } from "./cpp-callables.js";
import { typescriptCallableCandidatesInContainer, typescriptSelectOverloadCandidate } from "./ts-callables.js";
import { cTagRole } from "../languages/definitions/c.js";
import {
  bindingCoversUse,
  isTypeParameterBinding,
  laterLocalBlocksOuterUse,
  scopeAllowsUse,
  scopeIdentifierKey,
  scopeNodesFor,
  closestContainingScope,
  typeOnlyName,
  type ScopeNodeRow,
} from "./scope-nodes.js";
import { buildScopeIndexFromSource, type Binding, type ScopeIndex } from "./scope.js";
import { csharpQualifiedNameNode, findClosestScopeBinding } from "./scope-lookup.js";
import { cachedParsedContextForIndexSync, cachedScopeIndexForIndex, retainScopeIndexForIndex } from "./parsed-cache.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";

export const CSHARP_GENERIC_OWNER_REASON = "C# name is qualified through a generic type, not a namespace";

/**
 * Whether a C# qualified name is qualified through a generic type (`N.Outer<int>.Inner`). Its last name
 * belongs to that constructed type, but the lookup name drops type arguments and would read it as a
 * member of the namespace `N.Outer`.
 */
export function csharpQualifiedThroughGenericOwner(chain: SyntaxNodeLike): boolean {
  let qualifier = chain.childForFieldName("qualifier");
  while (qualifier) {
    if (qualifier.type === "generic_name") return true;
    if (qualifier.type !== "qualified_name" && qualifier.type !== "alias_qualified_name") return false;
    if (qualifier.childForFieldName("name")?.type === "generic_name") return true;
    qualifier = qualifier.childForFieldName("qualifier");
  }
  return false;
}

/** Preserve the full C# namespace or alias path, excluding generic type arguments. */
export function csharpLookupName(node: SyntaxNodeLike, source: string, fallback: string): string {
  const qualified = csharpQualifiedNameNode(node);
  if (!qualified) return fallback;
  const text = source.slice(qualified.startIndex, qualified.endIndex);
  if (!text.includes("<")) return text.replace(/\s+/gu, "");
  const argumentsNodes: SyntaxNodeLike[] = [];
  const collect = (current: SyntaxNodeLike): void => {
    if (current.type === "generic_name") {
      const argumentsNode = (current.namedChildren ?? []).find((child) => child.type === "type_argument_list");
      if (argumentsNode) argumentsNodes.push(argumentsNode);
      return;
    }
    for (const child of current.namedChildren ?? []) {
      if (child.type === "generic_name" || child.type === "qualified_name" || child.type === "alias_qualified_name") {
        collect(child);
      }
    }
  };
  collect(qualified);
  let result = "";
  let from = qualified.startIndex;
  for (const argumentsNode of argumentsNodes) {
    result += source.slice(from, argumentsNode.startIndex);
    from = argumentsNode.endIndex;
  }
  return (result + source.slice(from, qualified.endIndex)).replace(/\s+/gu, "");
}

const FALLBACK_DECLARATION_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "variable_declarator",
  "interface_declaration",
  "type_alias_declaration",
  "function_definition",
  "class_definition",
  "assignment",
]);

const FALLBACK_CLASS_TYPES = new Set(["class_declaration", "class_definition"]);

/** Ordinary JavaScript functions rebind `this`; arrow functions and class methods do not. */
const DYNAMIC_THIS_FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "function",
  "generator_function",
  "generator_function_declaration",
]);

/**
 * The declared name for a position on a declaration's own header (its keywords, name, or the
 * space between them), and the enclosing class name for a JavaScript/TypeScript `this` whose
 * value is lexically that class (not inside an ordinary nested function).
 *
 * A position inside the body or initializer is a use, not the declaration: `trim` in
 * `const handle = value?.trim()` must never resolve to `handle`.
 */
export function findDeclarationNameNode(
  sup: LanguageSupport,
  currentNode: SyntaxNodeLike | null,
): SyntaxNodeLike | null {
  if (!currentNode) return null;
  const isThis = currentNode.type === "this";
  let current: SyntaxNodeLike | null = currentNode;
  while (current) {
    if (isThis && current !== currentNode && DYNAMIC_THIS_FUNCTION_TYPES.has(current.type)) return null;
    // An object-literal method binds `this` to that object, not to the enclosing class.
    if (isThis && current.type === "method_definition" && current.parent?.type !== "class_body") return null;
    if (FALLBACK_DECLARATION_TYPES.has(current.type)) {
      let named = current.childForFieldName("name");
      if (!named && current.type === "assignment") {
        const left = current.child(0);
        if (left && sup.nodeTypes.identifier.includes(left.type)) {
          named = left;
        }
      }
      const tail =
        current.childForFieldName("body") ??
        current.childForFieldName("value") ??
        (current.type === "assignment" ? current.childForFieldName("right") : null);
      const headerEnd = tail ? tail.startIndex : current.endIndex;
      const onHeader = currentNode === current || currentNode.endIndex <= headerEnd;
      const ownClass = isThis && FALLBACK_CLASS_TYPES.has(current.type);
      if (named && sup.nodeTypes.identifier.includes(named.type) && (onHeader || ownClass)) {
        return named;
      }
    }
    current = current.parent;
  }
  return null;
}

export function getOrBuildScopeIndex(
  index: ProjectIndex,
  file: FileId,
  source: string,
  sup: LanguageSupport,
  mod: ModuleIndex,
  tree: SyntaxTreeLike,
): ScopeIndex {
  mod = withCsharpGlobalUsings(index, mod);
  let scopeIndex = cachedScopeIndexForIndex(index, file);
  if (scopeIndex) return scopeIndex;
  const shared = cachedParsedContextForIndexSync(index, file);
  const parsed = shared ?? { source, sup, tree, nativeQueries: null };
  if (shared) {
    source = shared.source;
    sup = shared.sup;
    tree = shared.tree;
  }
  scopeIndex = buildScopeIndexFromSource(file, source, sup, mod.imports, {
    tree,
    locals: mod.locals,
    parseErrorRanges: mod.parseErrorRanges,
  });
  retainScopeIndexForIndex(index, file, parsed, scopeIndex);
  return scopeIndex;
}

/** A later or not-yet-bound local can make an earlier outer-name read invalid. */
export function laterLocalShadowsUse(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
  skipFunctionScope = false,
  selectedRow?: ScopeNodeRow,
): boolean {
  const row = selectedRow ?? scopeNodesFor(support.id);
  if (typeOnlyName(row, currentNode)) return false;
  if (!row.laterLocalBlocksOuterKinds && !row.moduleBindingsAtFunctionRuntime) return false;
  const canonicalName = scopeIdentifierKey(row, bindingName, currentNode, support.normalizeIdentifier);
  let scope = closestContainingScope(scopeIndex, currentNode);
  if (skipFunctionScope && scope?.kind === "function") scope = scope.parent;
  while (scope) {
    if (!scopeAllowsUse(row, scope, currentNode)) {
      scope = scope.parent;
      continue;
    }
    if (
      laterLocalBlocksOuterUse(
        row,
        scope,
        canonicalName,
        currentNode.startIndex,
        support.normalizeIdentifier,
        currentNode,
      )
    )
      return true;
    let binding = scope.map.get(canonicalName);
    while (binding && !bindingCoversUse(row, scope.kind, binding, currentNode.startIndex, currentNode, support)) {
      binding = binding.earlierSameScope;
    }
    if (binding) return false;
    scope = scope.parent;
  }
  return false;
}

function selectTypeScriptOverloadBinding(
  binding: Binding,
  currentNode: SyntaxNodeLike,
  source: string,
  languageId: string,
): Binding | null {
  const call = currentNode.parent;
  if (!call || call.type !== "call_expression") return binding;
  const candidates = typescriptCallableCandidatesInContainer(
    binding.sameScopeFunctionBindings ?? [binding],
    (candidate) => candidate.callable,
    binding.callable?.key,
  );
  const selected = typescriptSelectOverloadCandidate({
    group: candidates,
    identityOf: (candidate) => candidate.callable,
    argumentCount: getCallArgumentCount({ languageId, source, call }),
  });
  return selected ?? null;
}

export function findClosestBinding(
  scopeIndex: ScopeIndex,
  file: FileId,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
  source?: string,
  tree?: SyntaxTreeLike,
): SymbolDef | null {
  const binding = findClosestScopeBinding(scopeIndex, bindingName, currentNode, support);
  return binding ? definitionForBinding(binding, file, currentNode, support, source, tree) : null;
}

/** The definition a scope binding names at a use, choosing C++ and TypeScript overloads by arity. */
export function definitionForBinding(
  closest: Binding,
  file: FileId,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
  source?: string,
  tree?: SyntaxTreeLike,
  selectedRow?: ScopeNodeRow,
): SymbolDef | null {
  let binding = closest;
  if (!binding.def) return null;
  const row = selectedRow ?? scopeNodesFor(support.id);
  const callableGrouping = row.bindingRules?.functionRedeclarations;
  if (callableGrouping === "overload-group" && binding.kind === "function" && source) {
    const collisions = binding.sameScopeFunctionBindings ?? [binding];
    if (collisions.length > 1 || binding.callable?.signature) {
      const selected = cppSelectCallableBinding(collisions, currentNode, source, file, file);
      if (!selected?.def) return null;
      return {
        file,
        localName: selected.name,
        kind: SymbolKind.Function,
        range: selected.def,
        ...(selected.callable ? { callable: selected.callable } : {}),
      };
    }
  }
  if (callableGrouping === "signature-group" && binding.kind === "function" && source && tree) {
    const selected = selectTypeScriptOverloadBinding(binding, currentNode, source, support.id);
    if (!selected?.def) return null;
    binding = selected;
  }
  let kind = SymbolKind.Variable;
  if (binding.kind === "function") {
    kind = SymbolKind.Function;
  } else if (binding.kind === "class") {
    kind = SymbolKind.Class;
  } else if (binding.kind === "type") {
    kind = SymbolKind.TypeAlias;
  }
  const range = binding.def;
  if (!range) return null;
  const tagRole = row.bindingRules?.usesTagNamespace && binding.node ? cTagRole(binding.node) : undefined;
  return {
    file,
    localName: binding.name,
    kind,
    range,
    ...(binding.callable ? { callable: binding.callable } : {}),
    ...(isTypeParameterBinding(row, binding) ? { typeParameter: true } : {}),
    ...(tagRole ? { cTag: tagRole } : {}),
  };
}
