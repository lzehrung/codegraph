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
  generic_name: true,
  predefined_type: true,
  array_type: true,
  nullable_type: true,
  pointer_type: true,
  ref_type: true,
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

export type CsharpTypeNameSegment = {
  name: string;
  typeArgumentCount?: number;
};

export type CsharpTypeNamePath = {
  value: string;
  segments: readonly CsharpTypeNameSegment[];
  aliasQualifier?: string;
};

export type CsharpNamePath = {
  value: string;
  leaf: SyntaxNodeLike;
  csharpTypePath?: CsharpTypeNamePath;
};

export type CsharpUsingDirective = CsharpNamePath & {
  target: SyntaxNodeLike;
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
  typeAritiesByNamespace: Map<string, Map<string, Set<number>>>;
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

/** Builds a C# name path from native syntax nodes, preserving generic type identity. */
export function csharpNamePath(node: SyntaxNodeLike | null): CsharpNamePath | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "predefined_type") {
    return { value: node.text, leaf: node };
  }
  if (node.type === "generic_name") {
    const identifier = node.namedChildren.find((child) => child.type === "identifier");
    if (!identifier) return null;
    const argumentList = node.namedChildren.find((child) => child.type === "type_argument_list");
    return {
      value: identifier.text,
      leaf: identifier,
      csharpTypePath: {
        value: identifier.text,
        segments: [
          {
            name: identifier.text,
            typeArgumentCount: argumentList?.namedChildren.filter((child) => child.type !== "comment").length ?? 0,
          },
        ],
      },
    };
  }
  if (node.type === "qualified_name") {
    const qualifier = csharpNamePath(node.childForFieldName("qualifier"));
    const name = csharpNamePath(node.childForFieldName("name"));
    if (!name) return null;
    const value = qualifier ? qualifier.value + "." + name.value : name.value;
    const csharpTypePath = mergeCsharpTypePaths(value, qualifier, name);
    return { value, leaf: name.leaf, ...(csharpTypePath ? { csharpTypePath } : {}) };
  }
  if (node.type === "alias_qualified_name") {
    const alias = csharpNamePath(node.childForFieldName("alias"));
    const name = csharpNamePath(node.childForFieldName("name"));
    if (!alias || !name) return null;
    const value = alias.value + "::" + name.value;
    const csharpTypePath = name.csharpTypePath
      ? { value, segments: name.csharpTypePath.segments, aliasQualifier: alias.value }
      : undefined;
    return { value, leaf: name.leaf, ...(csharpTypePath ? { csharpTypePath } : {}) };
  }
  const wrappedName = node.namedChildren.find((child) => CSHARP_NAME_NODE_TYPES[child.type]);
  return csharpNamePath(wrappedName ?? null);
}

function mergeCsharpTypePaths(
  value: string,
  qualifier: CsharpNamePath | null,
  name: CsharpNamePath,
): CsharpTypeNamePath | undefined {
  if (!qualifier?.csharpTypePath && !name.csharpTypePath) return undefined;
  const segments = qualifier
    ? [...csharpPathSegments(qualifier), ...csharpPathSegments(name)]
    : csharpPathSegments(name);
  const aliasQualifier = qualifier?.csharpTypePath?.aliasQualifier ?? name.csharpTypePath?.aliasQualifier;
  return { value, segments, ...(aliasQualifier ? { aliasQualifier } : {}) };
}

function csharpPathSegments(path: CsharpNamePath): readonly CsharpTypeNameSegment[] {
  return path.csharpTypePath?.segments ?? [{ name: path.value }];
}

export function csharpHasGenericTypeOwner(path: CsharpTypeNamePath): boolean {
  for (let index = 0; index < path.segments.length - 1; index += 1) {
    if (path.segments[index]?.typeArgumentCount !== undefined) return true;
  }
  return false;
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
    target,
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
  const typeAritiesByNamespace = new Map<string, Map<string, Set<number>>>();
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

    let aritiesByType = typeAritiesByNamespace.get(namespaceName);
    if (!aritiesByType) {
      aritiesByType = new Map<string, Set<number>>();
      typeAritiesByNamespace.set(namespaceName, aritiesByType);
    }
    let arities = aritiesByType.get(name);
    if (!arities) {
      arities = new Set<number>();
      aritiesByType.set(name, arities);
    }
    const typeParameters =
      node.childForFieldName("type_parameters") ??
      node.namedChildren.find((child) => child.type === "type_parameter_list") ??
      null;
    let parameterCount = 0;
    let identifierCount = 0;
    for (const parameter of typeParameters?.namedChildren ?? []) {
      if (parameter.type === "type_parameter") parameterCount += 1;
      else if (parameter.type === "identifier") identifierCount += 1;
    }
    arities.add(parameterCount || identifierCount);
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
    typeAritiesByNamespace,
    hasGlobalType,
  };
}
