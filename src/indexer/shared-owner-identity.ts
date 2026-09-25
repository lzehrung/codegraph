import fs from "node:fs";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { getNativeSyntaxTreeExecution } from "../native/tree-sitter-native.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText } from "../util/ast.js";
import { normalizeCsharpQualifiedName } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import type { ParsedFileContext } from "./parse-context.js";
import type { ProjectIndex, SymbolDef } from "./types.js";

/**
 * Owner identity shared by C# `partial` type parts and Swift types/extensions.
 * C# includes declaration kind, own generic arity, and enclosing generic arities.
 * A Swift extension with a where clause cannot donate members to an unproven receiver.
 * A C# 11 `file` type is scoped to its declaring file, so `fileLocalTo` holds that file and
 * two same-path `file partial` owners in different files stay distinct types.
 */
export type SharedOwnerIdentity = {
  languageId: string;
  fullPath: string;
  declarationKind?: string;
  genericArity?: number;
  swiftConstraint?: string;
  fileLocalTo?: string;
};

export const CSHARP_PARTIAL_CONTAINER_TYPES = new Set([
  "class_declaration",
  "struct_declaration",
  "record_declaration",
  "interface_declaration",
]);

function csharpModifierHas(node: SyntaxNodeLike, source: string, keyword: string): boolean {
  const text = sliceText(node, source).trim();
  return text === keyword || text.split(/\s+/).includes(keyword);
}

/** True when the declaration's own modifier list (not its body or bases) contains `keyword`. */
function csharpContainerHasModifier(container: SyntaxNodeLike, source: string, keyword: string): boolean {
  const body = container.childForFieldName("body");
  for (const child of container.namedChildren ?? []) {
    if (body && child.id === body.id) continue;
    if (child.type === "declaration_list" || child.type === "class_body" || child.type === "base_list") {
      continue;
    }
    if (child.type === "modifier" && csharpModifierHas(child, source, keyword)) return true;
    if (child.type === "modifiers") {
      for (const nested of child.namedChildren ?? []) {
        if (nested.type === "modifier" && csharpModifierHas(nested, source, keyword)) return true;
      }
    }
  }
  return false;
}

function isCSharpPartialContainer(container: SyntaxNodeLike, source: string): boolean {
  return CSHARP_PARTIAL_CONTAINER_TYPES.has(container.type) && csharpContainerHasModifier(container, source, "partial");
}

/** A `file` modifier on the type or any enclosing type makes the owner file-local. */
function csharpOwnerIsFileLocal(container: SyntaxNodeLike, source: string): boolean {
  for (let current: SyntaxNodeLike | null = container; current; current = current.parent) {
    if (CSHARP_PARTIAL_CONTAINER_TYPES.has(current.type) && csharpContainerHasModifier(current, source, "file")) {
      return true;
    }
  }
  return false;
}

/** Declared C# name with verbatim `@` and formatting characters removed, per identifier equality. */
function csharpNameText(node: SyntaxNodeLike | null, source: string): string {
  if (!node) return "";
  return normalizeCsharpQualifiedName(sliceText(node, source));
}

function csharpGenericArity(container: SyntaxNodeLike): number {
  const typeParameters =
    container.childForFieldName("type_parameters") ??
    (container.namedChildren ?? []).find((child) => child.type === "type_parameter_list") ??
    null;
  if (!typeParameters) return 0;
  const parameters = (typeParameters.namedChildren ?? []).filter((child) => child.type === "type_parameter");
  if (parameters.length) return parameters.length;
  return (typeParameters.namedChildren ?? []).filter((child) => child.type === "identifier").length;
}

/**
 * Enclosing type segment carrying its generic arity compiler-style (`Outer`1`).
 * A backtick cannot appear in a C# type or namespace name, so an encoded
 * segment can never collide with a declared name and dot-joined namespace
 * parts stay unambiguous.
 */
