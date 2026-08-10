import { sliceText, toRange } from "../util/ast.js";
import { getNativeSyntaxTreeExecution, type NativeRuntimeMode } from "../native/treeSitterNative.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import { declarationKindToBindingKind } from "./declarations.js";
import type { LanguageSupport } from "../languages.js";
import type { ParserLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ImportBinding } from "./types.js";
import type { Binding, BindingKind, Scope, ScopeIndex } from "./scope-types.js";

export type { Binding, BindingKind, Scope, ScopeIndex };

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang?: ParserLanguage,
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
  const extraBindings: Binding[] = [];

  const buildBinding = (nameNode: SyntaxNodeLike, kind: BindingKind): Binding => ({
    name: sliceText(nameNode, source),
    kind,
    def: toRange(nameNode),
    node: nameNode,
    occurrences: [],
  });

  for (const imp of imports) {
    if (imp.kind === "default") {
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importDefault",
        occurrences: [],
        import: imp,
      });
    }
    if (imp.kind === "named") {
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importNamed",
        occurrences: [],
        import: imp,
      });
    }
    if (imp.kind === "namespace") {
      rootScope.map.set(imp.localNS, {
        name: imp.localNS,
        kind: "namespace",
        occurrences: [],
        import: imp,
      });
    }
  }

  const idSet = new Set([...support.nodeTypes.identifier, ...(support.nodeTypes.shorthandPropertyIdentifier ?? [])]);
  const customDeclLanguages = new Set(["c", "cpp", "kotlin", "swift"]);
  const paramParentTypes = new Set(["parameter_declaration", "parameter", "class_parameter", "lambda_parameters"]);

  const isParamNode = (node: SyntaxNodeLike): boolean => {
    let current: SyntaxNodeLike | null = node.parent;
    while (current) {
      if (paramParentTypes.has(current.type)) return true;
      current = current.parent;
    }
    return false;
  };

  const addDecl = (nameNode: SyntaxNodeLike, kind: BindingKind) => {
    const target = stack[stack.length - 1];
    const binding = buildBinding(nameNode, kind);
    target?.map.set(binding.name, binding);
  };

  const lookup = (name: string): Binding | undefined => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const hit = stack[index]!.map.get(name);
      if (hit) return hit;
    }
    return rootScope.map.get(name);
  };

  const addPatternDecls = (pattern: SyntaxNodeLike, kind: BindingKind): void => {
    if (idSet.has(pattern.type)) {
      addDecl(pattern, kind);
      return;
    }
    if (pattern.type === "pair_pattern") {
      const value = pattern.childForFieldName("value");
      if (value) {
        addPatternDecls(value, kind);
      }
      return;
    }
    for (const child of pattern.namedChildren) {
      addPatternDecls(child, kind);
    }
  };

  const isStaticRequireCall = (node: SyntaxNodeLike | null): boolean => {
    if (!node || node.type !== "call_expression") return false;
    const callee = node.childForFieldName("function") ?? node.childForFieldName("callee") ?? node.child(0);
    if (!callee || sliceText(callee, source) !== "require") return false;
    const args = node.childForFieldName("arguments");
    return !!args && /^\(\s*["'][^"']+["']\s*\)$/.test(sliceText(args, source));
  };

  const hasImportBinding = (nameNode: SyntaxNodeLike): boolean => {
    const name = sliceText(nameNode, source);
    const binding = rootScope.map.get(name);
    return (
      !!binding && (binding.kind === "importDefault" || binding.kind === "importNamed" || binding.kind === "namespace")
    );
  };

  const isScopedCppEnumeratorName = (node: SyntaxNodeLike): boolean => {
    if (support.id !== "cpp" || node.parent?.type !== "enumerator") return false;
    let current = node.parent.parent;
    while (current) {
      if (current.type === "enum_specifier") return /^\s*enum\s+(?:class|struct)\b/.test(sliceText(current, source));
      current = current.parent;
    }
    return false;
  };

  const addUnsupportedRequirePatternDecls = (pattern: SyntaxNodeLike): void => {
    if (idSet.has(pattern.type)) {
      if (!hasImportBinding(pattern)) addPatternDecls(pattern, "local");
      return;
    }
    if (pattern.type !== "object_pattern") {
      addPatternDecls(pattern, "local");
      return;
    }
    for (const child of pattern.namedChildren) {
      if (child.type === "shorthand_property_identifier" || child.type === "shorthand_property_identifier_pattern") {
        if (!hasImportBinding(child)) addPatternDecls(child, "local");
        continue;
      }
      if (child.type === "pair_pattern") {
        const value = child.childForFieldName("value");
        if (value && idSet.has(value.type) && hasImportBinding(value)) {
          continue;
        }
        if (value) {
          addPatternDecls(value, "local");
        }
        continue;
      }
      addPatternDecls(child, "local");
    }
  };

  const walk = (node: SyntaxNodeLike) => {
    if (
      node.type === "function_declaration" ||
      node.type === "generator_function_declaration" ||
      node.type === "function_definition" ||
      node.type === "method_definition" ||
      node.type === "method_declaration" ||
      node.type === "method" ||
      node.type === "singleton_method" ||
      node.type === "function_item" ||
      node.type === "func_literal"
    ) {
      const name = node.childForFieldName("name");
      if (name) {
        addDecl(name, "function");
      }
    }
    if (
      node.type === "class_declaration" ||
      node.type === "abstract_class_declaration" ||
      node.type === "class_definition" ||
      node.type === "class" ||
      node.type === "module" ||
      node.type === "struct_item" ||
      node.type === "mod_item"
    ) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "class");
    }
    if (
      node.type === "interface_declaration" ||
      node.type === "type_alias_declaration" ||
      node.type === "type_spec" ||
      node.type === "trait_item" ||
      node.type === "enum_declaration" ||
      node.type === "enum_item" ||
      node.type === "enum_specifier"
    ) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "type");
    }
    if (
      node.type === "enum_case" ||
      node.type === "enum_constant" ||
      node.type === "enum_entry" ||
      node.type === "enum_member_declaration" ||
      node.type === "enum_variant" ||
      node.type === "enumerator"
    ) {
      const name = node.childForFieldName("name");
      if (name) {
        if (
          node.type === "enumerator" &&
          (support.id === "c" || (support.id === "cpp" && !isScopedCppEnumeratorName(name)))
        )
          addDecl(name, "local");
        else extraBindings.push(buildBinding(name, "local"));
      }
    }

    let pushed = false;
    if (support.createsFunctionScope(node)) {
      const scope: Scope = {
        kind: "function",
        map: new Map(),
        node,
        parent: stack[stack.length - 1],
      };
      stack.push(scope);
      allScopes.push(scope);
      pushed = true;

      if (
        node.type === "function_declaration" ||
        node.type === "generator_function_declaration" ||
        node.type === "function_definition" ||
        node.type === "method_definition" ||
        node.type === "method_declaration" ||
        node.type === "method" ||
        node.type === "singleton_method" ||
        node.type === "function_item" ||
        node.type === "func_literal"
      ) {
        const params = node.childForFieldName("parameters");
        if (params) {
          const queue: SyntaxNodeLike[] = [params];
          while (queue.length) {
            const current = queue.pop();
            if (!current) continue;
            if (current.type === "identifier") addDecl(current, "param");
            for (const child of current.namedChildren) queue.push(child);
          }
        }
      }
    } else if (support.createsBlockScope(node)) {
      if (node.type !== "program" && node.type !== "module") {
        const scope: Scope = {
          kind: "block",
          map: new Map(),
          node,
          parent: stack[stack.length - 1],
        };
        stack.push(scope);
        allScopes.push(scope);
        pushed = true;
      }
    }

    if (
      node.type === "variable_declaration" ||
      node.type === "lexical_declaration" ||
      node.type === "assignment" ||
      node.type === "field_declaration" ||
      node.type === "local_variable_declaration" ||
      node.type === "var_declaration" ||
      node.type === "const_declaration" ||
      node.type === "short_var_declaration" ||
      node.type === "let_declaration" ||
      node.type === "const_item" ||
      node.type === "static_item"
    ) {
      for (const child of node.namedChildren) {
        if (child.type === "variable_declarator" || child.type === "var_spec" || child.type === "const_spec") {
          const name = child.childForFieldName("name");
          const value = child.childForFieldName("value");
          if (name) {
            if (isStaticRequireCall(value)) addUnsupportedRequirePatternDecls(name);
            else addPatternDecls(name, "local");
          }
        } else if (
          (child.type === "identifier" || child.type === "field_identifier") &&
          (node.type === "assignment" || node.type === "short_var_declaration")
        ) {
          addDecl(child, "local");
        } else if (node.type === "let_declaration" || node.type === "const_item" || node.type === "static_item") {
          const pattern = node.childForFieldName("pattern") || node.childForFieldName("name");
          if (pattern) addPatternDecls(pattern, "local");
        }
      }
    }

    if (node.type === "declaration_pattern") {
      // C# is-pattern bound variable: `if (o is string text)`. This node type
      // is unique to C#'s pattern-matching grammar, so it's safe to register
      // unconditionally here rather than gating on customDeclLanguages (which
      // would also newly activate isDeclarationName-driven registration for
      // every other C# declaration form, an unrelated and untested change).
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "local");
    }

    if (
      customDeclLanguages.has(support.id) &&
      idSet.has(node.type) &&
      support.isDeclarationName(node) &&
      !isScopedCppEnumeratorName(node)
    ) {
      const kind = isParamNode(node) ? "param" : declarationKindToBindingKind(support.classifyDefinition(node));
      addDecl(node, kind);
    }

    if (idSet.has(node.type) && !support.isDeclarationName(node)) {
      const name = sliceText(node, source);
      const binding = lookup(name);
      if (binding) {
        binding.occurrences.push(toRange(node));
      }
    }

    for (const child of node.namedChildren) {
      if (pushed) {
        const type = node.type;
        if (
          (type === "function_declaration" ||
            type === "generator_function_declaration" ||
            type === "function_definition" ||
            type === "method_definition" ||
            type === "method_declaration" ||
            type === "method" ||
            type === "singleton_method" ||
            type === "function_item" ||
            type === "func_literal" ||
            type === "class_declaration" ||
            type === "abstract_class_declaration" ||
            type === "class_definition" ||
            type === "class" ||
            type === "module" ||
            type === "struct_item" ||
            type === "mod_item") &&
          (child.type === "identifier" || child.type === "type_identifier" || child.type === "parameters")
        ) {
          continue;
        }
      }
      walk(child);
    }

    if (pushed) stack.pop();
  };

  walk(tree.rootNode);

  const bindings = new Map<string, Binding[]>();
  const all: Binding[] = [];
  const flush = (scope: Scope) => {
    for (const binding of scope.map.values()) {
      if (!bindings.has(binding.name)) bindings.set(binding.name, []);
      bindings.get(binding.name)!.push(binding);
      all.push(binding);
    }
  };
  for (const scope of allScopes) flush(scope);
  for (const binding of extraBindings) {
    if (!bindings.has(binding.name)) bindings.set(binding.name, []);
    bindings.get(binding.name)!.push(binding);
    all.push(binding);
  }
  return { bindings, all, allScopes };
}
