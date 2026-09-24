import { sliceText, toRange } from "../util/ast.js";
import { getNativeSyntaxTreeExecution, type NativeRuntimeMode } from "../native/tree-sitter-native.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import { getMemberAccessParts, isMemberAccessNode } from "../util/member-access.js";
import { declarationKindToBindingKind } from "./declarations.js";
import { cppBindingCallableShape, cppSelectCallableBinding } from "./cpp-callables.js";
import { cppQualifiedNameSegments } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import type { LanguageSupport } from "../languages.js";
import { scopeNodesFor, type ScopeNodeRow } from "./scope-nodes.js";
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
  const extraFunctionBindingSpans = new Set<string>();
  const preserveExtraFunctionBinding = (binding: Binding): void => {
    const start = binding.def?.start.index;
    const end = binding.def?.end.index;
    const key = `${binding.canonicalName}:${start ?? ""}:${end ?? ""}`;
    if (extraFunctionBindingSpans.has(key)) return;
    extraFunctionBindingSpans.add(key);
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
    rootScope.map.set(binding.canonicalName, binding);
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

  const addBinding = (target: Scope, nameNode: SyntaxNodeLike, kind: BindingKind): void => {
    const binding = buildBinding(nameNode, kind);
    const existing = target.map.get(binding.canonicalName);
    if (kind === "function" && existing?.kind === "function") {
      if (support.id === "c") {
        // C prototypes and their definitions are declarations of one function. Keep each
        // declaration addressable while sharing the occurrence list collected for that name.
        binding.occurrences = existing.occurrences;
        preserveExtraFunctionBinding(binding);
        return;
      }
      if (support.id === "cpp") {
        const collisions = existing.sameScopeFunctionBindings ?? [existing];
        collisions.push(binding);
        for (const collision of collisions) collision.sameScopeFunctionBindings = collisions;
        cppFunctionCollisionGroups.add(collisions);
        preserveExtraFunctionBinding(existing);
      }
    }
    target.map.set(binding.canonicalName, binding);
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
  const addDeclSkippingTypeScope = (nameNode: SyntaxNodeLike, kind: BindingKind): void => {
    const target = [...stack].reverse().find((scope) => scope.kind !== "type") ?? rootScope;
    addBinding(target, nameNode, kind);
  };

  const lookup = (name: string): Binding | undefined => {
    const canonicalName = normalizeIdentifier(name);
    for (let index = stack.length - 1; index >= 0; index--) {
      const hit = stack[index]!.map.get(canonicalName);
      if (hit) return hit;
    }
    return rootScope.map.get(canonicalName);
  };

  const addPatternDecls = (
    pattern: SyntaxNodeLike,
    kind: BindingKind,
    addBindingToScope: (nameNode: SyntaxNodeLike, kind: BindingKind) => void = addDecl,
  ): void => {
    if (idSet.has(pattern.type)) {
      addBindingToScope(pattern, kind);
      return;
    }
    // Parameter nodes put names and types as siblings. Walking the whole subtree
    // would register type-position identifiers (`int`, `T`, package qualifiers).
    if (row.destructuringTypeFieldTypes?.has(pattern.type)) {
      const typeNode = pattern.childForFieldName("type");
      for (const child of pattern.namedChildren) {
        if (typeNode && child.id === typeNode.id) continue;
        addPatternDecls(child, kind, addBindingToScope);
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
      addPatternDecls(child, kind, addBindingToScope);
    }
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
          if (isStaticRequireCall(value)) addUnsupportedRequirePatternDecls(name, addBindingToScope);
          else addPatternDecls(name, "local", addBindingToScope);
        }
      } else if (row.assignmentIdentifierTypes?.has(child.type) && row.assignmentDeclarationTypes?.has(node.type)) {
        addBindingToScope(child, "local");
      } else if (row.patternBindingTypes?.has(node.type)) {
        const pattern = node.childForFieldName("pattern") || node.childForFieldName("name");
        if (pattern) addPatternDecls(pattern, "local", addBindingToScope);
      }
    }
  };

  const collectHoistedDeclarations = (scopeNode: SyntaxNodeLike): void => {
    if (!row.hoistedFunctionTypes && !row.hoistedVariableDeclarationTypes) return;

    const visit = (node: SyntaxNodeLike): void => {
      if (support.createsFunctionScope(node)) {
        if (row.hoistedFunctionTypes?.has(node.type)) {
          const name = node.childForFieldName("name");
          if (name) addHoistedDecl(name, "function");
        }
        return;
      }
      if (row.hoistedVariableDeclarationTypes?.has(node.type)) {
        addVariableDeclarations(node, addHoistedDecl);
      }
      for (const child of node.namedChildren) {
        visit(child);
      }
    };

    for (const child of scopeNode.namedChildren) {
      visit(child);
    }
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
    } else if (support.createsBlockScope(node) || createsCppMemberScope) {
      if (!row.moduleRootTypes?.has(node.type)) {
        const scope: Scope = {
          kind: "block",
          map: new Map(),
          node,
          parent: stack[stack.length - 1],
        };
        stack.push(scope);
        allScopes.push(scope);
        pushed = true;
        pushedScopeCount = 1;
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
      stack.push(scope);
      allScopes.push(scope);
      pushed = true;
      pushedScopeCount = 1;
    }

    if (row.variableDeclarationTypes?.has(node.type)) {
      addVariableDeclarations(node, row.hoistedVariableDeclarationTypes?.has(node.type) ? addHoistedDecl : addDecl);
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
          support.id === "cpp" && parent && isMemberAccessNode(support, parent)
            ? getMemberAccessParts(support, parent).property
            : null;
        const isCppMemberProperty =
          !!memberProperty && memberProperty.startIndex <= node.startIndex && memberProperty.endIndex >= node.endIndex;
        if (!isCppMemberProperty) {
          const binding = lookup(sliceText(node, source));
          if (support.id === "cpp" && binding?.kind === "function") {
            cppFunctionOccurrences.push({ binding, node, range: toRange(node) });
          } else if (binding) {
            binding.occurrences.push(toRange(node));
          }
        }
      }
    }

    for (const child of node.namedChildren) {
      if (pushed) {
        const params = node.childForFieldName("parameters");
        const skipsFunctionParameters = support.createsFunctionScope(node) && params?.id === child.id;
        const skipsNameOrParameters =
          (row.functionNameTypes?.has(node.type) || row.classNameTypes?.has(node.type)) &&
          row.childSkipNameTypes?.has(child.type);
        const skipsCppNamespaceName = createsCppNamespaceScope && node.childForFieldName("name")?.id === child.id;
        if (skipsFunctionParameters || skipsNameOrParameters || skipsCppNamespaceName) {
          continue;
        }
      }
      walk(child);
    }
    for (let index = 0; index < pushedScopeCount; index += 1) stack.pop();
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
  walk(tree.rootNode);
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
  const flush = (scope: Scope) => {
    if (flushedMaps.has(scope.map)) return;
    flushedMaps.add(scope.map);
    for (const binding of scope.map.values()) {
      if (!bindings.has(binding.canonicalName)) bindings.set(binding.canonicalName, []);
      bindings.get(binding.canonicalName)!.push(binding);
      all.push(binding);
    }
  };
  for (const scope of allScopes) flush(scope);
  for (const binding of extraBindings) {
    if (!bindings.has(binding.canonicalName)) bindings.set(binding.canonicalName, []);
    bindings.get(binding.canonicalName)!.push(binding);
    all.push(binding);
  }
  return { bindings, all, allScopes, cppQualifiedFunctionBindings: cppQualifiedCallableBindings };
}