function csharpEnclosingSegment(name: string, arity: number): string {
  return arity > 0 ? `${name}\`${arity}` : name;
}

/**
 * Namespace + enclosing type names (each carrying its generic arity) + the
 * type name. The container's own arity is stored on
 * {@link SharedOwnerIdentity} instead of encoding it into this path.
 */
function getCSharpFullPath(container: SyntaxNodeLike, source: string): string | null {
  const nameNode = container.childForFieldName("name");
  const typeName = csharpNameText(nameNode, source);
  if (!typeName) return null;
  const outer: string[] = [];
  const namespaces: string[] = [];
  let current = container.parent;
  while (current) {
    if (CSHARP_PARTIAL_CONTAINER_TYPES.has(current.type)) {
      const outerName = csharpNameText(current.childForFieldName("name"), source);
      if (outerName) outer.push(csharpEnclosingSegment(outerName, csharpGenericArity(current)));
    }
    if (current.type === "namespace_declaration" || current.type === "file_scoped_namespace_declaration") {
      const nsNode =
        current.childForFieldName("name") ??
        (current.namedChildren ?? []).find((child) => child.type === "identifier" || child.type === "qualified_name");
      const nsText = csharpNameText(nsNode ?? null, source);
      if (nsText) namespaces.push(nsText);
    }
    current = current.parent;
  }
  outer.reverse();
  namespaces.reverse();
  const parts = [...namespaces, ...outer, typeName];
  return parts.join(".");
}

function swiftKeywordText(container: SyntaxNodeLike, source: string): string {
  const kind = container.childForFieldName("declaration_kind");
  if (kind) {
    const text = sliceText(kind, source).trim();
    if (text) return text;
  }
  const first = container.child(0);
  return first ? sliceText(first, source).trim() : "";
}

export function isSwiftExtensionContainer(container: SyntaxNodeLike, source: string): boolean {
  return container.type === "class_declaration" && swiftKeywordText(container, source) === "extension";
}
function appendSwiftConstraintTokens(node: SyntaxNodeLike, source: string, tokens: string[]): void {
  if (node.type === "comment" || node.type === "line_comment" || node.type === "multiline_comment") return;
  const first = node.child(0);
  if (!first) {
    tokens.push(sliceText(node, source));
    return;
  }
  appendSwiftConstraintTokens(first, source, tokens);
  for (let index = 1; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    appendSwiftConstraintTokens(child, source, tokens);
  }
}

function swiftConstraintKey(container: SyntaxNodeLike, source: string): string | null {
  if (!isSwiftExtensionContainer(container, source)) return null;
  const constraints = (container.namedChildren ?? []).find((child) => child.type === "type_constraints");
  if (!constraints) return null;
  // Leaf tokens ignore trivia but preserve token boundaries and literal contents.
  // Different constraint expressions remain separate; semantic equivalence is not inferred.
  const tokens: string[] = [];
  appendSwiftConstraintTokens(constraints, source, tokens);
  return JSON.stringify(tokens);
}

export function isSwiftConstrainedExtension(container: SyntaxNodeLike, source: string): boolean {
  return swiftConstraintKey(container, source) !== null;
}

function isSwiftTypeContainer(container: SyntaxNodeLike, source: string): boolean {
  if (container.type !== "class_declaration") return false;
  const text = swiftKeywordText(container, source);
  return text === "class" || text === "struct" || text === "enum" || text === "actor";
}

function swiftNameText(container: SyntaxNodeLike, source: string): string | null {
  const nameNode = container.childForFieldName("name");
  if (!nameNode) return null;
  const text = sliceText(nameNode, source).trim();
  return text ? text : null;
}

