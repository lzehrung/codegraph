import { sliceText, toRange } from "../util/ast.js";
import { getNativeSyntaxTreeExecution, type NativeRuntimeMode } from "../native/tree-sitter-native.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import { getMemberAccessParts, isMemberAccessNode } from "../util/member-access.js";
import { declarationKindToBindingKind } from "./declarations.js";
import { cppBindingCallableShape, cppSelectCallableBinding } from "./cpp-callables.js";
import { typescriptCallableRole } from "./ts-callables.js";
import { cppQualifiedNameSegments } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { phpConstructorPromotedVariable } from "./navigation-php.js";
import { cScopeName, cTagRole } from "../languages/definitions/c.js";
import type { LanguageSupport } from "../languages.js";
import { bindingCoversUse, scopeNodesFor, type ScopeNodeRow } from "./scope-nodes.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ImportBinding } from "./types.js";
import type { Binding, BindingKind, Scope, ScopeIndex } from "./scope-types.js";

export type { Binding, BindingKind, Scope, ScopeIndex };

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
  opts?: { tree?: SyntaxTreeLike; nativeMode?: NativeRuntimeMode },
): ScopeIndex {
  let tree = opts?.tree ?? null;
  if (!tree) {
    const nativeTreeExecution = getNativeSyntaxTreeExecution(source, support, opts?.nativeMode);
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
  const buildBinding = (nameNode: SyntaxNodeLike, kind: BindingKind): Binding => {
    const name = sliceText(nameNode, source);
    return {
      name,
      canonicalName: normalizeIdentifier(name),
      kind,
      def: toRange(nameNode),
      node: nameNode,
      occurrences: [],
    };
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
      support.id === "c" && importBinding.kind === "named" && importBinding.cNamespace === "tag"
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

  const row = scopeNodesFor(support.id);
  /** Covering-declaration names collected before a scope's body is walked, keyed by syntax node id. */
  const pendingNamesByNodeId = new Map<number, Set<string>>();
  /**
   * JS and TS record let/const/class/type names during the existing hoist walk. A use defers only
   * when one of those names is still ahead, so the queue stays the forward references.
   */
  const tracksLexicalNames = !!(row.hoistedFunctionTypes || row.hoistedVariableDeclarationTypes);
  const canDeferForward =
    !tracksLexicalNames &&
    (!!row.wholeScopeKinds?.size || !!row.wholeScopeDeclarationTypes?.size || !!row.variableTargetScopeKinds?.size);
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
    if (!types) return false;
    let current: SyntaxNodeLike | null = nameNode.parent;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (types.has(current.type)) return true;
      if (current.type === "variable_declarator" && current.parent && types.has(current.parent.type)) return true;
      // A local under a function body is not that function's declarator. Stop at the
      // body so only the declarator wrapped around this name (qualified or not) matches.
      if (support.createsFunctionScope(current) || support.createsBlockScope(current)) break;
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

  const addBinding = (target: Scope, nameNode: SyntaxNodeLike, kind: BindingKind): void => {
    const binding = buildBinding(nameNode, kind);
    if (row.wholeScopeKinds?.has(target.kind) || declarationCoversScope(nameNode)) {
      binding.coversEnclosingScope = true;
    }
    const tagRole = support.id === "c" ? cTagRole(nameNode) : undefined;
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
      return;
    }
    if (tagRole === "declaration" && existing?.import) {
      binding.occurrences = existing.occurrences;
      preserveExtraBinding(existing);
    }
    if (tagRole && existing?.def) {
      if (existing.def.start.index === binding.def?.start.index) return;
      binding.occurrences = existing.occurrences;
      if (tagRole === "declaration" && existing.node && cTagRole(existing.node) !== "declaration") {
        binding.occurrences.push(existing.def);
        preserveExtraBinding(existing);
        target.map.set(key, binding);
        return;
      }
      binding.occurrences.push(binding.def!);
      preserveExtraBinding(binding);
      return;
    }
    if (kind === "function" && existing?.kind === "function") {
      if (support.id === "c") {
        // C prototypes and their definitions are declarations of one function. Keep each
        // declaration addressable while sharing the occurrence list collected for that name.
        binding.occurrences = existing.occurrences;
        preserveExtraBinding(binding);
        return;
      }
      if (support.id === "cpp") {
        const collisions = existing.sameScopeFunctionBindings ?? [existing];
        collisions.push(binding);
        for (const collision of collisions) collision.sameScopeFunctionBindings = collisions;
        cppFunctionCollisionGroups.add(collisions);
        preserveExtraBinding(existing);
      }
      if (support.id === "ts" || support.id === "tsx") {
        const existingRole = existing.node ? typescriptCallableRole(existing.node) : "other";
        const nextRole = typescriptCallableRole(nameNode);
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
    if (!sameSpan && existing && !extraBindingSpans.has(bindingSpanKey(existing))) {
      binding.earlierSameScope = existing;
    }
    target.map.set(key, binding);
    if (binding.coversEnclosingScope) target.pendingCoveringNames?.delete(binding.canonicalName);
    if (!tracksLexicalNames) stealCoveredOccurrences(target, binding, key);
    const cppNamespace = cppNamespacePathByMap.get(target.map);
    if (support.id === "cpp" && kind === "function" && cppNamespace) {
      const qualifiedKey = `${cppNamespace}::${binding.name}`;
      const qualifiedBindings = cppQualifiedMemberBindings.get(qualifiedKey) ?? [];
      qualifiedBindings.push(binding);
      cppQualifiedMemberBindings.set(qualifiedKey, qualifiedBindings);
    }
  };

  const addDecl = (nameNode: SyntaxNodeLike, kind: BindingKind): void => {
    const target = stack[stack.length - 1];
    if (target) addBinding(target, nameNode, kind);
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
    const target = [...stack].reverse().find((scope) => scope.kind !== "type") ?? rootScope;
    addBinding(target, nameNode, kind);
  };

  const lookup = (name: string, node?: SyntaxNodeLike): Binding | undefined => {
    const normalizedName = normalizeIdentifier(name);
    const canonicalName =
      support.id === "c" && node && cTagRole(node) ? cScopeName(normalizedName, "tag") : normalizedName;
    for (let index = stack.length - 1; index >= 0; index--) {
      const hit = stack[index]!.map.get(canonicalName);
      if (hit) return hit;
    }
    return rootScope.map.get(canonicalName);
  };

  const lookupOutsideFunctions = (name: string): Binding | undefined => {
    const canonicalName = normalizeIdentifier(name);
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const scope = stack[index]!;
      if (scope.kind === "function") continue;
      const hit = scope.map.get(canonicalName);
      if (hit) return hit;
    }
    return rootScope.map.get(canonicalName);
  };

  const isPhpThisPropertyName = (nameNode: SyntaxNodeLike): boolean => {
    const parent = nameNode.parent;
    if (!parent || parent.type !== "member_access_expression") return false;
    const property =
      parent.childForFieldName("name") ?? parent.namedChildren.find((child) => child.type === "name") ?? null;
    if (!property || property.startIndex !== nameNode.startIndex || property.endIndex !== nameNode.endIndex) {
      return false;
    }
    const object = parent.childForFieldName("object") ?? parent.namedChildren[0] ?? null;
    if (!object || object.startIndex === property.startIndex) return false;
    return sliceText(object, source) === "$this";
  };

  const promotedVariablesInClass = (classNode: SyntaxNodeLike): SyntaxNodeLike[] => {
    const variables: SyntaxNodeLike[] = [];
    const visit = (current: SyntaxNodeLike): void => {
      if (
        current !== classNode &&
        (current.type === "class_declaration" ||
          current.type === "trait_declaration" ||
          current.type === "enum_declaration" ||
          current.type === "function_definition")
      ) {
        return;
      }
      if (current.type === "method_declaration") {
        const name = current.childForFieldName("name");
        if (!name || sliceText(name, source) !== "__construct") return;
        const params = current.childForFieldName("parameters");
        for (const child of params?.namedChildren ?? []) {
          const variable = phpConstructorPromotedVariable(child, source);
          if (variable) variables.push(variable);
        }
        return;
      }
      for (const child of current.namedChildren) visit(child);
    };
    visit(classNode);
    return variables;
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
      addBindingToScope(pattern, kind);
      return;
    }
    // Parameter nodes put names and types as siblings. Walking the whole subtree for bindings
    // would register type-position identifiers (`int`, `T`, package qualifiers) as new locals;
    // `walk` still visits the type field so a proven declaration (e.g. a struct name used as a
    // parameter type) records this position as one of its occurrences.
    if (row.destructuringTypeFieldTypes?.has(pattern.type)) {
      const typeNode = pattern.childForFieldName("type");
      for (const child of pattern.namedChildren) {
        if (typeNode && child.id === typeNode.id) continue;
        addPatternDecls(child, kind, addBindingToScope);
      }
      if (typeNode) walk(typeNode);
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
      addPatternDecls(child, kind, addBindingToScope);
    }
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
    if (row.destructuringTypeFieldTypes?.has(pattern.type)) {
      const typeNode = pattern.childForFieldName("type");
      for (const child of pattern.namedChildren) {
        if (typeNode && child.startIndex === typeNode.startIndex && child.endIndex === typeNode.endIndex) continue;
        rememberPatternNames(child, names);
      }
      return;
    }
    if (row.destructuringPairPatternTypes?.has(pattern.type)) {
      const value = pattern.childForFieldName("value");
      if (value) rememberPatternNames(value, names);
      return;
    }
    for (const child of pattern.namedChildren) rememberPatternNames(child, names);
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
      if (
        node !== scopeNode &&
        !row.moduleRootTypes?.has(node.type) &&
        (support.createsBlockScope(node) || !!row.typeScopeTypes?.has(node.type))
      ) {
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
    const normalized = normalizeIdentifier(name);
    return support.id === "c" && cTagRole(node) ? cScopeName(normalized, "tag") : normalized;
  };

  const scopeOwnsBinding = (scope: Scope, canonical: string, binding: Binding): boolean => {
    let current = scope.map.get(canonical);
    while (current) {
      if (current === binding) return true;
      current = current.earlierSameScope;
    }
    return false;
  };

  const deferToScope = (canonical: string, binding: Binding | undefined): Scope | undefined => {
    if (row.variableTargetScopeKinds) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const scope = stack[index]!;
        if (binding && scopeOwnsBinding(scope, canonical, binding)) return undefined;
        if (row.variableTargetScopeKinds.has(scope.kind)) return scope;
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
    (!!row.wholeScopeDeclarationTypes?.size && scope.kind !== "module");

  const lookupCovering = (
    start: Scope | undefined,
    useNode: SyntaxNodeLike,
    canonical: string,
    phpThis: boolean,
  ): Binding | undefined => {
    const useStart = useNode.startIndex;
    let scope = start;
    while (scope) {
      if (!(phpThis && scope.kind === "function")) {
        let binding = scope.map.get(canonical);
        while (binding && !bindingCoversUse(row, scope.kind, binding, useStart)) binding = binding.earlierSameScope;
        if (binding) return binding;
      }
      scope = scope.parent;
    }
    return undefined;
  };

  const attachOccurrence = (binding: Binding, useNode: SyntaxNodeLike): void => {
    const range = toRange(useNode);
    if (support.id === "cpp" && binding.kind === "function") {
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
    if (!tracksLexicalNames) {
      receiver = scope.parent;
      while (receiver && !scopeCanGainCoveringBinding(receiver)) receiver = receiver.parent;
    }
    for (let index = 0; index < queued.length; index += 1) {
      const id = queued[index]!;
      const useNode = nodeById(id);
      if (!useNode) continue;
      const phpThis = support.id === "php" && isPhpThisPropertyName(useNode);
      const canonical = canonicalUseName(sliceText(useNode, source), useNode);
      const binding = lookupCovering(scope, useNode, canonical, phpThis);
      if (!binding) {
        if (receiver) queueUse(receiver, id);
        continue;
      }
      if (receiver && !scopeOwnsBinding(scope, canonical, binding)) {
        queueUse(receiver, id);
        continue;
      }
      attachOccurrence(binding, useNode);
    }
  };

  const walk = (node: SyntaxNodeLike) => {
    let scopedFunctionName: { node: SyntaxNodeLike; qualifiedKey: string } | null = null;
    let qualifiedNamespaceScope: Scope | undefined;
    // A name-registering node puts its name in the *current* (enclosing) scope before the push
    // below creates the node's own scope. C# local functions need that: they are callable from
    // sibling statements in the enclosing method, unlike a JS named function expression's
    // self-only visibility, which the language's `scopeDeclarationNames` hook handles instead.
    if (row.functionNameTypes?.has(node.type)) {
      const name = declaredNameNode(node, row);
      if (name && (support.membersAreImplicitlyInScope || !isMemberFunction(node))) {
        // The declarator chain that carries a C-family function name also carries its parameter
        // list, so the child walk must still descend into it. Remember the exact name node instead
        // and skip only that node below, which keeps one binding per function without hiding
        // `function_declarator > parameter_list` from parameter registration.
        preRegisteredNameSpans.add(nameSpanKey(name));
        const qualifiedName = support.id === "cpp" ? qualifiedCppIdentifierForName(name, node) : null;
        if (qualifiedName) {
          const qualifiedKey = cppQualifiedNameSegments(qualifiedName, source).join("::");
          const ownerKey = qualifiedKey.slice(0, qualifiedKey.lastIndexOf("::"));
          qualifiedNamespaceScope = cppNamespaceScopes.get(ownerKey);
          if (qualifiedNamespaceScope) {
            addBinding(qualifiedNamespaceScope, name, "function");
          } else {
            scopedFunctionName = { node: name, qualifiedKey };
          }
        } else if (row.hoistedFunctionTypes?.has(node.type)) {
          addHoistedDecl(name, "function");
        } else {
          addDecl(name, "function");
        }
      }
    }
    if (row.classNameTypes?.has(node.type)) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "class");
    }
    if (row.typeNameTypes?.has(node.type)) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "type");
    }
    if (row.enumMemberTypes?.has(node.type)) {
      const name = node.childForFieldName("name");
      if (name) {
        if (row.enumMemberLocalTypes?.has(node.type) && !isScopedEnumeratorName(name)) addDecl(name, "local");
        else extraBindings.push(buildBinding(name, "local"));
      }
    }
    if (row.enumAssignmentTypes?.has(node.type)) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "local");
    } else if (
      row.enumBodyMemberTypes?.has(node.type) &&
      node.parent &&
      row.enumBodyParentTypes?.has(node.parent.type)
    ) {
      addDecl(node, "local");
    }

    let pushed = false;
    let pushedScopeCount = 0;
    const namespacePathStart = cppNamespacePath.length;
    const cppNamespaceName =
      support.id === "cpp" && node.type === "namespace_definition" ? node.childForFieldName("name") : null;
    const cppNamespaceIsInline = !!cppNamespaceName && /^\s*inline\s+namespace\b/u.test(sliceText(node, source));
    const createsCppNamespaceScope = !!cppNamespaceName && !cppNamespaceIsInline;
    const createsCppMemberScope = support.id === "cpp" && node.type === "field_declaration_list";
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

      const params = node.childForFieldName("parameters");
      if (params) addPatternDecls(params, "param");
      collectHoistedDeclarations(node);
      attachPendingNames(scope);
    } else if (support.createsBlockScope(node) || createsCppMemberScope) {
      if (!row.moduleRootTypes?.has(node.type)) {
        const scope: Scope = {
          kind: "block",
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
    } else if (row.typeScopeTypes?.has(node.type)) {
      // Go generic type declarations idiomatically reuse `T` as the type-parameter
      // name across sibling `type` declarations in the same file. Give each
      // `type_spec` its own scope so its type parameter doesn't collide with a
      // sibling's; `addDeclSkippingTypeScope` below keeps field names out of
      // it so they stay visible file-wide, as before.
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
    }

    if (row.variableDeclarationTypes?.has(node.type)) {
      addVariableDeclarations(
        node,
        row.hoistedVariableDeclarationTypes?.has(node.type) ? addHoistedDecl : addVariableDecl,
      );
    }

    if (row.declarationPatternTypes?.has(node.type)) {
      // C# is-pattern bound variable: `if (o is string text)`. The walker registers the bound name
      // without consulting `scopeDeclarationNames`, which would also newly activate
      // isDeclarationName-driven registration for every other C# declaration form.
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "local");
    }

    if (row.typeParameterTypes?.has(node.type)) {
      // Go and C++ generic type parameter, e.g. the `T` in `Box[T any]` / `func F[T any]`. Targets
      // the current scope directly (the `type_spec` scope pushed above, or the enclosing
      // function's own scope for a generic function) rather than skipping past it like field
      // declarations do.
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "type");
    }

    if (
      scopeDeclarationNames(node) &&
      idSet.has(node.type) &&
      support.isDeclarationName(node) &&
      !isScopedEnumeratorName(node) &&
      !preRegisteredNameSpans.has(nameSpanKey(node))
    ) {
      const kind = isParamNode(node) ? "param" : declarationKindToBindingKind(support.classifyDefinition(node));
      addDeclSkippingTypeScope(node, kind);
    }

    if (idSet.has(node.type) && !support.isDeclarationName(node)) {
      const qualifiedName = support.id === "cpp" ? qualifiedCppIdentifierForName(node) : null;
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
            (support.id === "cpp" && isMemberAccessNode(support, parent)))
            ? getMemberAccessParts(support, parent).property
            : null;
        const isMemberProperty =
          !!memberProperty && memberProperty.startIndex <= node.startIndex && memberProperty.endIndex >= node.endIndex;
        if (!isMemberProperty) {
          const phpThis = support.id === "php" && isPhpThisPropertyName(node);
          const name = sliceText(node, source);
          const binding = phpThis ? lookupOutsideFunctions(name) : lookup(name, node);
          const canonical = canonicalUseName(name, node);
          const deferred = deferToScope(canonical, binding);
          const useId = node.id;
          if (deferred && useId !== undefined) queueUse(deferred, useId);
          else if (binding) attachOccurrence(binding, node);
        }
      }
    }

    if (support.id === "php" && node.type === "class_declaration") {
      const target = stack[stack.length - 1] ?? rootScope;
      for (const variable of promotedVariablesInClass(node)) addBinding(target, variable, "local");
    }

    for (const child of node.namedChildren) {
      if (pushed) {
        const params = node.childForFieldName("parameters");
        const skipsFunctionParameters = support.createsFunctionScope(node) && params?.id === child.id;
        const skipsBlockParameters =
          support.createsBlockScope(node) &&
          (child.type === "block_parameters" || child.type === "lambda_parameters") &&
          params?.startIndex === child.startIndex &&
          params.endIndex === child.endIndex;
        const skipsNameOrParameters =
          (row.functionNameTypes?.has(node.type) || row.classNameTypes?.has(node.type)) &&
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
      const shape = cppBindingCallableShape(binding);
      if (!shape) {
        for (const candidate of bindings) candidate.occurrencesComplete = false;
        return false;
      }
      const entity = bySignature.get(shape.signature) ?? [];
      entity.push(binding);
      bySignature.set(shape.signature, entity);
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
    const selected = cppSelectCallableBinding(bindings, node, source);
    if (selected) {
      selected.occurrences.push(range);
      return;
    }
    for (const binding of bindings) binding.occurrencesComplete = false;
  };
  const cppOccurrenceBindings = (binding: Binding): readonly Binding[] | null => {
    const collisions = binding.sameScopeFunctionBindings ?? [binding];
    if (collisions.length > 1 || cppBindingCallableShape(binding)) return collisions;
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
  return { bindings, all, allScopes, cppQualifiedFunctionBindings: cppQualifiedCallableBindings };
}
