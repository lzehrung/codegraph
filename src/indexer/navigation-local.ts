import type { LanguageSupport } from "../languages.js";
import { getCallArgumentCount } from "../languages/callable-arity.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { okGoToResult } from "./navigation-provenance.js";
import { cppSelectCallableBinding } from "./cpp-callables.js";
import { typescriptCallableCandidatesInContainer, typescriptSelectOverloadCandidate } from "./ts-callables.js";
import { cScopeName, cTagRole } from "../languages/definitions/c.js";
import { pythonFunctionAnnotationOwner, pythonTypeParameterAnnotationOwner } from "../languages/definitions/python.js";
import {
  bindingCoversUse,
  fileScopeDefinitionCoversUse,
  isExplicitMethodCall,
  laterLocalBlocksOuterUse,
  pythonFunctionPendingInSignature,
  scopeAllowsUse,
  scopeIdentifierKey,
  scopeNodesFor,
  closestContainingScope,
} from "./scope-nodes.js";
import { buildScopeIndexFromSource, type Binding, type Scope, type ScopeIndex } from "./scope.js";
import { cachedParsedContextForIndexSync, cachedScopeIndexForIndex, retainScopeIndexForIndex } from "./parsed-cache.js";
import {
  cjsRequireValueBinding,
  csharpShadowedStarsMayHold,
  resolveExport,
  resolveImported,
} from "./navigation-resolve.js";
import { phpNamedImportRole } from "./import-types.js";
import { resolvePhpExplicitImport } from "./php-namespace-symbols.js";
import { AMBIGUOUS_STAR_IMPORT_REASON } from "./ambiguous-resolution.js";
import {
  decideStarImportCandidates,
  effectiveExplicitOrLocalBinding,
  explicitBindingStartIndex,
  isExpandedStarBinding,
  resolveStarImportedDefinition,
  starImportPrecedence,
  type StarImportCandidate,
} from "./star-import-precedence.js";
import {
  SymbolKind,
  type GoToResult,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "./types.js";

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
 * A position after the declared name is a use, not the declaration: annotations, parameter
 * defaults, bodies, and initializers must not resolve to the enclosing declaration.
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
      const onDeclarationPrefix = currentNode === current || (!!named && currentNode.endIndex <= named.endIndex);
      const ownClass = isThis && FALLBACK_CLASS_TYPES.has(current.type);
      if (named && sup.nodeTypes.identifier.includes(named.type) && (onDeclarationPrefix || ownClass)) {
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
  let scopeIndex = cachedScopeIndexForIndex(index, file);
  if (scopeIndex) return scopeIndex;
  const shared = cachedParsedContextForIndexSync(index, file);
  const parsed = shared ?? { source, sup, tree, nativeQueries: null };
  if (shared) {
    source = shared.source;
    sup = shared.sup;
    tree = shared.tree;
  }
  scopeIndex = buildScopeIndexFromSource(file, source, sup, mod.imports, { tree, locals: mod.locals });
  retainScopeIndexForIndex(index, file, parsed, scopeIndex);
  return scopeIndex;
}

/** Python function bodies resolve module names when called, after module initialization. */
function pythonModuleLookupUsesRuntimeBindings(
  scope: Scope | undefined,
  node: SyntaxNodeLike,
  annotationsPostponed = false,
): boolean {
  if (annotationsPostponed && pythonFunctionAnnotationOwner(node)) return true;
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
  annotationsPostponed = false,
): Binding | null {
  const useStartIndex = useNode.startIndex;
  let importBinding: ImportBinding | undefined;
  let importSource: Binding | undefined;
  let localBinding: Binding | undefined;
  let latestLocalStart = -1;
  for (let candidate: Binding | undefined = binding; candidate; candidate = candidate.earlierSameScope) {
    const localStart = candidate.def?.start.index;
    const pendingFunction =
      candidate.kind === "function" &&
      pythonFunctionPendingInSignature(candidate.def?.start.index, useNode, annotationsPostponed);
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

export function findClosestScopeBinding(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
): Binding | null {
  if (support.id === "csharp" && bindingName.includes(".")) {
    const names = bindingName.split(".");
    const first = names.shift()!;
    let owner = findClosestScopeBinding(scopeIndex, first, currentNode, support);
    for (const name of names) {
      if (owner?.kind !== "class") return null;
      const body = owner.node?.parent?.childForFieldName("body");
      if (!body) return null;
      const bodyScope = scopeIndex.allScopes.find((scope) => scope.node.id === body.id);
      owner = bodyScope?.map.get(support.normalizeIdentifier(name)) ?? null;
    }
    return owner;
  }
  const genericOwner = support.id === "python" ? pythonTypeParameterAnnotationOwner(currentNode) : null;
  const row = scopeNodesFor(support.id);
  const canonicalName = scopeIdentifierKey(row, bindingName, currentNode, support.normalizeIdentifier);
  const normalizedName = support.id === "c" && cTagRole(currentNode) ? cScopeName(canonicalName, "tag") : canonicalName;
  let currentScope = closestContainingScope(scopeIndex, currentNode);

  const methodCall = isExplicitMethodCall(row, currentNode);
  const pythonModuleLookupAtRuntime =
    !!row.moduleBindingsAtFunctionRuntime &&
    pythonModuleLookupUsesRuntimeBindings(currentScope, currentNode, scopeIndex.pythonPostponedAnnotations);
  while (currentScope) {
    const outsideGenericOwner =
      genericOwner &&
      (currentScope.node.startIndex < genericOwner.startIndex || currentScope.node.endIndex > genericOwner.endIndex);
    if (outsideGenericOwner) return null;
    if (!scopeAllowsUse(row, currentScope, currentNode, scopeIndex.pythonPostponedAnnotations)) {
      for (
        let declaration = currentScope.map.get(normalizedName);
        declaration;
        declaration = declaration.earlierSameScope
      ) {
        const range = declaration.def;
        const ownsDeclaration =
          range?.start.index === currentNode.startIndex && range.end.index === currentNode.endIndex;
        if (ownsDeclaration) return declaration;
      }
      currentScope = currentScope.parent;
      continue;
    }
    let binding: Binding | undefined = currentScope.map.get(normalizedName);
    if (!pythonModuleLookupAtRuntime || currentScope.kind !== "module" || methodCall) {
      while (
        binding &&
        ((methodCall && binding.kind === "local") ||
          ((!pythonModuleLookupAtRuntime || currentScope.kind !== "module") &&
            !bindingCoversUse(
              row,
              currentScope.kind,
              binding,
              currentNode.startIndex,
              currentNode,
              scopeIndex.pythonPostponedAnnotations,
            )))
      ) {
        binding = binding.earlierSameScope;
      }
    }
    if (support.id === "python" && currentScope.kind === "module" && binding) {
      const effectiveBinding = effectivePythonModuleScopeBinding(
        binding,
        currentNode,
        pythonModuleLookupAtRuntime,
        scopeIndex.pythonPostponedAnnotations,
      );
      if (effectiveBinding) return effectiveBinding;
      currentScope = currentScope.parent;
      continue;
    }
    if (binding) return binding;
    if (
      laterLocalBlocksOuterUse(
        row,
        currentScope,
        normalizedName,
        currentNode.startIndex,
        currentNode,
        scopeIndex.pythonPostponedAnnotations,
      )
    )
      return null;
    currentScope = currentScope.parent;
  }

  return null;
}

/** A later or not-yet-bound local can make an earlier outer-name read invalid. */
export function laterLocalShadowsUse(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
): boolean {
  const row = scopeNodesFor(support.id);
  if (!row.laterLocalBlocksOuterKinds && !row.moduleBindingsAtFunctionRuntime) return false;
  const canonicalName = scopeIdentifierKey(row, bindingName, currentNode, support.normalizeIdentifier);
  let scope = closestContainingScope(scopeIndex, currentNode);
  while (scope) {
    if (!scopeAllowsUse(row, scope, currentNode, scopeIndex.pythonPostponedAnnotations)) {
      scope = scope.parent;
      continue;
    }
    if (
      laterLocalBlocksOuterUse(
        row,
        scope,
        canonicalName,
        currentNode.startIndex,
        currentNode,
        scopeIndex.pythonPostponedAnnotations,
      )
    ) {
      return true;
    }
    let binding = scope.map.get(canonicalName);
    while (
      binding &&
      !bindingCoversUse(
        row,
        scope.kind,
        binding,
        currentNode.startIndex,
        currentNode,
        scopeIndex.pythonPostponedAnnotations,
      )
    ) {
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
): SymbolDef | null {
  let binding = closest;
  if (!binding.def) return null;
  if (support.id === "cpp" && binding.kind === "function" && source) {
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
  if ((support.id === "ts" || support.id === "tsx") && binding.kind === "function" && source && tree) {
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
  const tagRole = support.id === "c" && binding.node ? cTagRole(binding.node) : undefined;
  return {
    file,
    localName: binding.name,
    kind,
    range,
    ...(binding.callable ? { callable: binding.callable } : {}),
    ...(tagRole ? { cTag: tagRole } : {}),
  };
}

export function toModuleRef(resolved?: FileId | { external: string }): string | undefined {
  if (!resolved) return undefined;
  return typeof resolved === "string" ? resolved : resolved.external;
}

function importBindingCoversIndex(imp: ImportBinding, index: number): boolean {
  const ranges: Range[] = [];
  if ((imp.kind === "named" || imp.kind === "default" || imp.kind === "namespace") && imp.localRange) {
    ranges.push(imp.localRange);
  }
  if (imp.kind === "named" && imp.importedRange) ranges.push(imp.importedRange);
  return ranges.some((range) => {
    const start = range.start.index;
    const end = range.end.index;
    return start !== undefined && end !== undefined && index >= start && index < end;
  });
}

function starImportGoTo(index: ProjectIndex, imp: ImportBinding, def: SymbolDef, name: string): GoToResult {
  return okGoToResult(index, def, {
    via: {
      ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
      exportedName: name,
    },
    resolution: "import-star",
    confidence: "medium",
  });
}

const CALL_ARGUMENT_PARENT_TYPES: ReadonlySet<string> = new Set([
  "call",
  "call_expression",
  "function_call_expression",
  "invocation_expression",
  "method_invocation",
  "scoped_call_expression",
]);

/** Argument count when `node` is a callee: null for an unknown count, undefined for a non-call. */
function explicitCallArgumentCount(
  languageId: string,
  source: string,
  node: SyntaxNodeLike,
): number | null | undefined {
  const call = node.parent;
  if (!call || !CALL_ARGUMENT_PARENT_TYPES.has(call.type)) return undefined;
  const callee = call.childForFieldName("name") ?? call.childForFieldName("function") ?? call.namedChildren[0] ?? null;
  if (!callee || node.startIndex < callee.startIndex || node.endIndex > callee.endIndex) return undefined;
  return getCallArgumentCount({ languageId, source, call });
}

/** A file-wide fallback cannot promote another function's or class's lexical local. */
function moduleScopeOwnsDefinition(
  scopeIndex: ScopeIndex,
  canonicalName: string,
  definition: SymbolDef,
  support: LanguageSupport,
): boolean {
  const row = scopeNodesFor(support.id);
  if (!row.classScopeBoundaryTypes) return true;
  const bindings = scopeIndex.bindings.get(canonicalName);
  if (!bindings) return true;
  for (const binding of bindings) {
    const range = binding.def;
    if (!range || range.start.index !== definition.range.start.index) continue;
    let owner = binding.node?.parent;
    const namesOwner = owner?.childForFieldName("name")?.startIndex === range.start.index;
    if (namesOwner) owner = owner?.parent;
    for (; owner; owner = owner.parent) {
      if (row.classScopeBoundaryTypes.has(owner.type)) return false;
    }
    return true;
  }
  return true;
}

export function resolveNamedDefinition(
  index: ProjectIndex,
  mod: ModuleIndex,
  file: FileId,
  support: LanguageSupport,
  name: string,
  cNamespace?: "tag" | "ordinary",
  referenceIndex?: number,
  callSite?: { node: SyntaxNodeLike; source: string },
  scopeIndex?: ScopeIndex,
): GoToResult | null {
  const callArgumentCount = callSite
    ? explicitCallArgumentCount(support.id, callSite.source, callSite.node)
    : undefined;
  const callableReference = callSite?.node.parent;
  // `::Name` may name a constructor or factory; the type receiver in `Name::member` is not that target.
  const isCallableUse =
    callArgumentCount !== undefined ||
    (support.id === "kotlin" &&
      callableReference?.type === "callable_reference" &&
      callableReference.namedChildren.at(-1)?.id === callSite?.node.id);
  const argumentCount = callArgumentCount ?? undefined;
  const arityOptions = {
    ...(isCallableUse ? { isCallableUse } : {}),
    ...(argumentCount !== undefined ? { argumentCount } : {}),
  };
  const normalizedName = support.normalizeIdentifier(name);
  const requiresExplicitReceiver = !support.membersAreImplicitlyInScope;
  const directExport =
    requiresExplicitReceiver && support.id !== "c"
      ? mod.exports.find(
          (entry) =>
            entry.type === "local" &&
            support.normalizeIdentifier(entry.exportedAs) === normalizedName &&
            !entry.target.isMember,
        )
      : undefined;
  const suppressCppUnqualifiedLocalExport = support.id === "cpp" && !name.includes("::");
  let hit: ResolvedExport | null = null;
  const precedence = starImportPrecedence(support.id);
  const matchesExplicitBinding = (imp: ImportBinding): boolean => {
    if (isExpandedStarBinding(imp, mod.imports)) return false;
    if (imp.kind === "default") return support.normalizeIdentifier(imp.local) === normalizedName;
    if (imp.kind === "named") return !imp.cNamespace && support.normalizeIdentifier(imp.local) === normalizedName;
    return imp.kind === "namespace" && support.normalizeIdentifier(imp.localNS) === normalizedName;
  };
  // Explicit-beats-star languages: an explicit import, then the compilation unit (Java and
  // Kotlin same-package peers), then a wildcard. resolveExport's compilation-unit hit must wait
  // until explicit imports have had a chance to win and must still beat star imports. In Rust a
  // `use` and a same-named local item are a compile error, so the order changes nothing there.
  const deferCompilationUnitPeers = precedence === "explicit-beats-star";
  if (!suppressCppUnqualifiedLocalExport) {
    if (directExport && directExport.type === "local") {
      hit = { kind: "resolved", def: directExport.target };
    } else if (!deferCompilationUnitPeers) {
      hit = resolveExport(index, file, name, {
        allowLocalFallback: support.membersAreImplicitlyInScope,
        ...(cNamespace ? { cNamespace } : {}),
        ...(support.id === "csharp" && referenceIndex !== undefined ? { referenceIndex } : {}),
        ...arityOptions,
      });
    }
  }
  let localDefinition: SymbolDef | undefined;
  if (hit?.kind === "resolved" && fileIdentityKey(file) === fileIdentityKey(hit.def.file)) {
    localDefinition = hit.def;
  }
  const row = scopeNodesFor(support.id);
  const lookupScope = scopeIndex ?? cachedScopeIndexForIndex(index, file);
  if (
    localDefinition &&
    lookupScope &&
    !moduleScopeOwnsDefinition(lookupScope, normalizedName, localDefinition, support)
  ) {
    hit = null;
    localDefinition = undefined;
  }
  const annotationsPostponed = !!lookupScope?.pythonPostponedAnnotations;
  const postponedAnnotation = annotationsPostponed && !!callSite && !!pythonFunctionAnnotationOwner(callSite.node);
  let moduleLookupAtRuntime = false;
  if (row.moduleBindingsAtFunctionRuntime && referenceIndex !== undefined) {
    const inFunctionBody = !!lookupScope?.allScopes.some((scope) => {
      if (scope.kind !== "function") return false;
      const body = scope.node.childForFieldName("body");
      return !!body && referenceIndex >= body.startIndex && referenceIndex < body.endIndex;
    });
    moduleLookupAtRuntime = postponedAnnotation || inFunctionBody;
  }
  let pendingOwnFunction = false;
  if (support.id === "python" && hit?.kind === "resolved" && hit.def.kind === SymbolKind.Function) {
    const sameFile = fileIdentityKey(file) === fileIdentityKey(hit.def.file);
    if (sameFile && callSite) {
      pendingOwnFunction = pythonFunctionPendingInSignature(
        hit.def.range.start.index,
        callSite.node,
        annotationsPostponed,
      );
    }
  }
  const effectiveBinding = effectiveExplicitOrLocalBinding(
    mod.imports,
    support.id,
    matchesExplicitBinding,
    pendingOwnFunction ? undefined : localDefinition?.range.start.index,
    referenceIndex,
    moduleLookupAtRuntime,
  );
  const effectiveExplicitImport = effectiveBinding?.kind === "explicit" ? effectiveBinding.binding : undefined;
  const declarationOutOfScope =
    hit?.kind === "resolved" &&
    referenceIndex !== undefined &&
    fileIdentityKey(file) === fileIdentityKey(hit.def.file) &&
    (pendingOwnFunction ||
      !fileScopeDefinitionCoversUse(support.id, hit.def.range, referenceIndex, hit.def.kind, moduleLookupAtRuntime));
  if (hit?.kind === "resolved" && (!requiresExplicitReceiver || !hit.def.isMember)) {
    // Under last-wins order the module binding in force at this use may be an import that a later
    // same-file declaration replaces, so the source-order veto must not answer for it. Only a
    // module-level import binds the module scope; a conditional, type-checking, or function-suite
    // import keeps the veto, and an arbitration that names neither side stays unresolved.
    const earlierModuleImportWins = precedence === "last-wins" && !!effectiveExplicitImport?.moduleLevel;
    if (declarationOutOfScope && !earlierModuleImportWins) return null;
    if (!declarationOutOfScope && (support.id !== "python" || effectiveBinding?.kind === "local")) {
      const importedFrom =
        support.id === "c" && fileIdentityKey(file) !== fileIdentityKey(hit.def.file) ? hit.def.file : undefined;
      return okGoToResult(index, hit.def, {
        via: { exportedName: name, ...(importedFrom ? { importedFrom } : {}) },
        resolution: importedFrom ? "import" : "exact",
        confidence: "high",
      });
    }
  }
  if (hit?.kind === "namespace" && effectiveBinding?.kind !== "explicit") {
    const targetMod = index.byFile.get(fileIdentityKey(hit.file));
    const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
    if (firstExport) {
      return okGoToResult(index, firstExport.target, {
        via: { exportedName: name },
        resolution: "namespace",
        confidence: "medium",
      });
    }
  }

  const starCandidates: StarImportCandidate[] = [];
  let lastWinsResult: GoToResult | null = null;
  const checksEarlierModuleBinding = declarationOutOfScope && precedence === "last-wins";
  const acceptBinding = (result: GoToResult, imp: ImportBinding): GoToResult | null => {
    // A click on the binding's own token names that import, not a later rebinding.
    if (precedence === "last-wins" && referenceIndex !== undefined && importBindingCoversIndex(imp, referenceIndex)) {
      return result;
    }
    if (precedence === "last-wins") {
      lastWinsResult = result;
      return null;
    }
    return result;
  };

  for (const imp of mod.imports) {
    // Star expansion republishes the same names. Judging those copies as explicit
    // imports would hide a second star import behind the first expanded binding.
    if (isExpandedStarBinding(imp, mod.imports)) continue;
    const matchesExplicit = matchesExplicitBinding(imp);
    if (matchesExplicit && effectiveExplicitImport !== imp) continue;

    let matched: GoToResult | null = null;
    if (imp.kind === "default" && support.normalizeIdentifier(imp.local) === normalizedName) {
      const result = resolveImported(index, imp, "default", arityOptions);
      if (result && !("namespace" in result)) {
        matched = okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: "default",
          },
          resolution: "import",
          confidence: "high",
        });
      }
    } else if (imp.kind === "named" && support.normalizeIdentifier(imp.local) === normalizedName) {
      const phpRole = phpNamedImportRole(imp);
      let result: SymbolDef | { namespace: FileId } | null;
      if (phpRole) {
        // This role-blind fallback cannot choose between PHP class, function, and constant aliases.
        const hasPhpRoleCollision = mod.imports.some(
          (candidate) =>
            candidate !== imp &&
            candidate.kind === "named" &&
            phpNamedImportRole(candidate) !== undefined &&
            support.normalizeIdentifier(candidate.local) === normalizedName,
        );
        if (hasPhpRoleCollision) {
          result = null;
        } else {
          result = resolvePhpExplicitImport(index, imp, phpRole);
        }
      } else {
        result = resolveImported(index, imp, imp.imported, {
          ...(cNamespace ? { cNamespace } : {}),
          ...arityOptions,
        });
      }
      if (result && !("namespace" in result)) {
        matched = okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: imp.imported,
          },
          resolution: "import",
          confidence: "high",
        });
      }
    } else if (imp.kind === "star") {
      let targetModule: ModuleIndex | undefined;
      // This fallback is for an earlier explicit module binding, not a star that executes later.
      if (checksEarlierModuleBinding && referenceIndex !== undefined) {
        if (imp.pythonStatementStartIndex === undefined) {
          lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
          continue;
        }
        if (imp.pythonStatementStartIndex > referenceIndex) continue;
        const explicitStartIndex = effectiveExplicitImport
          ? explicitBindingStartIndex(effectiveExplicitImport)
          : undefined;
        // A subsequent explicit import overwrites even an unchecked star.
        if (explicitStartIndex !== undefined && imp.pythonStatementStartIndex < explicitStartIndex) continue;
        if (!imp.moduleLevel) {
          lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
          continue;
        }
        targetModule = typeof imp.resolved === "string" ? index.byFile.get(fileIdentityKey(imp.resolved)) : undefined;
        if (
          !targetModule ||
          targetModule.parserDegraded ||
          targetModule.nativeOutcome === "skipped" ||
          targetModule.parseErrorRanges?.length
        ) {
          lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
          continue;
        }
      }
      const def = resolveStarImportedDefinition(index, imp, name, support.id, cNamespace, argumentCount, isCallableUse);
      // A resolved export can still be replaced by forwarding of the same name. Keep that
      // uncertainty until a later proven binding overwrites it; unrelated imports are harmless.
      if (targetModule) {
        const hasUncheckedNameImports = targetModule.imports.some((binding) => {
          if (binding.kind === "star") return true;
          const bindingName = binding.kind === "namespace" ? binding.localNS : binding.local;
          return support.normalizeIdentifier(bindingName) === normalizedName;
        });
        const hasUncheckedNameExports =
          hasUncheckedNameImports ||
          targetModule.exports.some((entry) => {
            if (entry.type === "exportStar") return true;
            const exportsRequestedName = support.normalizeIdentifier(entry.exportedAs) === normalizedName;
            if (entry.type === "local") return !def && exportsRequestedName;
            return exportsRequestedName;
          });
        const cannotProveStarBinding =
          hasUncheckedNameExports ||
          (!def &&
            targetModule.locals.some((local) => support.normalizeIdentifier(local.localName) === normalizedName));
        if (cannotProveStarBinding) {
          lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
          continue;
        }
      }
      if (def) {
        const starResult = starImportGoTo(index, imp, def, name);
        if (precedence === "last-wins") {
          const taken = acceptBinding(starResult, imp);
          if (taken) return taken;
        } else {
          starCandidates.push({ imp, def });
        }
      }
    } else if (imp.kind === "namespace" && support.normalizeIdentifier(imp.localNS) === normalizedName) {
      const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
      if (imp.mechanism === "cjs" && targetFile) {
        const classValue = cjsRequireValueBinding(index, targetFile);
        if (classValue) {
          matched = okGoToResult(index, classValue, {
            via: {
              ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
              exportedName: classValue.localName,
            },
            resolution: "import",
            confidence: "high",
          });
        }
      }
      if (!matched) {
        const targetMod = targetFile ? index.byFile.get(fileIdentityKey(targetFile)) : undefined;
        const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
        if (firstExport) {
          matched = okGoToResult(index, firstExport.target, {
            via: {
              ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
              exportedName: firstExport.exportedAs,
            },
            resolution: "namespace",
            confidence: "medium",
          });
        }
      }
    }

    if (!matched) {
      if (matchesExplicit && effectiveExplicitImport === imp) {
        if (precedence !== "last-wins") return null;
        lastWinsResult = null;
      }
      continue;
    }
    const taken = acceptBinding(matched, imp);
    if (taken) return taken;
  }

  // A local binding name always wins above so a grouped import's own aliases never collide with
  // each other. An aliased import's source spelling is not itself a bound name anywhere in the
  // file (Python: `from a import helper as h` binds only `h`; a bare `helper()` elsewhere is
  // unbound and must stay not_found), so only resolve it when the click falls inside that exact
  // import statement's own source-name token, never by re-matching the spelling anywhere else.
  if (referenceIndex !== undefined) {
    for (const imp of mod.imports) {
      if (
        imp.kind !== "named" ||
        imp.local === imp.imported ||
        support.normalizeIdentifier(imp.imported) !== normalizedName ||
        !imp.importedRange ||
        imp.importedRange.start.index === undefined ||
        imp.importedRange.end.index === undefined ||
        referenceIndex < imp.importedRange.start.index ||
        referenceIndex >= imp.importedRange.end.index
      ) {
        continue;
      }
      const result = resolveImported(index, imp, imp.imported, {
        ...(cNamespace ? { cNamespace } : {}),
        ...arityOptions,
      });
      if (result && !("namespace" in result)) {
        return okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: imp.imported,
          },
          resolution: "import",
          confidence: "high",
        });
      }
    }
  }

  if (precedence === "last-wins") {
    if (lastWinsResult) return lastWinsResult;
  } else {
    if (deferCompilationUnitPeers) {
      const unitHit = resolveExport(index, file, name, {
        allowLocalFallback: support.membersAreImplicitlyInScope,
        ...arityOptions,
      });
      if (unitHit?.kind === "resolved" && (!requiresExplicitReceiver || !unitHit.def.isMember)) {
        return okGoToResult(index, unitHit.def, {
          via: { exportedName: name },
          resolution: "exact",
          confidence: "high",
        });
      }
      if (unitHit?.kind === "namespace") {
        const targetMod = index.byFile.get(fileIdentityKey(unitHit.file));
        const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
        if (firstExport) {
          return okGoToResult(index, firstExport.target, {
            via: { exportedName: name },
            resolution: "namespace",
            confidence: "medium",
          });
        }
      }
    }
    if (!starCandidates.length) return null;
    const blocked = support.id === "csharp" && csharpShadowedStarsMayHold(index, mod, name);
    const decision = decideStarImportCandidates(index, support.id, starCandidates, file, blocked, isCallableUse);
    if (decision.status === "ambiguous") {
      return { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
    }
    if (decision.status === "resolved") {
      return starImportGoTo(index, decision.imp, decision.definition, name);
    }
  }

  return null;
}