function getSwiftFullPath(container: SyntaxNodeLike, source: string): string | null {
  const raw = swiftNameText(container, source);
  if (!raw) return null;
  const nameParts = raw
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!nameParts.length) return null;
  const outer: string[] = [];
  let current = container.parent;
  while (current) {
    if (current.type === "class_declaration") {
      const outerRaw = swiftNameText(current, source);
      if (outerRaw) {
        const outerParts = outerRaw
          .split(".")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        for (let i = outerParts.length - 1; i >= 0; i -= 1) outer.push(outerParts[i] as string);
      }
    }
    current = current.parent;
  }
  outer.reverse();
  return [...outer, ...nameParts].join(".");
}

/**
 * `file` is the declaring file path. It is required to scope C# `file` owners and must be the
 * same spelling for every part of one file (callers pass the module or peer file).
 */
export function getSharedOwnerIdentity(
  container: SyntaxNodeLike,
  source: string,
  languageId: string,
  file: string,
): SharedOwnerIdentity | null {
  if (languageId === "csharp") {
    if (!isCSharpPartialContainer(container, source)) return null;
    const fullPath = getCSharpFullPath(container, source);
    if (!fullPath) return null;
    return {
      languageId,
      fullPath,
      declarationKind: container.type,
      genericArity: csharpGenericArity(container),
      ...(csharpOwnerIsFileLocal(container, source) ? { fileLocalTo: fileIdentityKey(file) } : {}),
    };
  }
  if (languageId === "swift") {
    if (isSwiftExtensionContainer(container, source) || isSwiftTypeContainer(container, source)) {
      const swiftConstraint = swiftConstraintKey(container, source);
      const fullPath = getSwiftFullPath(container, source);
      if (!fullPath) return null;
      return { languageId, fullPath, ...(swiftConstraint !== null ? { swiftConstraint } : {}) };
    }
    return null;
  }
  return null;
}

/** The first owner can access members of the second owner without proving Swift constraints. */
export function sharedOwnerCanUseMembers(left: SharedOwnerIdentity, right: SharedOwnerIdentity): boolean {
  return (
    left.languageId === right.languageId &&
    left.fullPath === right.fullPath &&
    (left.declarationKind ?? "") === (right.declarationKind ?? "") &&
    (left.genericArity ?? 0) === (right.genericArity ?? 0) &&
    (left.fileLocalTo ?? "") === (right.fileLocalTo ?? "") &&
    (right.swiftConstraint === undefined || left.swiftConstraint === right.swiftConstraint)
  );
}

function sharedOwnerIdentityKey(identity: SharedOwnerIdentity): string {
  return `${identity.languageId}\0${identity.fullPath}\0${identity.declarationKind ?? ""}\0${identity.genericArity ?? 0}\0${identity.fileLocalTo ?? ""}`;
}

