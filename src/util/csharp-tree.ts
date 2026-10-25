import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import {
  getNativeSyntaxTreeExecution,
  type NativeFallbackReason,
  type NativeSyntaxTreeExecution,
} from "../native/tree-sitter-native.js";
import { errorMessage } from "./errors.js";
import { normalizeCsharpIdentifier, normalizeCsharpQualifiedName } from "./identifiers.js";

const CSHARP_NAME_NODE_TYPES: Record<string, true> = {
  identifier: true,
  qualified_name: true,
  alias_qualified_name: true,
  predefined_type: true,
};

const CSHARP_IMPORT_DIRECTIVE_TYPES: Record<string, true> = {
  using_directive: true,
  extern_alias_directive: true,
};

const CSHARP_TYPE_DECLARATION_TYPES: Record<string, true> = {
  class_declaration: true,
  struct_declaration: true,
  interface_declaration: true,
  enum_declaration: true,
  record_declaration: true,
  delegate_declaration: true,
};

export type CsharpNamePath = {
  value: string;
  leaf: SyntaxNodeLike;
};

export type CsharpUsingDirective = CsharpNamePath & {
  rawValue: string;
  alias?: SyntaxNodeLike;
  isStatic: boolean;
  isGlobal: boolean;
};

export type CsharpNamespaceSpan = {
  name: string;
  start: number;
  end: number;
};

export type CsharpNamespaceFacts = {
  regions: CsharpNamespaceSpan[];
  namespaces: string[];
  symbolsByNamespace: Map<string, Set<string>>;
  hasGlobalType: boolean;
};
export type CsharpSyntaxTreeResult = {
  tree: SyntaxTreeLike | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export function csharpSyntaxTreeFromNativeExecution(
  source: string,
  execution: Pick<NativeSyntaxTreeExecution, "tree" | "fallbackReason" | "error">,
): CsharpSyntaxTreeResult {
  if (!execution.tree) {
    return {
      tree: null,
      ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {}),
      ...(execution.error ? { error: execution.error } : {}),
    };
  }
  try {
    return { tree: new ProjectedSyntaxTree(source, execution.tree) };
  } catch (error) {
    return {
      tree: null,
      fallbackReason: execution.fallbackReason ?? "queryFailure",
      error: errorMessage(error),
    };
  }
}

export function parseCsharpSyntaxTree(source: string, support: LanguageSupport): CsharpSyntaxTreeResult {
  if (support.id !== "csharp") return { tree: null };
  return csharpSyntaxTreeFromNativeExecution(source, getNativeSyntaxTreeExecution(source, support));
}

/** Builds a supported C# name path from native syntax nodes. */
export function csharpNamePath(node: SyntaxNodeLike | null): CsharpNamePath | null {
  if (!node) return null;
  if (
    node.type === "array_type" ||
    node.type === "nullable_type" ||
    node.type === "pointer_type" ||
    node.type === "ref_type" ||
    node.type === "generic_name"
  ) {
    return null;
  }
  if (node.type === "identifier" || node.type === "predefined_type") {
    return { value: node.text, leaf: node };
  }
  if (node.type === "qualified_name") {
    const qualifierNode = node.childForFieldName("qualifier");
    const qualifier = csharpNamePath(qualifierNode);
    const name = csharpNamePath(node.childForFieldName("name"));
    if (!name || (qualifierNode && !qualifier)) return null;
    const value = qualifier ? qualifier.value + "." + name.value : name.value;
    return { value, leaf: name.leaf };
  }
  if (node.type === "alias_qualified_name") {
    const alias = csharpNamePath(node.childForFieldName("alias"));
    const name = csharpNamePath(node.childForFieldName("name"));
    if (!alias || !name) return null;
    return { value: alias.value + "::" + name.value, leaf: name.leaf };
  }
  const wrappedName = node.namedChildren.find((child) => CSHARP_NAME_NODE_TYPES[child.type]);
  return csharpNamePath(wrappedName ?? null);
}

export function csharpImportDirectiveAt(
  tree: SyntaxTreeLike | null | undefined,
  startIndex: number,
): SyntaxNodeLike | null {
  if (!tree) return null;
  const root = tree.rootNode;
  if (startIndex < root.startIndex || startIndex >= root.endIndex) return null;
  let node: SyntaxNodeLike | null = root.descendantForIndex(startIndex, startIndex + 1);
  while (node && !CSHARP_IMPORT_DIRECTIVE_TYPES[node.type]) node = node.parent;
  return node;
}

