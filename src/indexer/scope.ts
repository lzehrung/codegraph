import { sliceText, toRange } from "../util/ast.js";
import { getNativeSyntaxTreeExecution } from "../native/tree-sitter-native.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import { collectParseErrorRanges } from "./parse-errors.js";
import { getMemberAccessParts, isMemberAccessNode } from "../util/member-access.js";
import { declarationKindToBindingKind } from "./declarations.js";
import { callableIdentityForDeclaration, callableIdentityForGeneratedMember } from "./callable-identity.js";
import { callableIdentityPolicyFor } from "./callable-identity-policies/index.js";
import { cppSelectCallableBinding } from "./cpp-callables.js";
import { typescriptCallableCandidatesInContainer } from "./ts-callables.js";
import {
  cppQualifiedNameSegments,
  importTypeQuerySpecifier,
  nearestMemberContainer,
  typescriptImportTypeQuery,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { phpConstructorPromotedVariable } from "./navigation-php.js";
import { cScopeName, cTagRole } from "../languages/definitions/c.js";
import type { LanguageSupport } from "../languages.js";
import { generatedMembersIn } from "../languages/generated-members.js";
import {
  bindingCoversUse,
  bindingHiddenFromUse,
  headerParameterNamedLikeType,
  isExplicitMethodCall,
  rejectsLexicalBindingAtSelector,
  laterLocalBlocksOuterUse,
  pythonFunctionPendingInDefault,
  scopeAllowsUse,
  scopeIdentifierKey,
  scopeIsEmptyBody,
  scopeIsLocalGate,
  scopeNodesFor,
  type ScopeNodeRow,
} from "./scope-nodes.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import type { GeneratedMember, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { SymbolKind, type ImportBinding, type ParseErrorRange, type SymbolDef } from "./types.js";
import type { Binding, BindingKind, Scope, ScopeIndex } from "./scope-types.js";
import { declaredNameNodes } from "./type-parameters.js";

export type { Binding, BindingKind, Scope, ScopeIndex };

/** A closer lexical binding hides a file alias unless that local holds the same module. */
export function fileBindingIsUnshadowed(scopeIndex: ScopeIndex, binding: Binding | null, aliasFrom?: string): boolean {
  return (
    !binding ||
    (!!binding.import && scopeIndex.allScopes[0]?.map.get(binding.canonicalName) === binding) ||
    (binding.kind === "local" && aliasFrom !== undefined && binding.heldModuleSpecifier === aliasFrom)
  );
}

const FUNCTION_DECLARATOR_NAME_TYPES: Record<string, true> = {
  identifier: true,
  field_identifier: true,
  destructor_name: true,
  operator_name: true,
};
function nestedFunctionDeclaratorName(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (FUNCTION_DECLARATOR_NAME_TYPES[current.type]) return current;
    current = current.childForFieldName("name");
  }
  return null;
}

function declaredNameNode(node: SyntaxNodeLike, row: ScopeNodeRow): SyntaxNodeLike | null {
  const directName = node.childForFieldName("name");
  if (directName) return directName;
  if (!row.functionNameTypes?.has(node.type)) return null;

  let current = node.childForFieldName("declarator");
  for (let depth = 0; current && depth < 8; depth += 1) {
    const name = current.childForFieldName("name");
    const declaredName = name ? nestedFunctionDeclaratorName(name) : nestedFunctionDeclaratorName(current);
    if (declaredName) return declaredName;
    current =
      current.childForFieldName("declarator") ??
      (current.type === "reference_declarator" ? (current.namedChildren[0] ?? null) : null);
  }
  return null;
}