function sourceForIdentity(index: ProjectIndex, file: string, fileKey: string): string | null {
  const retained = index.parsed?.get(fileKey)?.source;
  if (retained !== undefined) return retained;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const identityParsedCaches = new WeakMap<ProjectIndex, Map<string, ParsedFileContext | null>>();

function parsedContextForIdentity(index: ProjectIndex, file: string): ParsedFileContext | null {
  const fileKey = fileIdentityKey(file);
  const retained = index.parsed?.get(fileKey);
  if (retained) return retained;

  let cache = identityParsedCaches.get(index);
  if (!cache) {
    cache = new Map();
    identityParsedCaches.set(index, cache);
  }
  if (cache.has(fileKey)) return cache.get(fileKey) ?? null;

  const source = sourceForIdentity(index, file, fileKey);
  const sup = supportForFileWithoutHeaderSample(file, index.languageExtensions);
  if (source === null || !sup || sup.id !== "csharp") {
    cache.set(fileKey, null);
    return null;
  }
  const execution = getNativeSyntaxTreeExecution(source, sup, index.nativeMode);
  if (!execution.tree) {
    cache.set(fileKey, null);
    return null;
  }
  const context: ParsedFileContext = {
    source,
    tree: new ProjectedSyntaxTree(source, execution.tree),
    sup,
    nativeQueries: null,
  };
  cache.set(fileKey, context);
  return context;
}

function csharpContainerAtRange(tree: SyntaxTreeLike, range: Range): SyntaxNodeLike | null {
  const root = tree.rootNode;
  const startIndex = range.start.index;
  const node =
    typeof startIndex === "number"
      ? root.descendantForIndex(startIndex, range.end.index ?? startIndex)
      : root.descendantForPosition(
          { row: Math.max(0, range.start.line - 1), column: Math.max(0, range.start.column - 1) },
          { row: Math.max(0, range.start.line - 1), column: Math.max(0, range.start.column - 1) },
        );
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (CSHARP_PARTIAL_CONTAINER_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

const partialExportIdentities = new WeakMap<ProjectIndex, Map<string, SharedOwnerIdentity | null>>();

function definitionIdentityCacheKey(def: SymbolDef): string {
  const start = def.range.start;
  return `${fileIdentityKey(def.file)}:${start.index ?? `${start.line}:${start.column}`}`;
}

function csharpPartialExportIdentity(index: ProjectIndex, def: SymbolDef): SharedOwnerIdentity | null {
  const cacheKey = definitionIdentityCacheKey(def);
  let cache = partialExportIdentities.get(index);
  if (!cache) {
    cache = new Map();
    partialExportIdentities.set(index, cache);
  }
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const languageId = supportForFileWithoutHeaderSample(def.file, index.languageExtensions)?.id;
  if (languageId !== "csharp") {
    cache.set(cacheKey, null);
    return null;
  }
  const context = parsedContextForIdentity(index, def.file);
  if (!context) {
    cache.set(cacheKey, null);
    return null;
  }
  const container = csharpContainerAtRange(context.tree, def.range);
  const identity = container ? getSharedOwnerIdentity(container, context.source, "csharp", def.file) : null;
  cache.set(cacheKey, identity);
  return identity;
}

function compareSymbolDefsDeterministic(left: SymbolDef, right: SymbolDef): number {
  const leftFile = fileIdentityKey(left.file);
  const rightFile = fileIdentityKey(right.file);
  if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1;
  const leftIndex = left.range.start.index;
  const rightIndex = right.range.start.index;
  if (typeof leftIndex === "number" && typeof rightIndex === "number" && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  if (left.range.start.line !== right.range.start.line) return left.range.start.line - right.range.start.line;
  return left.range.start.column - right.range.start.column;
}

/** Deterministic representative among proven-equivalent C# partial type parts. */
export function selectCsharpPartialRepresentative(group: readonly SymbolDef[]): SymbolDef {
  let best = group[0]!;
  for (let i = 1; i < group.length; i += 1) {
    const candidate = group[i]!;
    if (compareSymbolDefsDeterministic(candidate, best) < 0) best = candidate;
  }
  return best;
}

/**
 * Collapse proven-equivalent C# `partial` type declarations to one representative
 * before implicit-unit uniqueness is judged. Non-partial same-name types, other
 * kinds, other generic arities, and other enclosing owners stay distinct.
 * Lookup stays on the candidate list already collected from compilation-unit peers.
 */
export function coalesceEquivalentCsharpPartialExports(
  index: ProjectIndex,
  matches: readonly SymbolDef[],
): SymbolDef[] {
  if (matches.length <= 1) return [...matches];

  const grouped = new Map<string, SymbolDef[]>();
  const unmatched: SymbolDef[] = [];
  for (const match of matches) {
    const identity = csharpPartialExportIdentity(index, match);
    if (!identity) {
      unmatched.push(match);
      continue;
    }
    const key = sharedOwnerIdentityKey(identity);
    const group = grouped.get(key);
    if (group) group.push(match);
    else grouped.set(key, [match]);
  }

  const coalesced = [...unmatched];
  for (const group of grouped.values()) {
    coalesced.push(selectCsharpPartialRepresentative(group));
  }
  return coalesced;
}
