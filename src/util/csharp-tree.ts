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
const CSHARP_PREPROCESSOR_WRAPPER_TYPES: Record<string, true> = {
  preproc_if: true,
  preproc_elif: true,
  preproc_else: true,
};
/**
 * Nodes a using directive can sit under: the compilation unit, namespace bodies, and conditional-compilation
 * wrappers. `ERROR` is a recovery node that keeps the directives the grammar could not place in a namespace.
 * Type declarations are absent, so a walk never enters a type body.
 */
const CSHARP_DIRECTIVE_CONTAINER_TYPES: Record<string, true> = {
  compilation_unit: true,
  namespace_declaration: true,
  declaration_list: true,
  ERROR: true,
  ...CSHARP_PREPROCESSOR_WRAPPER_TYPES,
};

/** Marks a declared type name only its own file can see (a C# 11 `file` type); other files' lookups skip it. */
export const CSHARP_FILE_LOCAL_PREFIX = "file ";

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

/**
 * A C# namespace declaration and the source span it governs. A block-scoped namespace spans from its
 * `namespace` keyword to its closing `}`; a file-scoped one spans to the end of the file. Nested block
 * scopes compose their names (`Outer` and `Outer.Inner`), so the innermost region containing a declaration
 * is its namespace. The global namespace (`""`) spans the whole file when the file declares a type outside
 * every namespace and also opens a namespace.
 */
export type CsharpNamespaceRegion = {
  name: string;
  start: number;
  end: number;
};

/**
 * What one C# file declares, read from its own syntax tree and stored with its module. Nothing here depends
 * on another file, so a cached module stays valid while its source does; lookups that need other files'
 * declarations combine these facts across the index when they run.
 */
export type CsharpNamespaceFacts = {
  /** Namespace regions in source order, each opened by this file. */
  regions: CsharpNamespaceRegion[];
  /**
   * Types without type parameters declared directly in a namespace, as dotted names (`Outer.Inner.Type`):
   * a bare name `X` never binds `X<T>`. A C# 11 `file` type carries {@link CSHARP_FILE_LOCAL_PREFIX},
   * because only this file can see it.
   */
  types: string[];
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

/**
 * Returns C# using/extern-alias directives in source order from the projected native tree. Only the
 * compilation unit, namespace bodies, and conditional-compilation wrappers can hold one, so the walk never
 * enters a type.
 */
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
    if (!CSHARP_DIRECTIVE_CONTAINER_TYPES[node.type]) continue;
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

/**
 * The namespace enclosing `position` in a file's regions (`""` for the global namespace): the containing
 * region that starts last, which is the innermost of properly nested regions. Without a position, `""`.
 */
export function csharpNamespaceAtIndex(
  regions: readonly CsharpNamespaceRegion[],
  position: number | undefined,
): string {
  if (position === undefined) return "";
  let innermost: CsharpNamespaceRegion | undefined;
  for (const region of regions) {
    if (position < region.start || position >= region.end) continue;
    if (!innermost || region.start >= innermost.start) innermost = region;
  }
  return innermost?.name ?? "";
}

/**
 * The namespace facts of one file, read from its own syntax tree. This is the single collector: the index
 * stores the result with the file's module, and every later lookup reads it from there.
 */
export function collectCsharpNamespaceFacts(tree: SyntaxTreeLike): CsharpNamespaceFacts {
  const regions: CsharpNamespaceRegion[] = [];
  const types = new Set<string>();
  const sourceEnd = tree.rootNode.endIndex;
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
    const children = node.namedChildren;
    // A bare name `X` binds a type with no type parameters, never `X<T>`.
    if (children.some((child) => child.type === "type_parameter_list")) return;
    const nameNode = node.childForFieldName("name");
    const name = nameNode ? normalizeCsharpIdentifier(nameNode.text) : "";
    if (!name) return;
    const declared = `${namespaceName}.${name}`;
    const isFileLocal = children.some((child) => child.type === "modifier" && child.text === "file");
    types.add(isFileLocal ? CSHARP_FILE_LOCAL_PREFIX + declared : declared);
  };

  const visitNamespaceMembers = (members: readonly SyntaxNodeLike[], namespaceName: string): void => {
    for (const member of members) {
      if (CSHARP_PREPROCESSOR_WRAPPER_TYPES[member.type]) {
        visitNamespaceMembers(member.namedChildren, namespaceName);
        continue;
      }
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
    visitNamespaceMembers(body.namedChildren, name);
  };

  let rootNamespace: string | null = null;
  let sawNamespaceDeclaration = false;
  const visitCompilationUnitMembers = (members: readonly SyntaxNodeLike[]): void => {
    for (const member of members) {
      if (CSHARP_PREPROCESSOR_WRAPPER_TYPES[member.type]) {
        visitCompilationUnitMembers(member.namedChildren);
        continue;
      }
      if (member.type === "file_scoped_namespace_declaration") {
        if (sawNamespaceDeclaration) continue;
        rootNamespace = qualifiedNamespace(null, member);
        if (!rootNamespace) continue;
        regions.push({ name: rootNamespace, start: member.startIndex, end: sourceEnd });
        sawNamespaceDeclaration = true;
      } else if (member.type === "namespace_declaration") {
        sawNamespaceDeclaration = true;
        visitBlockNamespace(member, rootNamespace);
      } else if (CSHARP_TYPE_DECLARATION_TYPES[member.type]) {
        addType(member, rootNamespace);
      }
    }
  };
  visitCompilationUnitMembers(tree.rootNode.namedChildren);

  // A type outside every namespace makes the whole file a global-namespace peer of the namespaces it also opens.
  if (regions.length && hasGlobalType) regions.unshift({ name: "", start: 0, end: sourceEnd });
  return { regions, types: [...types] };
}

function isCsharpNamespaceRegion(value: unknown): value is CsharpNamespaceRegion {
  if (!value || typeof value !== "object") return false;
  const region = value as { name?: unknown; start?: unknown; end?: unknown };
  const { name, start, end } = region;
  return (
    typeof name === "string" &&
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end >= start
  );
}

/** Whether a persisted value has the shape of {@link CsharpNamespaceFacts}. Both cache layers validate rows with it. */
export function isCsharpNamespaceFacts(value: unknown): value is CsharpNamespaceFacts {
  if (!value || typeof value !== "object") return false;
  const facts = value as { regions?: unknown; types?: unknown };
  return (
    Array.isArray(facts.regions) &&
    facts.regions.every(isCsharpNamespaceRegion) &&
    Array.isArray(facts.types) &&
    facts.types.every((type) => typeof type === "string")
  );
}

/**
 * `node` itself, or its nearest ancestor that is not a `#if`, `#elif`, or `#else` wrapper: the
 * scope a conditionally compiled declaration belongs to.
 */
export function csharpSkipConditionalWrappers(node: SyntaxNodeLike | null): SyntaxNodeLike | null {
  let scope = node;
  while (scope && CSHARP_PREPROCESSOR_WRAPPER_TYPES[scope.type]) scope = scope.parent;
  return scope;
}