function qualifiedCppIdentifierForName(nameNode: SyntaxNodeLike, boundary?: SyntaxNodeLike): SyntaxNodeLike | null {
  let current = nameNode.parent;
  while (current && current !== boundary) {
    if (current.type === "qualified_identifier") {
      const memberName = current.childForFieldName("name");
      const containsName =
        memberName && memberName.startIndex <= nameNode.startIndex && memberName.endIndex >= nameNode.endIndex;
      if (containsName && current.parent?.type !== "qualified_identifier") return current;
    }
    current = current.parent;
  }
  return null;
}

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  imports: ImportBinding[] = [],
  opts?: {
    tree?: SyntaxTreeLike;
    locals?: readonly SymbolDef[];
    parseErrorRanges?: readonly ParseErrorRange[] | undefined;
  },
): ScopeIndex {
  let tree = opts?.tree ?? null;
  if (!tree) {
    const nativeTreeExecution = getNativeSyntaxTreeExecution(source, support);
    if (nativeTreeExecution.tree) {
      tree = new ProjectedSyntaxTree(source, nativeTreeExecution.tree);
    }
  }
  if (!tree) {
    throw new Error(`Native parser unavailable for ${file}; scope reconstruction requires parser context.`);
  }

  const rootScope: Scope = {
    kind: "module",
    map: new Map(),
    node: tree.rootNode,
    parent: undefined,
  };
  const stack: Scope[] = [rootScope];
  const allScopes: Scope[] = [rootScope];
  const cppNamespaceMaps = new Map<string, Map<string, Binding>>();
  const cppNamespaceScopes = new Map<string, Scope>();
  const cppNamespacePath: string[] = [];
  const cppNamespacePathByMap = new WeakMap<Map<string, Binding>, string>();
  const extraBindings: Binding[] = [];
  const cppQualifiedMemberBindings = new Map<string, Binding[]>();
  const cppQualifiedMemberOccurrences = new Map<
    string,
    Array<{ node: SyntaxNodeLike; range: Range; fallback?: Binding }>
  >();
  const cppFunctionCollisionGroups = new Set<Binding[]>();
  const cppFunctionOccurrences: Array<{ binding: Binding; node: SyntaxNodeLike; range: Range }> = [];
  // Retain imported C tag forwards only when a later same-file declaration completes the tag.
  let cImportedForwardTags: Map<Binding, Binding> | undefined;
  const extraBindingSpans = new Set<string>();
  const bindingSpanKey = (binding: Binding): string => {
    const start = binding.def?.start.index;
    const end = binding.def?.end.index;
    return `${binding.canonicalName}:${start ?? ""}:${end ?? ""}`;
  };
  const preserveExtraBinding = (binding: Binding): void => {
    const key = bindingSpanKey(binding);
    if (extraBindingSpans.has(key)) return;
    extraBindingSpans.add(key);
    extraBindings.push(binding);
  };
  /**
   * Name nodes already registered before their construct's own scope was pushed. Keyed by source
   * span rather than `node.id`, which the projected tree leaves optional.
   */
  const preRegisteredNameSpans = new Set<string>();
  const nameSpanKey = (node: SyntaxNodeLike): string => `${node.startIndex}:${node.endIndex}`;

  const normalizeIdentifier = support.normalizeIdentifier;
  const row = scopeNodesFor(support.id);
  const bindingRules = row.bindingRules;
  const receiverProperty = bindingRules?.receiverProperty;
  const implicitReceiverName = bindingRules?.implicitReceiverName;
  const variablePrefix = bindingRules?.variablePrefix ?? "";
  const promotedBindings = bindingRules?.promotedBindings;
  const callableIdentityPolicy = callableIdentityPolicyFor(support.id);
  const callableKeyShape = callableIdentityPolicy.keyShape;
  const callableDeclarationParameters = callableIdentityPolicy.declarationParameters;
  const indexedCallables = opts?.locals ? new Map<string, SymbolDef["callable"]>() : undefined;
  if (indexedCallables && opts?.locals) {
    for (const local of opts.locals) {
      if (local.kind === SymbolKind.Function && local.callable) {
        indexedCallables.set(`${local.range.start.index}:${local.range.end.index}`, local.callable);
      }
    }
  }
  const buildBinding = (nameNode: SyntaxNodeLike, kind: BindingKind, generated?: GeneratedMember): Binding => {
    const name = generated?.name ?? sliceText(nameNode, source);
    const def = toRange(nameNode);
    let callable: Binding["callable"];
    if (generated) {
      callable = callableIdentityForGeneratedMember({ file, name, range: def, arity: generated.arity });
    } else if (kind === "function") {
      callable =
        indexedCallables?.get(`${nameNode.startIndex}:${nameNode.endIndex}`) ??
        callableIdentityForDeclaration(
          { file, name, range: def, languageId: support.id, source, node: nameNode },
          callableKeyShape,
          callableDeclarationParameters,
        );
    }
    const heldModuleSpecifier = kind === "local" && jsTs ? heldModuleSpecifierForDeclaration(nameNode) : undefined;
    const binding: Binding = {
      name,
      canonicalName: scopeIdentifierKey(row, name, nameNode, normalizeIdentifier),
      kind,
      def,
      ...(callable ? { callable } : {}),
      ...(heldModuleSpecifier !== undefined ? { heldModuleSpecifier } : {}),
      node: nameNode,
      occurrences: [],
    };
    const conditionalParents = row.conditionalBindingParents;
    if (conditionalParents?.has(nameNode.parent?.type ?? "")) binding.conditionalVisibility = true;
    return binding;
  };

  const addImportBinding = (name: string, kind: BindingKind, importBinding: ImportBinding): void => {
    const binding: Binding = {
      name,
      canonicalName: normalizeIdentifier(name),
      kind,
      occurrences: [],
      import: importBinding,
    };
    const key =
      bindingRules?.usesTagNamespace && importBinding.kind === "named" && importBinding.cNamespace === "tag"
        ? cScopeName(binding.canonicalName, "tag")
        : binding.canonicalName;
    rootScope.map.set(key, binding);
  };

  for (const imp of imports) {
    if (imp.kind === "default") {
      addImportBinding(imp.local, "importDefault", imp);
    }
    if (imp.kind === "named") {
      addImportBinding(imp.local, "importNamed", imp);
    }
    if (imp.kind === "namespace") {
      addImportBinding(imp.localNS, "namespace", imp);
    }
  }

  const checksParseErrors =
    row.referenceVerificationRequiresParseError &&
    (!(tree instanceof ProjectedSyntaxTree) || tree.columns.kinds.includes("ERROR"));
  let errorRanges: readonly ParseErrorRange[] | undefined;
  if (checksParseErrors) {
    errorRanges = opts?.parseErrorRanges;
    if (!errorRanges && tree instanceof ProjectedSyntaxTree) errorRanges = collectParseErrorRanges(tree);
  }
  const referenceNeedsVerification =
    row.referenceVerificationRequiresParseError && !errorRanges?.length ? undefined : row.referenceNeedsVerification;
  const jsTs = isJsTsLanguage(support.id);
  const generatedMembers = generatedMembersIn(support, source);
  /** Covering-declaration names collected before a scope's body is walked, keyed by syntax node id. */
  const pendingNamesByNodeId = new Map<number, Set<string>>();
  /**
   * JS and TS record let/const/class/type names during the existing hoist walk. A use defers only
   * when one of those names is still ahead, so the queue stays the forward references.
   */
  const tracksLexicalNames = !!(row.hoistedFunctionTypes || row.hoistedVariableDeclarationTypes);
  const canDeferForward =
    !tracksLexicalNames &&
    (!!row.wholeScopeKinds?.size ||
      !!row.wholeScopeDeclarationTypes?.size ||
      !!row.variableTargetScopeKinds?.size ||
      !!row.laterLocalBlocksOuterKinds?.size ||
      !!row.moduleBindingsAtFunctionRuntime);
  const nodeById = (id: number): SyntaxNodeLike | undefined =>
    tree instanceof ProjectedSyntaxTree ? tree.nodeById(id) : undefined;
  const attachPendingNames = (scope: Scope): void => {
    const nodeId = scope.node.id;
    if (nodeId === undefined) return;
    const names = pendingNamesByNodeId.get(nodeId);
    if (names && names.size > 0) scope.pendingCoveringNames = names;
  };
  const idSet = new Set([...support.nodeTypes.identifier, ...(support.nodeTypes.shorthandPropertyIdentifier ?? [])]);
  const scopeDeclarationNames = support.scopeDeclarationNames;
  const typeOnlyUseTypes = row.typeOnlyUseTypes;
  const typeOnlyParentTypes = row.typeOnlyParentTypes;
  let isTypeOnlyUse: (node: SyntaxNodeLike) => boolean;
  if (typeOnlyUseTypes) {
    isTypeOnlyUse = (node) => typeOnlyUseTypes.has(node.type);
  } else if (row.typeOnlyName) {
    isTypeOnlyUse = row.typeOnlyName;
  } else if (typeOnlyParentTypes) {
    isTypeOnlyUse = (node) => {
      const parent = node.parent;
      return !!parent && typeOnlyParentTypes.has(parent.type);
    };
  } else {
    isTypeOnlyUse = () => false;
  }

  const isParamNode = (node: SyntaxNodeLike): boolean => {
    let current: SyntaxNodeLike | null = node.parent;
    while (current) {
      if (row.parameterParents?.has(current.type)) return true;
      current = current.parent;
    }
    return false;
  };

  const declarationCoversScope = (nameNode: SyntaxNodeLike): boolean => {
    const types = row.wholeScopeDeclarationTypes;
    const memberTypes = row.wholeScopeMemberDeclarationTypes;
    if (!types && !memberTypes) return false;
    let current: SyntaxNodeLike | null = nameNode.parent;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const functionScope = support.createsFunctionScope(current);
      if (functionScope) {
        const declaredName = current.childForFieldName("name");
        if (
          !declaredName ||
          declaredName.startIndex !== nameNode.startIndex ||
          declaredName.endIndex !== nameNode.endIndex
        )
          break;
      }
      if (types?.has(current.type)) return true;
      if (memberTypes?.has(current.type) && current.parent && row.memberContainerTypes?.has(current.parent.type)) {
        return true;
      }
      if (current.type === "variable_declarator" && current.parent && types?.has(current.parent.type)) return true;
      // A local inside a function is not the function's own declaration.
      if (functionScope || support.createsBlockScope(current)) break;
      current = current.parent;
    }
    return false;
  };

  const stealCoveredOccurrences = (target: Scope, binding: Binding, key: string): void => {
    if (!binding.coversEnclosingScope) return;
    const sources: Binding[] = [];
    const pushChain = (found: Binding | undefined): void => {
      let current = found;
      while (current && current !== binding) {
        sources.push(current);
        current = current.earlierSameScope;
      }
    };
    // A same-scope redeclaration keeps its own uses. Only an outer binding can be shadowed.
    let parent = target.parent;
    while (parent) {
      const found = parent.map.get(key);
      if (found) {
        pushChain(found);
        break;
      }
      parent = parent.parent;
    }
    const start = target.node.startIndex;
    const end = target.node.endIndex;
    const seen = new Set<Range[]>();
    for (const source of sources) {
      if (seen.has(source.occurrences)) continue;
      seen.add(source.occurrences);
      const occurrences = source.occurrences;
      let write = 0;
      let moved = 0;
      for (let index = 0; index < occurrences.length; index += 1) {
        const occurrence = occurrences[index]!;
        const occurrenceStart = occurrence.start.index;
        const occurrenceEnd = occurrence.end.index;
        if (
          occurrenceStart !== undefined &&
          occurrenceEnd !== undefined &&
          occurrenceStart >= start &&
          occurrenceEnd <= end
        ) {
          binding.occurrences.push(occurrence);
          moved += 1;
        } else {
          occurrences[write++] = occurrence;
        }
      }
      if (moved > 0) occurrences.length = write;
    }
  };

  const addBinding = (
    target: Scope,
    nameNode: SyntaxNodeLike,
    kind: BindingKind,
    generated?: GeneratedMember,
  ): void => {
    const binding = buildBinding(nameNode, kind, generated);
    const owner = generated ? nearestMemberContainer(nameNode) : null;
    if (owner) binding.generatedOwner = owner;
    if (row.wholeScopeKinds?.has(target.kind) || declarationCoversScope(nameNode)) {
      binding.coversEnclosingScope = true;
    }
    const tagRole = bindingRules?.usesTagNamespace ? cTagRole(nameNode) : undefined;
    const key = tagRole ? cScopeName(binding.canonicalName, "tag") : binding.canonicalName;
    if (tagRole === "reference") {
      const visible = lookup(binding.name, nameNode);
      if (visible) {
        visible.occurrences.push(binding.def!);
        return;
      }
    }
    const existing = target.map.get(key);
    if (tagRole === "forward" && existing?.import) {
      existing.occurrences.push(binding.def!);
      cImportedForwardTags ??= new Map();
      if (!cImportedForwardTags.has(existing)) cImportedForwardTags.set(existing, binding);
      return;
    }
    if (tagRole === "declaration" && existing?.import) {
      binding.occurrences = existing.occurrences;
      const forward = cImportedForwardTags?.get(existing);
      if (forward) {
        forward.occurrences = binding.occurrences;
        binding.earlierSameScope = forward;
      }
      binding.occurrences.push(binding.def!);
      preserveExtraBinding(existing);
    }
    if (tagRole && existing?.def) {
      if (existing.def.start.index === binding.def?.start.index) return;
      binding.occurrences = existing.occurrences;
      if (tagRole === "declaration" && existing.node && cTagRole(existing.node) !== "declaration") {
        binding.occurrences.push(existing.def);
        preserveExtraBinding(existing);
        // The forward tag remains visible from its declaration until this completion.
        binding.earlierSameScope = existing;
        target.map.set(key, binding);
        return;
      }
      binding.occurrences.push(binding.def!);
      preserveExtraBinding(binding);
      return;
    }
    if (kind === "function" && existing?.kind === "function") {
      if (bindingRules?.functionRedeclarations === "shared-occurrences") {
        // C prototypes and their definitions are declarations of one function. Keep each
        // declaration addressable while sharing the occurrence list collected for that name.
        binding.occurrences = existing.occurrences;
        preserveExtraBinding(binding);
        return;
      }
      if (bindingRules?.functionRedeclarations === "overload-group") {
        const collisions = existing.sameScopeFunctionBindings ?? [existing];
        collisions.push(binding);
        for (const collision of collisions) collision.sameScopeFunctionBindings = collisions;
        cppFunctionCollisionGroups.add(collisions);
        preserveExtraBinding(existing);
      }
      if (bindingRules?.functionRedeclarations === "signature-group") {
        const candidates = existing.sameScopeFunctionBindings ?? [existing];
        const collisions = typescriptCallableCandidatesInContainer(
          candidates,
          (candidate) => candidate.callable,
          binding.callable?.key,
        );
        if (collisions.includes(existing)) {
          let grouped: Binding[] = candidates;
          if (collisions !== candidates) grouped = [...collisions];
          grouped.push(binding);
          for (const collision of grouped) collision.sameScopeFunctionBindings = grouped;
          const existingRole = existing.callable?.role ?? "other";
          const nextRole = binding.callable?.role ?? "other";
          if (existingRole === "implementation" && nextRole === "signature") {
            preserveExtraBinding(binding);
            return;
          }
          if (existingRole === "signature" && nextRole === "implementation") {
            preserveExtraBinding(existing);
          } else if (existingRole === "signature" && nextRole === "signature") {
            preserveExtraBinding(binding);
            return;
          }
        }
      }
    }
    const sameSpan =
      !!existing?.def &&
      !!binding.def &&
      existing.def.start.index === binding.def.start.index &&
      existing.def.end.index === binding.def.end.index;
    // Pattern walks can register one name node twice. A second pass with a different kind is the
    // real classification (`module` is pre-registered as a class, then as a type) and replaces it.
    if (sameSpan && existing?.kind === kind) return;
    // A second local in a whole-scope scope is the same binding (Python assignments). Keep the
    // first declaration and record the later one as an occurrence so an earlier use does not get
    // attached only to the textually last declaration.
    if (
      !sameSpan &&
      existing &&
      kind === "local" &&
      existing.kind === "local" &&
      !tagRole &&
      !!row.variableTargetScopeKinds &&
      row.wholeScopeKinds?.has(target.kind)
    ) {
      if (binding.def) existing.occurrences.push(binding.def);
      return;
    }
    // Preserving an overload as an extra binding must not hide it from earlier C++ uses.
    if (
      !sameSpan &&
      existing &&
      (!extraBindingSpans.has(bindingSpanKey(existing)) ||
        (bindingRules?.functionRedeclarations === "overload-group" &&
          kind === "function" &&
          existing.kind === "function"))
    ) {
      binding.earlierSameScope = existing;
    }
    target.map.set(key, binding);
    if (binding.coversEnclosingScope) target.pendingCoveringNames?.delete(binding.canonicalName);
    if (!tracksLexicalNames) stealCoveredOccurrences(target, binding, key);
    const cppNamespace = cppNamespacePathByMap.get(target.map);
    if (bindingRules?.qualifiedFunctionNames && kind === "function" && cppNamespace) {
      const qualifiedKey = `${cppNamespace}::${binding.name}`;
      const qualifiedBindings = cppQualifiedMemberBindings.get(qualifiedKey) ?? [];
      qualifiedBindings.push(binding);
      cppQualifiedMemberBindings.set(qualifiedKey, qualifiedBindings);
    }
  };

  /**
   * The scope a declaration that is not a local variable binds in. The body of a Ruby class or module holds only its
   * own locals, so its methods, classes, and constants bind in the scope outside it, as they did before the body had a
   * scope of its own.
   */
  const nonLocalDeclarationScope = (name: SyntaxNodeLike): Scope | undefined => {
    const localOnly = row.localOnlyScopeTypes;
    const declarationOutsideScope = row.declarationOutsideScope;
    if (!localOnly && !declarationOutsideScope) return stack[stack.length - 1];
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const scope = stack[index]!;
      if (localOnly?.has(scope.node.type) || declarationOutsideScope?.(name, scope.node)) continue;
      return scope;
    }
    return rootScope;
  };

  const addDecl = (nameNode: SyntaxNodeLike, kind: BindingKind, generated?: GeneratedMember): void => {
    const target = nonLocalDeclarationScope(nameNode);
    if (target) addBinding(target, nameNode, kind, generated);
  };

  const addHoistedDecl = (nameNode: SyntaxNodeLike, kind: BindingKind): void => {
    const target = [...stack].reverse().find((scope) => scope.kind === "function") ?? rootScope;
    const canonicalName = normalizeIdentifier(sliceText(nameNode, source));
    if (!target.map.has(canonicalName)) addBinding(target, nameNode, kind);
  };

  // Field-like declarations reached through the generic `scopeDeclarationNames`
  // hook (below) must land in the type's *enclosing* scope, not inside the
  // dedicated "type" scope a `typeScopeTypes` node pushes for isolating its own
  // type parameter: Go struct fields are accessed through a receiver from
  // anywhere in the file, unlike a type parameter, which is scoped to its own
  // declaration.
  const variableDeclarationScope = (): Scope => {
    const current = stack[stack.length - 1] ?? rootScope;
    const targetKinds = row.variableTargetScopeKinds;
    if (!targetKinds) return current;
    const boundary = row.variableScopeBoundaryTypes;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const scope = stack[index]!;
      if (boundary) {
        const parentType = scope.node.parent?.type;
        if (boundary.has(scope.node.type) || (parentType !== undefined && boundary.has(parentType))) return scope;
      }
      if (targetKinds.has(scope.kind)) return scope;
    }
    return current;
  };

  const addVariableDecl = (nameNode: SyntaxNodeLike, kind: BindingKind): void => {
    addBinding(variableDeclarationScope(), nameNode, kind);
  };

  const addDeclSkippingTypeScope = (nameNode: SyntaxNodeLike, kind: BindingKind): void => {
    if (kind === "local" && row.variableTargetScopeKinds) {
      addVariableDecl(nameNode, kind);
      return;
    }
    const target =
      [...stack]
        .reverse()
        .find(
          (scope) =>
            scope.kind !== "type" &&
            !row.localOnlyScopeTypes?.has(scope.node.type) &&
            !row.declarationOutsideScope?.(nameNode, scope.node),
        ) ?? rootScope;
    addBinding(target, nameNode, kind);
  };

  const lookup = (name: string, node?: SyntaxNodeLike): Binding | undefined => {
    const normalizedName = node ? scopeIdentifierKey(row, name, node, normalizeIdentifier) : normalizeIdentifier(name);
    const canonicalName =
      bindingRules?.usesTagNamespace && node && cTagRole(node) ? cScopeName(normalizedName, "tag") : normalizedName;
    const methodCall = !!node && isExplicitMethodCall(row, node);
    const typeOnly = !!node && isTypeOnlyUse(node);
    // A gate between the use and a scope hides that scope's local variables.
    let crossedGate = false;
    for (let index = stack.length - 1; index >= 0; index--) {
      const scope = stack[index]!;
      if (scopeIsEmptyBody(scope)) {
        crossedGate = true;
        continue;
      }
      if (node && !scopeAllowsUse(row, scope, node)) continue;
      let hit = scope.map.get(canonicalName);
      if (node && row.moduleBindingsAtFunctionRuntime) {
        while (hit?.kind === "function" && pythonFunctionPendingInDefault(hit.def?.start.index, node)) {
          hit = hit.earlierSameScope;
        }
      }
      while (hit) {
        if (!bindingHiddenFromUse(row, hit, node, methodCall, typeOnly, crossedGate, normalizeIdentifier)) break;
        hit = hit.earlierSameScope;
      }
      if (hit) return hit;
      if (
        node &&
        !typeOnly &&
        row.moduleBindingsAtFunctionRuntime &&
        laterLocalBlocksOuterUse(row, scope, canonicalName, node.startIndex, normalizeIdentifier, node)
      ) {
        return undefined;
      }
      if (scopeIsLocalGate(scope)) crossedGate = true;
    }
    let root = rootScope.map.get(canonicalName);
    if (node && row.moduleBindingsAtFunctionRuntime) {
      while (root?.kind === "function" && pythonFunctionPendingInDefault(root.def?.start.index, node)) {
        root = root.earlierSameScope;
      }
    }
    while (root) {
      if (!bindingHiddenFromUse(row, root, node, methodCall, typeOnly, crossedGate, normalizeIdentifier)) break;
      root = root.earlierSameScope;
    }
    return root;
  };

  const lookupOutsideFunctions = (name: string): Binding | undefined => {
    const canonicalName = `${variablePrefix}${normalizeIdentifier(name)}`;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const scope = stack[index]!;
      if (scope.kind === "function") continue;
      const hit = scope.map.get(canonicalName);
      if (hit) return hit;
    }
    return rootScope.map.get(canonicalName);
  };

  const isImplicitReceiverPropertyName = (nameNode: SyntaxNodeLike): boolean => {
    if (!receiverProperty) return false;
    const parent = nameNode.parent;
    if (!parent || parent.type !== receiverProperty.accessType) return false;
    const property =
      parent.childForFieldName(receiverProperty.nameField) ??
      parent.namedChildren.find((child) => child.type === receiverProperty.fallbackNameType) ??
      null;
    if (!property || property.startIndex !== nameNode.startIndex || property.endIndex !== nameNode.endIndex) {
      return false;
    }
    const object = parent.childForFieldName(receiverProperty.receiverField) ?? parent.namedChildren[0] ?? null;
    if (!object || object.startIndex === property.startIndex) return false;
    return sliceText(object, source) === implicitReceiverName;
  };

  /** The default-value expression of a pattern node: a read of an enclosing name, never a name the pattern binds. */
  const patternDefaultValue = (pattern: SyntaxNodeLike): SyntaxNodeLike | null => {
    const field = row.patternDefaultValueFields?.[pattern.type];
    return field ? pattern.childForFieldName(field) : null;
  };

  /** The node that lists a declaration's type parameters, or null when the language row names no such field. */
  const typeParameterList = (declaration: SyntaxNodeLike): SyntaxNodeLike | null => {
    const field = row.typeParameterListField;
    return field ? declaration.childForFieldName(field) : null;
  };

  /**
   * Whether a declaration opens a scope for its type parameters. A row that names the list field only scopes a
   * declaration that has such a list, so a non-generic one adds no scope.
   */
  const opensTypeScope = (declaration: SyntaxNodeLike, declarationType: string): boolean => {
    if (!row.typeScopeTypes?.has(declarationType)) return false;
    return !row.typeParameterListField || !!typeParameterList(declaration);
  };

  /**
   * Declares a declaration's type parameters as the scope it opens begins. A function's parameters are read before its
   * type-parameter list is walked, and a constraint can name a parameter that comes after it.
   */
  const declareTypeParameters = (declaration: SyntaxNodeLike): void => {
    const list = typeParameterList(declaration);
    for (const parameter of list?.namedChildren ?? []) {
      if (!row.typeParameterTypes?.has(parameter.type)) continue;
      for (const name of declaredNameNodes(parameter)) {
        addDecl(name, "type");
        preRegisteredNameSpans.add(nameSpanKey(name));
      }
    }
  };

  const addPatternDecls = (
    pattern: SyntaxNodeLike,
    kind: BindingKind,
    addBindingToScope: (nameNode: SyntaxNodeLike, kind: BindingKind) => void = addDecl,
  ): void => {
    if (pattern.type === "property_promotion_parameter" && phpConstructorPromotedVariable(pattern, source)) {
      return;
    }
    if (idSet.has(pattern.type)) {
      if (!row.acceptLocalCapture || row.acceptLocalCapture(pattern)) addBindingToScope(pattern, kind);
      return;
    }
    // The names inside a parameter list are registered here and the list itself is not walked afterwards, so the reads
    // in a pattern (a type annotation or a default value) are walked here. A variable declaration is walked later.
    const defaultNode = patternDefaultValue(pattern);
    // Parameter type and default-value fields are reads, not additional bound names.
    if (row.destructuringTypeFieldTypes?.has(pattern.type)) {
      const nameNode = pattern.childForFieldName("name");
      if (nameNode && bindingRules?.nameOnlyPatternTypes?.has(pattern.type)) {
        addPatternDecls(nameNode, kind, addBindingToScope);
        // C# defaults have no value field: every named child other than the name is a read.
        const functionScope = kind === "param" ? stack.pop() : undefined;
        for (const child of pattern.namedChildren) {
          if (child.id !== nameNode.id) walk(child);
        }
        if (functionScope) stack.push(functionScope);
        return;
      }
      const typeNode = pattern.childForFieldName("type");
      const typeIsBinding = !!typeNode && typeNode.type === row.destructuringTypeFieldBindingTypes?.[pattern.type];
      const readsEagerDefault = kind === "param" && !!row.moduleBindingsAtFunctionRuntime;
      const valueNode = readsEagerDefault ? pattern.childForFieldName("value") : null;
      for (const child of pattern.namedChildren) {
        if (typeNode && !typeIsBinding && child.id === typeNode.id) continue;
        if (valueNode && child.id === valueNode.id) continue;
        if (defaultNode && child.id === defaultNode.id) continue;
        addPatternDecls(child, kind, addBindingToScope);
      }
      if (typeNode && !typeIsBinding) walk(typeNode);
      if (defaultNode && kind === "param") walk(defaultNode);
      if (valueNode) {
        // Python defaults execute in the enclosing scope, before the function is bound.
        const functionScope = stack.pop();
        walk(valueNode);
        if (functionScope) stack.push(functionScope);
      }
      return;
    }
    if (row.destructuringPairPatternTypes?.has(pattern.type)) {
      const value = pattern.childForFieldName("value");
      if (value) {
        addPatternDecls(value, kind, addBindingToScope);
      }
      return;
    }
    for (const child of pattern.namedChildren) {
      if (defaultNode && child.id === defaultNode.id) continue;
      addPatternDecls(child, kind, addBindingToScope);
    }
    if (defaultNode && kind === "param") walk(defaultNode);
  };

  const isAwaitedDynamicImport = (node: SyntaxNodeLike | null): boolean => {
    if (!node || node.type !== "await_expression") return false;
    const call = node.namedChildren.find((child) => child.type === "call_expression");
    if (!call) return false;
    const callee = call.childForFieldName("function") ?? call.child(0);
    return callee?.type === "import";
  };

  const isStaticRequireCall = (node: SyntaxNodeLike | null): boolean => {
    const requireCall = row.requireCall;
    if (!node || !requireCall?.callTypes.has(node.type)) return false;
    const callee = node.childForFieldName("function") ?? node.childForFieldName("callee") ?? node.child(0);
    if (!callee || !requireCall.calleeNames.has(sliceText(callee, source))) return false;
    const args = node.childForFieldName("arguments");
    return !!args && requireCall.argumentsPattern.test(sliceText(args, source));
  };

  const moduleSpecifierFromCall = (call: SyntaxNodeLike | null): string | null => {
    const args = call?.childForFieldName("arguments");
    if (args?.namedChildren.length !== 1) return null;
    const literal = args.namedChildren[0];
    if (literal?.type !== "string" || literal.namedChildren.length !== 1) return null;
    const fragment = literal.namedChildren[0];
    return fragment?.type === "string_fragment" ? sliceText(fragment, source) : null;
  };

  const moduleSpecifierFromValue = (value: SyntaxNodeLike | null): string | null => {
    let current = value;
    while (current?.type === "parenthesized_expression") current = current.namedChildren[0] ?? null;
    if (isAwaitedDynamicImport(current)) {
      const call = current!.namedChildren.find((child) => child.type === "call_expression") ?? null;
      return moduleSpecifierFromCall(call);
    }
    return isStaticRequireCall(current) ? moduleSpecifierFromCall(current) : null;
  };

  const heldModuleSpecifierForDeclaration = (nameNode: SyntaxNodeLike): string | null | undefined => {
    const declaration = nameNode.parent;
    const declaredName = declaration?.childForFieldName("name");
    if (declaration?.type !== "variable_declarator" || declaredName?.startIndex !== nameNode.startIndex) {
      return undefined;
    }
    const annotation = declaration.childForFieldName("type");
    const query = annotation ? typescriptImportTypeQuery(annotation) : null;
    const typedSpecifier = query ? importTypeQuerySpecifier(query) : null;
    const value = declaration.childForFieldName("value");
    if (!value) return typedSpecifier ?? undefined;
    const initializedSpecifier = moduleSpecifierFromValue(value);
    if (!initializedSpecifier || (typedSpecifier && typedSpecifier !== initializedSpecifier)) return null;
    return initializedSpecifier;
  };
  const hasImportBinding = (nameNode: SyntaxNodeLike): boolean => {
    const name = normalizeIdentifier(sliceText(nameNode, source));
    const binding = rootScope.map.get(name);
    return (
      !!binding && (binding.kind === "importDefault" || binding.kind === "importNamed" || binding.kind === "namespace")
    );
  };

  const isScopedEnumeratorName = (node: SyntaxNodeLike): boolean => {
    const scopedEnum = row.scopedEnum;
    if (!scopedEnum || !node.parent || !row.enumMemberTypes?.has(node.parent.type)) return false;
    let current = node.parent.parent;
    while (current) {
      if (scopedEnum.enumDeclarationTypes.has(current.type)) {
        return scopedEnum.scopedKeywordPattern.test(sliceText(current, source));
      }
      current = current.parent;
    }
    return false;
  };

  const addUnsupportedRequirePatternDecls = (
    pattern: SyntaxNodeLike,
    addBindingToScope: (nameNode: SyntaxNodeLike, kind: BindingKind) => void = addDecl,
  ): void => {
    if (idSet.has(pattern.type)) {
      if (!hasImportBinding(pattern)) addPatternDecls(pattern, "local", addBindingToScope);
      return;
    }
    if (!row.destructuringObjectPatternTypes?.has(pattern.type)) {
      addPatternDecls(pattern, "local", addBindingToScope);
      return;
    }
    for (const child of pattern.namedChildren) {
      if (row.destructuringShorthandTypes?.has(child.type)) {
        if (!hasImportBinding(child)) addPatternDecls(child, "local", addBindingToScope);
        continue;
      }
      if (row.destructuringPairPatternTypes?.has(child.type)) {
        const value = child.childForFieldName("value");
        if (value && idSet.has(value.type) && hasImportBinding(value)) {
          continue;
        }
        if (value) {
          addPatternDecls(value, "local", addBindingToScope);
        }
        continue;
      }
      addPatternDecls(child, "local", addBindingToScope);
    }
  };

  const addVariableDeclarations = (
    node: SyntaxNodeLike,
    addBindingToScope: (nameNode: SyntaxNodeLike, kind: BindingKind) => void = addDecl,
  ): void => {
    if (row.shortVariableDeclarationTypes?.has(node.type)) {
      const left = node.childForFieldName("left");
      if (left) addPatternDecls(left, "local", addBindingToScope);
      return;
    }
    const nameless = row.namelessVariableDeclaration;
    if (nameless?.declarationTypes.has(node.type)) {
      // Zig's grammar has no name field. The first identifier is the declaration;
      // later identifiers belong to the initializer. Keep an @import declaration's
      // existing namespace binding because it carries the resolved target.
      const name = node.namedChildren.find((child) => idSet.has(child.type));
      const isImportDeclaration =
        name !== undefined && hasImportBinding(name) && nameless.importCallPattern.test(sliceText(node, source));
      if (name && !isImportDeclaration) addBindingToScope(name, "local");
      return;
    }
    for (const child of node.namedChildren) {
      if (row.variableDeclaratorTypes?.has(child.type)) {
        const name = child.childForFieldName("name");
        const value = child.childForFieldName("value");
        if (name) {
          if (isStaticRequireCall(value) || isAwaitedDynamicImport(value)) {
            addUnsupportedRequirePatternDecls(name, addBindingToScope);
          } else addPatternDecls(name, "local", addBindingToScope);
        }
      } else if (row.assignmentIdentifierTypes?.has(child.type) && row.assignmentDeclarationTypes?.has(node.type)) {
        const left = node.childForFieldName("left");
        // `y = x` names both identifiers. Only the left-hand side declares; the right-hand side
        // is a use and must not become a same-scope binding that hides the real declaration.
        if (left && (left.startIndex !== child.startIndex || left.endIndex !== child.endIndex)) continue;
        addBindingToScope(child, "local");
      } else if (row.patternBindingTypes?.has(node.type)) {
        const pattern = node.childForFieldName("pattern") || node.childForFieldName("name");
        if (pattern) addPatternDecls(pattern, "local", addBindingToScope);
      }
    }
  };

  const rememberPatternNames = (pattern: SyntaxNodeLike, names: Set<string>): void => {
    if (idSet.has(pattern.type)) {
      names.add(normalizeIdentifier(sliceText(pattern, source)));
      return;
    }
    const defaultNode = patternDefaultValue(pattern);
    if (row.destructuringTypeFieldTypes?.has(pattern.type)) {
      const typeNode = pattern.childForFieldName("type");
      const typeIsBinding = !!typeNode && typeNode.type === row.destructuringTypeFieldBindingTypes?.[pattern.type];
      for (const child of pattern.namedChildren) {
        if (typeNode && !typeIsBinding) {
          const sameTypeField = child.startIndex === typeNode.startIndex && child.endIndex === typeNode.endIndex;
          if (sameTypeField) continue;
        }
        if (defaultNode && child.id === defaultNode.id) continue;
        rememberPatternNames(child, names);
      }
      return;
    }
    if (row.destructuringPairPatternTypes?.has(pattern.type)) {
      const value = pattern.childForFieldName("value");
      if (value) rememberPatternNames(value, names);
      return;
    }
    for (const child of pattern.namedChildren) {
      if (defaultNode && child.id === defaultNode.id) continue;
      rememberPatternNames(child, names);
    }
  };

  const rememberLexicalNames = (declaration: SyntaxNodeLike, names: Set<string>): void => {
    for (const child of declaration.namedChildren) {
      if (!row.variableDeclaratorTypes?.has(child.type)) continue;
      const name = child.childForFieldName("name");
      if (name) rememberPatternNames(name, names);
    }
  };

  const collectHoistedDeclarations = (scopeNode: SyntaxNodeLike): void => {
    if (!row.hoistedFunctionTypes && !row.hoistedVariableDeclarationTypes) return;

    let pending: Set<string> | undefined;
    const ensurePending = (): Set<string> => {
      if (!pending) {
        pending = new Set();
        if (scopeNode.id !== undefined) pendingNamesByNodeId.set(scopeNode.id, pending);
      }
      return pending;
    };
    const addPending = (nameNode: SyntaxNodeLike): void => {
      ensurePending().add(normalizeIdentifier(sliceText(nameNode, source)));
    };

    const visit = (node: SyntaxNodeLike): void => {
      if (node !== scopeNode && support.createsFunctionScope(node)) {
        if (row.hoistedFunctionTypes?.has(node.type)) {
          const name = node.childForFieldName("name");
          if (name) addHoistedDecl(name, "function");
        }
        return;
      }
      // A declaration that opens only a type scope names its type parameters there; its own name, and anything its body
      // declares, still belong to the scope being collected.
      if (node !== scopeNode && !row.moduleRootTypes?.has(node.type) && support.createsBlockScope(node)) {
        collectHoistedDeclarations(node);
        return;
      }
      if (row.hoistedVariableDeclarationTypes?.has(node.type)) {
        addVariableDeclarations(node, addHoistedDecl);
      } else if (row.variableDeclarationTypes?.has(node.type)) {
        rememberLexicalNames(node, ensurePending());
      }
      if (row.classNameTypes?.has(node.type) || row.typeNameTypes?.has(node.type)) {
        const name = node.childForFieldName("name");
        if (name) addPending(name);
      }
      if (row.enumAssignmentTypes?.has(node.type)) {
        const name = node.childForFieldName("name");
        if (name) addPending(name);
      } else if (
        row.enumBodyMemberTypes?.has(node.type) &&
        node.parent &&
        row.enumBodyParentTypes?.has(node.parent.type)
      ) {
        addPending(node);
      }
      if (idSet.has(node.type) && scopeDeclarationNames(node)) addPending(node);
      for (const child of node.namedChildren) visit(child);
    };

    for (const child of scopeNode.namedChildren) visit(child);
  };

  const isMemberFunction = (node: SyntaxNodeLike): boolean => {
    if (row.memberFunctionTypes?.has(node.type)) {
      return true;
    }
    let current = node.parent;
    while (current) {
      if (row.memberContainerTypes?.has(current.type)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const canonicalUseName = (name: string, node: SyntaxNodeLike): string => {
    const normalized = scopeIdentifierKey(row, name, node, normalizeIdentifier);
    if (receiverProperty && isImplicitReceiverPropertyName(node)) return `${variablePrefix}${normalized}`;
    return bindingRules?.usesTagNamespace && cTagRole(node) ? cScopeName(normalized, "tag") : normalized;
  };

  const scopeOwnsBinding = (scope: Scope, canonical: string, binding: Binding): boolean => {
    let current = scope.map.get(canonical);
    while (current) {
      if (current === binding) return true;
      current = current.earlierSameScope;
    }
    return false;
  };

  const deferToScope = (
    canonical: string,
    binding: Binding | undefined,
    useNode: SyntaxNodeLike,
  ): Scope | undefined => {
    if (row.variableTargetScopeKinds) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const scope = stack[index]!;
        if (
          !binding &&
          row.moduleBindingsAtFunctionRuntime &&
          laterLocalBlocksOuterUse(row, scope, canonical, useNode.startIndex, normalizeIdentifier, useNode)
        ) {
          return undefined;
        }
        if (binding && scopeOwnsBinding(scope, canonical, binding)) return undefined;
        if (row.variableTargetScopeKinds.has(scope.kind)) return scope;
      }
    }
    if (row.laterLocalBlocksOuterKinds) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const scope = stack[index]!;
        if (binding && scopeOwnsBinding(scope, canonical, binding)) return undefined;
        if (row.laterLocalBlocksOuterKinds.has(scope.kind)) return scope;
      }
    }
    if (tracksLexicalNames) {
      const current = stack[stack.length - 1] ?? rootScope;
      // A covering declaration still ahead in this scope shadows an outer binding (TDZ, hoisting).
      if (current.pendingCoveringNames?.has(canonical)) return current;
      if (binding && current.map.get(canonical) === binding) return undefined;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const scope = stack[index]!;
        if (binding && scopeOwnsBinding(scope, canonical, binding)) return undefined;
        if (scope.pendingCoveringNames?.has(canonical)) return scope;
      }
      return undefined;
    }
    if (!binding && canDeferForward) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const scope = stack[index]!;
        if (scopeCanGainCoveringBinding(scope)) return scope;
      }
    }
    return undefined;
  };

  const scopeCanGainCoveringBinding = (scope: Scope): boolean =>
    !!row.wholeScopeKinds?.has(scope.kind) ||
    !!row.variableTargetScopeKinds?.has(scope.kind) ||
    !!row.laterLocalBlocksOuterKinds?.has(scope.kind) ||
    !!row.wholeScopeDeclarationTypes?.size ||
    (scope.kind === "module" && !!row.moduleBindingsAtFunctionRuntime);

  const moduleBindingAtFunctionRuntime = (useNode: SyntaxNodeLike): boolean => {
    if (!row.moduleBindingsAtFunctionRuntime) return false;
    for (let current = useNode.parent; current; current = current.parent) {
      if (!support.createsFunctionScope(current)) continue;
      const body = current.childForFieldName("body");
      if (body && useNode.startIndex >= body.startIndex && useNode.endIndex <= body.endIndex) return true;
    }
    return false;
  };

  /** Uses that left a local scope gate while queued for a scope above it, so the locals of that scope are out of reach. */
  const gateCrossedUses = new Set<number>();

  const lookupCovering = (
    start: Scope | undefined,
    useNode: SyntaxNodeLike,
    canonical: string,
    receiverPropertyUse: boolean,
    crossedGateAtStart = false,
  ): Binding | undefined => {
    const useStart = useNode.startIndex;
    const methodCall = isExplicitMethodCall(row, useNode);
    const typeOnly = isTypeOnlyUse(useNode);
    let scope = start;
    // A gate between the use and a scope hides that scope's local variables. A use queued past its own scopes starts
    // above a gate it already left.
    let crossedGate = crossedGateAtStart;
    while (scope) {
      if (scopeIsEmptyBody(scope)) {
        crossedGate = true;
        scope = scope.parent;
        continue;
      }
      if (!scopeAllowsUse(row, scope, useNode)) {
        scope = scope.parent;
        continue;
      }
      if (!(receiverPropertyUse && scope.kind === "function")) {
        let binding = scope.map.get(canonical);
        const atModuleRuntime = scope.kind === "module" && moduleBindingAtFunctionRuntime(useNode);
        while (
          binding &&
          (bindingHiddenFromUse(row, binding, useNode, methodCall, typeOnly, crossedGate, normalizeIdentifier) ||
            (!atModuleRuntime && !bindingCoversUse(row, scope.kind, binding, useStart, useNode, support)))
        ) {
          binding = binding.earlierSameScope;
        }
        if (binding) return binding;
      }
      if (laterLocalBlocksOuterUse(row, scope, canonical, useStart, normalizeIdentifier, useNode)) return undefined;
      if (scopeIsLocalGate(scope)) crossedGate = true;
      scope = scope.parent;
    }
    return undefined;
  };

  const attachOccurrence = (binding: Binding, useNode: SyntaxNodeLike): void => {
    if (rejectsLexicalBindingAtSelector(row, binding, useNode)) return;
    if (row.nonLexicalUse?.(useNode)) return;
    if (referenceNeedsVerification?.(useNode, errorRanges)) {
      binding.occurrencesComplete = false;
      return;
    }
    const range = toRange(useNode);
    if (bindingRules?.functionRedeclarations === "overload-group" && binding.kind === "function") {
      cppFunctionOccurrences.push({ binding, node: useNode, range });
    } else {
      binding.occurrences.push(range);
    }
  };

  const queueUse = (scope: Scope, id: number): void => {
    let queued = scope.queuedUseIds;
    if (!queued) scope.queuedUseIds = queued = [];
    queued.push(id);
  };

  const closeScope = (scope: Scope): void => {
    const queued = scope.queuedUseIds;
    if (!queued) return;
    delete scope.queuedUseIds;
    let receiver: Scope | undefined;
    // Whether a gate lies between this scope and its receiver, which the queued uses leave with them.
    let skipsGate = false;
    if (!tracksLexicalNames) {
      receiver = scope.parent;
      // A class or module body holds only locals, which cover no earlier use, so a queued use climbs past it.
      while (receiver && (receiver.gate === "body" || !scopeCanGainCoveringBinding(receiver))) {
        if (scopeIsLocalGate(receiver)) skipsGate = true;
        receiver = receiver.parent;
      }
    }
    for (let index = 0; index < queued.length; index += 1) {
      const id = queued[index]!;
      const useNode = nodeById(id);
      if (!useNode) continue;
      const receiverPropertyUse = !!receiverProperty && isImplicitReceiverPropertyName(useNode);
      const canonical = canonicalUseName(sliceText(useNode, source), useNode);
      const binding = lookupCovering(scope, useNode, canonical, receiverPropertyUse, gateCrossedUses.has(id));
      if (!binding) {
        if (laterLocalBlocksOuterUse(row, scope, canonical, useNode.startIndex, normalizeIdentifier, useNode)) continue;
        if (receiver) {
          if (skipsGate || scopeIsLocalGate(scope)) gateCrossedUses.add(id);
          queueUse(receiver, id);
        }
        continue;
      }
      if (receiver && !scopeOwnsBinding(scope, canonical, binding)) {
        if (skipsGate || scopeIsLocalGate(scope)) gateCrossedUses.add(id);
        queueUse(receiver, id);
        continue;
      }
      attachOccurrence(binding, useNode);
    }
  };

  /**
   * Binds the names a type's header parameter list declares (record components, primary-constructor parameters) in the
   * type's own scope, where its header and body read them and another type cannot.
   */
  const bindHeaderParameters = (declaration: SyntaxNodeLike): void => {
    const header = row.headerParameters;
    if (!header?.declarationTypes.has(declaration.type)) return;
    const list = declaration.namedChildren.find((child) => header.listTypes.has(child.type));
    for (const parameter of list?.namedChildren ?? []) {
      // A Java varargs component (`int... values`) keeps its name in a declarator.
      const name =
        parameter.childForFieldName("name") ??
        parameter.namedChildren.find((child) => child.type === "variable_declarator")?.childForFieldName("name");
      if (!name || !idSet.has(name.type)) continue;
      if (header.leavesTypeNamedUnbound && headerParameterNamedLikeType(parameter, name, support.normalizeIdentifier)) {
        continue;
      }
      addDecl(name, "param");
      preRegisteredNameSpans.add(nameSpanKey(name));
    }
  };

  const walk = (node: SyntaxNodeLike) => {
    if (node.startIndex === node.endIndex) return;
    const nodeType = node.type;
    const parentType = node.parent?.type;
    const isIdentifierNode = idSet.has(nodeType);
    let scopedFunctionName: { node: SyntaxNodeLike; qualifiedKey: string } | null = null;
    let qualifiedNamespaceScope: Scope | undefined;
    // A name-registering node puts its name in the *current* (enclosing) scope before the push
    // below creates the node's own scope. C# local functions need that: they are callable from
    // sibling statements in the enclosing method, unlike a JS named function expression's
    // self-only visibility, which the language's `scopeDeclarationNames` hook handles instead.
    if (row.functionNameTypes?.has(nodeType)) {
      const name = declaredNameNode(node, row);
      if (name && (support.membersAreImplicitlyInScope || !isMemberFunction(node))) {
        // The declarator chain that carries a C-family function name also carries its parameter
        // list, so the child walk must still descend into it. Remember the exact name node instead
        // and skip only that node below, which keeps one binding per function without hiding
        // `function_declarator > parameter_list` from parameter registration.
        preRegisteredNameSpans.add(nameSpanKey(name));
        const qualifiedName = bindingRules?.qualifiedFunctionNames ? qualifiedCppIdentifierForName(name, node) : null;
        if (qualifiedName) {
          const qualifiedKey = cppQualifiedNameSegments(qualifiedName, source).join("::");
          const ownerKey = qualifiedKey.slice(0, qualifiedKey.lastIndexOf("::"));
          qualifiedNamespaceScope = cppNamespaceScopes.get(ownerKey);
          if (qualifiedNamespaceScope) {
            addBinding(qualifiedNamespaceScope, name, "function");
          } else {
            scopedFunctionName = { node: name, qualifiedKey };
          }
        } else if (row.hoistedFunctionTypes?.has(nodeType)) {
          addHoistedDecl(name, "function");
        } else if (parentType && bindingRules?.functionOutsideTypeScopeParents?.has(parentType)) {
          addDeclSkippingTypeScope(name, "function");
        } else {
          addDecl(name, "function");
        }
      }
    }
    // A method that a call generates (Ruby `attr_reader :name`) binds the way a `def` of that name does.
    if (generatedMembers) for (const member of generatedMembers(node)) addDecl(member.node, "function", member);
    if (row.classNameTypes?.has(nodeType)) {
      const exclusion = bindingRules?.classNameExclusion;
      let nameIsExcluded = false;
      if (exclusion) {
        const kind = node.childForFieldName(exclusion.field);
        let keyword = kind ? sliceText(kind, source).trim() : "";
        if (!keyword) {
          const first = node.child(0);
          keyword = first ? sliceText(first, source).trim() : "";
        }
        nameIsExcluded = keyword === exclusion.keyword;
      }
      if (!nameIsExcluded) {
        const name = node.childForFieldName("name");
        if (name) addDecl(name, "class");
      }
    }
    if (row.typeNameTypes?.has(nodeType)) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "type");
    }
    if (row.enumMemberTypes?.has(nodeType)) {
      const name = node.childForFieldName("name");
      if (name) {
        if (row.enumMemberLocalTypes?.has(nodeType) && !isScopedEnumeratorName(name)) addDecl(name, "local");
        else extraBindings.push(buildBinding(name, "local"));
      }
    }
    if (row.enumAssignmentTypes?.has(nodeType)) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "local");
    } else if (
      row.enumBodyMemberTypes?.has(nodeType) &&
      parentType !== undefined &&
      row.enumBodyParentTypes?.has(parentType)
    ) {
      addDecl(node, "local");
    }

    let pushed = false;
    let pushedScopeCount = 0;
    const namespacePathStart = cppNamespacePath.length;
    const cppNamespaceName =
      bindingRules?.qualifiedFunctionNames && nodeType === "namespace_definition"
        ? node.childForFieldName("name")
        : null;
    const cppNamespaceIsInline = !!cppNamespaceName && /^\s*inline\s+namespace\b/u.test(sliceText(node, source));
    const createsCppNamespaceScope = !!cppNamespaceName && !cppNamespaceIsInline;
    const createsMemberScope = !!row.memberScopeTypes?.has(nodeType);
    if (createsCppNamespaceScope) {
      const name = cppNamespaceName;
      const segments = sliceText(name, source).replace(/\s+/gu, "").split("::").filter(Boolean);
      for (const segment of segments) {
        cppNamespacePath.push(segment);
        const key = cppNamespacePath.join("::");
        const map = cppNamespaceMaps.get(key) ?? new Map<string, Binding>();
        cppNamespaceMaps.set(key, map);
        cppNamespacePathByMap.set(map, key);
        const scope: Scope = {
          kind: "block",
          map,
          node,
          parent: stack[stack.length - 1],
        };
        stack.push(scope);
        allScopes.push(scope);
        if (!cppNamespaceScopes.has(key)) cppNamespaceScopes.set(key, scope);
        pushed = true;
        pushedScopeCount += 1;
      }
    } else if (support.createsFunctionScope(node)) {
      const scope: Scope = {
        kind: "function",
        map: new Map(),
        node,
        parent: qualifiedNamespaceScope ?? stack[stack.length - 1],
      };
      if (row.localScopeGateTypes?.has(nodeType)) scope.gate = "def";
      stack.push(scope);
      allScopes.push(scope);
      pushed = true;
      pushedScopeCount = 1;
      if (scopedFunctionName) {
        addDecl(scopedFunctionName.node, "function");
        const binding = scope.map.get(normalizeIdentifier(sliceText(scopedFunctionName.node, source)));
        if (binding) {
          const bindings = cppQualifiedMemberBindings.get(scopedFunctionName.qualifiedKey) ?? [];
          bindings.push(binding);
          cppQualifiedMemberBindings.set(scopedFunctionName.qualifiedKey, bindings);
        }
      }

      declareTypeParameters(node);
      const params = node.childForFieldName("parameters");
      if (params) addPatternDecls(params, "param");
      collectHoistedDeclarations(node);
      attachPendingNames(scope);
    } else if (support.createsBlockScope(node) || createsMemberScope) {
      if (!row.moduleRootTypes?.has(nodeType)) {
        const scope: Scope = {
          kind: createsMemberScope ? "member" : "block",
          map: new Map(),
          node,
          parent: stack[stack.length - 1],
        };
        attachPendingNames(scope);
        stack.push(scope);
        allScopes.push(scope);
        pushed = true;
        pushedScopeCount = 1;
        const blockParams = node.childForFieldName("parameters");
        if (blockParams && (blockParams.type === "block_parameters" || blockParams.type === "lambda_parameters")) {
          addPatternDecls(blockParams, "param");
        }
      }
    } else if (row.localOnlyScopeTypes?.has(nodeType)) {
      // A Ruby class, module, or `class << self` body starts its own local scope.
      const scope: Scope = { kind: "block", map: new Map(), node, parent: stack[stack.length - 1] };
      if (row.localScopeGateTypes?.has(nodeType)) scope.gate = "body";
      stack.push(scope);
      allScopes.push(scope);
      pushed = true;
      pushedScopeCount = 1;
    } else if (
      opensTypeScope(node, nodeType) ||
      (!!parentType && bindingRules?.nestedTypeScopeParents?.[nodeType] === parentType)
    ) {
      // A generic type's parameters belong to its own declaration, not a sibling declaration.
      // Fields retain their existing scope through `addDeclSkippingTypeScope` below.
      const scope: Scope = {
        kind: "type",
        map: new Map(),
        node,
        parent: stack[stack.length - 1],
      };
      attachPendingNames(scope);
      stack.push(scope);
      allScopes.push(scope);
      pushed = true;
      pushedScopeCount = 1;
      declareTypeParameters(node);
      bindHeaderParameters(node);
    }

    if (row.variableDeclarationTypes?.has(nodeType)) {
      addVariableDeclarations(
        node,
        row.hoistedVariableDeclarationTypes?.has(nodeType) ? addHoistedDecl : addVariableDecl,
      );
    }

    if (jsTs && (nodeType === "assignment_expression" || nodeType === "augmented_assignment_expression")) {
      const left = node.childForFieldName("left");
      if (left && idSet.has(left.type)) {
        const binding = lookup(sliceText(left, source), left);
        if (binding?.kind === "local" && binding.heldModuleSpecifier !== null) {
          const assigned =
            nodeType === "assignment_expression" ? moduleSpecifierFromValue(node.childForFieldName("right")) : null;
          if (!assigned || (binding.heldModuleSpecifier && binding.heldModuleSpecifier !== assigned)) {
            binding.heldModuleSpecifier = null;
          } else {
            binding.heldModuleSpecifier = assigned;
          }
        }
      }
    }

    if (row.declarationPatternTypes?.has(nodeType)) {
      const patternScope = stack[stack.length - 1];
      const allowed =
        !row.declarationPatternScopeTypes ||
        (!!patternScope && row.declarationPatternScopeTypes.has(patternScope.node.type));
      if (allowed) {
        const name = row.declarationPatternName?.(node) ?? node.childForFieldName("name");
        if (name) addDecl(name, "local");
      }
    }

    const templateValueParameter =
      parentType === "template_parameter_list" && row.templateValueParameterTypes?.has(nodeType);
    if (row.typeParameterTypes?.has(nodeType) || templateValueParameter) {
      // The inner parameter list of a C++ template-template parameter has its own scope.
      // The outer template's non-type parameters bind here, not in the enclosing file.
      const kind: BindingKind = templateValueParameter ? "param" : "type";
      for (const name of declaredNameNodes(node)) {
        // A scope that declares its parameters as it opens has already registered this name.
        if (preRegisteredNameSpans.has(nameSpanKey(name))) continue;
        addDecl(name, kind);
        preRegisteredNameSpans.add(nameSpanKey(name));
      }
    }

    let declarationName = isIdentifierNode && support.isDeclarationName(node);
    if (declarationName && bindingRules?.declarationNameIsUse?.(node)) declarationName = false;
    if (declarationName && row.shortVariableDeclarationTypes) {
      for (let current = node.parent; current; current = current.parent) {
        if (row.shortVariableDeclarationTypes.has(current.type)) {
          const left = current.childForFieldName("left");
          declarationName = !!left && node.startIndex >= left.startIndex && node.endIndex <= left.endIndex;
          break;
        }
        if (support.createsFunctionScope(current) || support.createsBlockScope(current)) break;
      }
    }
    if (
      declarationName &&
      scopeDeclarationNames(node) &&
      !isScopedEnumeratorName(node) &&
      !preRegisteredNameSpans.has(nameSpanKey(node))
    ) {
      const kind = isParamNode(node) ? "param" : declarationKindToBindingKind(support.classifyDefinition(node));
      addDeclSkippingTypeScope(node, kind);
    }

    const nestedIdentifier = parentType !== undefined && idSet.has(parentType) && row.childSkipNameTypes?.has(nodeType);
    if (isIdentifierNode && !declarationName && !nestedIdentifier) {
      const qualifiedName = bindingRules?.qualifiedFunctionNames ? qualifiedCppIdentifierForName(node) : null;
      if (qualifiedName) {
        const key = cppQualifiedNameSegments(qualifiedName, source).join("::");
        const occurrences = cppQualifiedMemberOccurrences.get(key) ?? [];
        const fallback = lookup(sliceText(node, source));
        occurrences.push({ node, range: toRange(node), ...(fallback ? { fallback } : {}) });
        cppQualifiedMemberOccurrences.set(key, occurrences);
      } else {
        const parent = node.parent;
        const memberProperty =
          parent &&
          (row.nonLexicalMemberPropertyTypes?.has(parent.type) ||
            (bindingRules?.nonLexicalMemberAccess && isMemberAccessNode(support, parent)))
            ? getMemberAccessParts(support, parent).property
            : null;
        const isMemberProperty =
          !!memberProperty && memberProperty.startIndex <= node.startIndex && memberProperty.endIndex >= node.endIndex;
        // The suffix of a dotted extension owner is a member of its prefix; its spelling proves no binding.
        const isQualifiedSuffix = bindingRules?.nonLexicalUse?.(node) ?? false;
        if (!isMemberProperty && !isQualifiedSuffix) {
          const receiverPropertyUse = !!receiverProperty && isImplicitReceiverPropertyName(node);
          const name = sliceText(node, source);
          const binding = receiverPropertyUse ? lookupOutsideFunctions(name) : lookup(name, node);
          const canonical = canonicalUseName(name, node);
          const deferred = deferToScope(canonical, binding, node);
          const useId = node.id;
          if (deferred && useId !== undefined) queueUse(deferred, useId);
          else if (binding) attachOccurrence(binding, node);
        }
      }
    }

    if (promotedBindings?.containerTypes.has(nodeType)) {
      const target = stack[stack.length - 1] ?? rootScope;
      for (const variable of promotedBindings.collect(node, source)) addBinding(target, variable, "local");
    }

    const params = pushed ? node.childForFieldName("parameters") : null;
    for (const child of node.namedChildren) {
      if (pushed) {
        const skipsFunctionParameters = params?.id === child.id && support.createsFunctionScope(node);
        const skipsBlockParameters =
          (child.type === "block_parameters" || child.type === "lambda_parameters") &&
          support.createsBlockScope(node) &&
          params?.startIndex === child.startIndex &&
          params.endIndex === child.endIndex;
        const skipsNameOrParameters =
          (row.functionNameTypes?.has(nodeType) || row.classNameTypes?.has(nodeType)) &&
          row.childSkipNameTypes?.has(child.type);
        const skipsCppNamespaceName = createsCppNamespaceScope && node.childForFieldName("name")?.id === child.id;
        if (skipsFunctionParameters || skipsBlockParameters || skipsNameOrParameters || skipsCppNamespaceName) {
          continue;
        }
      }
      walk(child);
    }
    for (let index = 0; index < pushedScopeCount; index += 1) {
      const closed = stack[stack.length - 1];
      if (closed) closeScope(closed);
      stack.pop();
    }
    cppNamespacePath.length = namespacePathStart;
  };

  const prepareCppCallableBindings = (bindings: readonly Binding[]): boolean => {
    const bySignature = new Map<string, Binding[]>();
    for (const binding of bindings) {
      const callable = binding.callable;
      if (!callable?.signature || !callable.arity) {
        for (const candidate of bindings) candidate.occurrencesComplete = false;
        return false;
      }
      const entity = bySignature.get(callable.key) ?? [];
      entity.push(binding);
      bySignature.set(callable.key, entity);
    }
    for (const entity of bySignature.values()) {
      const occurrences = entity.flatMap((binding) => (binding.def ? [binding.def] : []));
      for (const binding of entity) {
        binding.occurrences = occurrences;
        delete binding.occurrencesComplete;
      }
    }
    return true;
  };
  const assignCppCallableOccurrence = (bindings: readonly Binding[], node: SyntaxNodeLike, range: Range): void => {
    const selected = cppSelectCallableBinding(bindings, node, source, file, file);
    if (selected) {
      selected.occurrences.push(range);
      return;
    }
    for (const binding of bindings) binding.occurrencesComplete = false;
  };
  const cppOccurrenceBindings = (binding: Binding): readonly Binding[] | null => {
    const collisions = binding.sameScopeFunctionBindings ?? [binding];
    if (collisions.length > 1 || binding.callable?.signature) return collisions;
    return null;
  };

  collectHoistedDeclarations(tree.rootNode);
  attachPendingNames(rootScope);
  walk(tree.rootNode);
  closeScope(rootScope);
  for (const collisions of cppFunctionCollisionGroups) prepareCppCallableBindings(collisions);
  const cppQualifiedCallableBindings = new Map<string, Binding[]>();
  for (const [key, memberBindings] of cppQualifiedMemberBindings) {
    const callableBindings = [
      ...new Set(memberBindings.flatMap((binding) => binding.sameScopeFunctionBindings ?? [binding])),
    ];
    if (prepareCppCallableBindings(callableBindings)) cppQualifiedCallableBindings.set(key, callableBindings);
  }
  for (const occurrence of cppFunctionOccurrences) {
    const group = cppOccurrenceBindings(occurrence.binding);
    if (group) {
      assignCppCallableOccurrence(group, occurrence.node, occurrence.range);
    } else {
      occurrence.binding.occurrences.push(occurrence.range);
    }
  }
  for (const [key, callableBindings] of cppQualifiedCallableBindings) {
    for (const occurrence of cppQualifiedMemberOccurrences.get(key) ?? []) {
      assignCppCallableOccurrence(callableBindings, occurrence.node, occurrence.range);
    }
  }
  for (const [key, occurrences] of cppQualifiedMemberOccurrences) {
    if (cppQualifiedCallableBindings.has(key)) continue;
    for (const occurrence of occurrences) {
      const fallback = occurrence.fallback;
      if (!fallback) continue;
      const group = cppOccurrenceBindings(fallback);
      if (group) {
        assignCppCallableOccurrence(group, occurrence.node, occurrence.range);
      } else {
        fallback.occurrences.push(occurrence.range);
      }
    }
  }

  const bindings = new Map<string, Binding[]>();
  const all: Binding[] = [];
  const flushedMaps = new Set<Map<string, Binding>>();
  const seenBindings = new Set<Binding>();
  const pushBinding = (binding: Binding): void => {
    if (seenBindings.has(binding)) return;
    seenBindings.add(binding);
    if (!bindings.has(binding.canonicalName)) bindings.set(binding.canonicalName, []);
    bindings.get(binding.canonicalName)!.push(binding);
    all.push(binding);
    if (binding.earlierSameScope) pushBinding(binding.earlierSameScope);
  };
  const flush = (scope: Scope) => {
    if (flushedMaps.has(scope.map)) return;
    flushedMaps.add(scope.map);
    for (const binding of scope.map.values()) pushBinding(binding);
  };
  for (const scope of allScopes) flush(scope);
  for (const binding of extraBindings) pushBinding(binding);
  return {
    bindings,
    all,
    allScopes,
    cppQualifiedFunctionBindings: cppQualifiedCallableBindings,
    hasGeneratedMembers: !!generatedMembers,
  };
}