/** Returns C# using/extern-alias directives in source order from the projected native tree. */
export function collectCsharpImportDirectives(tree: SyntaxTreeLike): SyntaxNodeLike[] {
  const directives: SyntaxNodeLike[] = [];
  const stack: SyntaxNodeLike[] = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (CSHARP_IMPORT_DIRECTIVE_TYPES[node.type]) {
      directives.push(node);
      continue;
    }
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push(child);
    }
  }
  return directives;
}

export function csharpUsingDirective(node: SyntaxNodeLike): CsharpUsingDirective | null {
  if (node.type !== "using_directive") return null;
  const alias = node.childForFieldName("name") ?? undefined;
  const target = node.namedChildren.find((child) => child !== alias && child.type !== "comment");
  if (!target) return null;
  const path = csharpNamePath(target);
  if (!path) return null;
  let isStatic = false;
  let isGlobal = false;
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    if (child.type === "static") isStatic = true;
    if (child.type === "global") isGlobal = true;
  }
  return {
    ...path,
    rawValue: target.text,
    ...(alias ? { alias } : {}),
    isStatic,
    isGlobal,
  };
}
export function csharpExternAlias(node: SyntaxNodeLike): string | null {
  if (node.type !== "extern_alias_directive") return null;
  const alias = node.childForFieldName("name");
  return alias?.type === "identifier" ? alias.text : null;
}
export function collectCsharpNamespaceFacts(tree: SyntaxTreeLike, sourceLength: number): CsharpNamespaceFacts {
  const regions: CsharpNamespaceSpan[] = [];
  const namespaces = new Set<string>();
  const symbolsByNamespace = new Map<string, Set<string>>();
  let hasGlobalType = false;

  const qualifiedNamespace = (enclosing: string | null, node: SyntaxNodeLike): string | null => {
    const path = csharpNamePath(node.childForFieldName("name"));
    if (!path) return null;
    const normalized = normalizeCsharpQualifiedName(path.value);
    if (!normalized) return null;
    return enclosing ? normalizeCsharpQualifiedName(`${enclosing}.${normalized}`) : normalized;
  };

  const addType = (node: SyntaxNodeLike, namespaceName: string | null): void => {
    if (!namespaceName) {
      hasGlobalType = true;
      return;
    }
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? normalizeCsharpIdentifier(nameNode.text) : "";
    if (!name) return;
    let symbols = symbolsByNamespace.get(namespaceName);
    if (!symbols) {
      symbols = new Set<string>();
      symbolsByNamespace.set(namespaceName, symbols);
    }
    symbols.add(name);
  };

  const visitNamespaceMembers = (members: readonly SyntaxNodeLike[], namespaceName: string): void => {
    for (const member of members) {
      if (member.type === "namespace_declaration") {
        visitBlockNamespace(member, namespaceName);
      } else if (CSHARP_TYPE_DECLARATION_TYPES[member.type]) {
        addType(member, namespaceName);
      }
    }
  };

  const visitBlockNamespace = (node: SyntaxNodeLike, enclosing: string | null): void => {
    const name = qualifiedNamespace(enclosing, node);
    const body = node.childForFieldName("body");
    if (!name || !body) return;
    regions.push({ name, start: node.startIndex, end: Math.max(node.startIndex, body.endIndex - 1) });
    namespaces.add(name);
    visitNamespaceMembers(body.namedChildren, name);
  };

  let rootNamespace: string | null = null;
  let sawNamespaceDeclaration = false;
  for (const member of tree.rootNode.namedChildren) {
    if (member.type === "file_scoped_namespace_declaration") {
      if (sawNamespaceDeclaration) continue;
      rootNamespace = qualifiedNamespace(null, member);
      if (!rootNamespace) continue;
      regions.push({ name: rootNamespace, start: member.startIndex, end: sourceLength });
      namespaces.add(rootNamespace);
      sawNamespaceDeclaration = true;
    } else if (member.type === "namespace_declaration") {
      sawNamespaceDeclaration = true;
      visitBlockNamespace(member, rootNamespace);
    } else if (CSHARP_TYPE_DECLARATION_TYPES[member.type]) {
      addType(member, rootNamespace);
    }
  }

  return {
    regions,
    namespaces: Array.from(namespaces),
    symbolsByNamespace,
    hasGlobalType,
  };
}
