import { parseWithJsLanguage } from "../jsFallback.js";
import { sliceText, toRange } from "../util/ast.js";
import { getNativeSyntaxTreeExecution, type NativeRuntimeMode } from "../native/treeSitterNative.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import { declarationKindToBindingKind } from "./declarations.js";
import type { LanguageSupport } from "../languages.js";
import type { JsLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ImportBinding } from "./types.js";
import type { Binding, BindingKind, Scope, ScopeIndex } from "./scope-types.js";

export type { Binding, BindingKind, Scope, ScopeIndex };

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: LanguageSupport,
  lang?: JsLanguage,
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
    const resolvedLang = lang ?? support.language(file);
    tree = parseWithJsLanguage(source, resolvedLang);
  }

  const rootScope: Scope = {
    kind: "module",
    map: new Map(),
    node: tree.rootNode,
    parent: undefined,
  };
  const stack: Scope[] = [rootScope];
  const allScopes: Scope[] = [rootScope];

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
    const name = sliceText(nameNode, source);
    const target = stack[stack.length - 1];
    const binding: Binding = {
      name,
      kind,
      def: toRange(nameNode),
      node: nameNode,
      occurrences: [],
    };
    target?.map.set(name, binding);
  };

  const lookup = (name: string): Binding | undefined => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const hit = stack[index]!.map.get(name);
      if (hit) return hit;
    }
    return rootScope.map.get(name);
  };

  const walk = (node: SyntaxNodeLike) => {
    if (
      node.type === "function_declaration" ||
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
      node.type === "trait_item"
    ) {
      const name = node.childForFieldName("name");
      if (name) addDecl(name, "type");
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
          if (name) addDecl(name, "local");
        } else if (
          (child.type === "identifier" || child.type === "field_identifier") &&
          (node.type === "assignment" || node.type === "short_var_declaration")
        ) {
          addDecl(child, "local");
        } else if (node.type === "let_declaration" || node.type === "const_item" || node.type === "static_item") {
          const pattern = node.childForFieldName("pattern") || node.childForFieldName("name");
          if (pattern && pattern.type === "identifier") addDecl(pattern, "local");
        }
      }
    }

    if (customDeclLanguages.has(support.id) && idSet.has(node.type) && support.isDeclarationName(node)) {
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
            type === "function_definition" ||
            type === "method_definition" ||
            type === "method_declaration" ||
            type === "method" ||
            type === "singleton_method" ||
            type === "function_item" ||
            type === "func_literal" ||
            type === "class_declaration" ||
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
  return { bindings, all, allScopes };
}
