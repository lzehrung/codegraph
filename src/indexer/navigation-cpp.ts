import { supportForFileWithoutHeaderSample, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { cppQualifiedNameSegments } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { fileIdentityKey } from "../util/paths.js";
import type { FileId } from "../types.js";
import { ensureParsedContext } from "./parse-context.js";
import {
  cppBindingCallableShape,
  cppEquivalentCallableBindings,
  cppSelectCallableByCallArity,
  cppSelectCallableBinding,
} from "./cpp-callables.js";
import { getOrBuildScopeIndex } from "./navigation-local.js";
import type { Binding } from "./scope-types.js";
import { definitionIdentityKey } from "./reference-context.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";

const CPP_MEMBER_CONTAINER_TYPES = new Set(["class_specifier", "struct_specifier", "union_specifier"]);
export type CppParsedFile = { source: string; tree: SyntaxTreeLike; sup?: LanguageSupport };
type CppParsedFileLoader = (file: string) => Promise<CppParsedFile | null>;

const resolutionCache = new WeakMap<ProjectIndex, Map<string, Promise<SymbolDef | null>>>();

function cppBindingDefinition(file: FileId, binding: Binding): SymbolDef | null {
  if (!binding.def) return null;
  return {
    file,
    localName: binding.name,
    kind: SymbolKind.Function,
    range: binding.def,
  };
}

export function resolveCppCallableBindings(
  file: FileId,
  bindings: readonly Binding[],
  node: SyntaxNodeLike,
  source: string,
): SymbolDef | null {
  const target = cppSelectCallableBinding(bindings, node, source);
  return target ? cppBindingDefinition(file, target) : null;
}

/**
 * Undefined means the lexical binding is not a C++ callable that needs arity
 * selection. Null means no unique target after declaration-site and known-call-arity checks.
 */
export function resolveCppCollidingBinding(
  file: FileId,
  binding: Binding,
  node: SyntaxNodeLike,
  source: string,
): SymbolDef | null | undefined {
  if (binding.kind !== "function") return undefined;
  const collisions = binding.sameScopeFunctionBindings ?? [binding];
  if (collisions.length < 2 && !cppBindingCallableShape(binding)) return undefined;
  return resolveCppCallableBindings(file, collisions, node, source);
}

/** A using-declaration introduces its target, not a new local definition. */
export function cppUsingDeclarationTarget(binding: Binding, source: string): string | undefined {
  const qualified = binding.node?.parent;
  if (qualified?.type !== "qualified_identifier" || qualified.parent?.type !== "using_declaration") {
    return undefined;
  }
  return cppQualifiedNameSegments(qualified, source).join("::") || undefined;
}

function addCppFunctionExportTargets(
  index: ProjectIndex,
  moduleEntry: ModuleIndex,
  name: string,
  defs: SymbolDef[],
  seen: Set<string>,
): void {
  const moduleKey = `${fileIdentityKey(moduleEntry.file)}\0${name}`;
  if (seen.has(moduleKey)) return;
  seen.add(moduleKey);
  for (const entry of moduleEntry.exports) {
    if (entry.type === "exportStar" || entry.exportedAs !== name) continue;
    if (entry.type === "local" && entry.target.kind === SymbolKind.Function) {
      const key = definitionIdentityKey(entry.target);
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push(entry.target);
    } else if (entry.type === "reexport") {
      const target = index.byFile.get(fileIdentityKey(entry.fromModule));
      if (target) addCppFunctionExportTargets(index, target, entry.sourceSpecifier, defs, seen);
    }
  }
  for (const imp of moduleEntry.imports) {
    if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
    const target = index.byFile.get(fileIdentityKey(imp.resolved));
    if (target) addCppFunctionExportTargets(index, target, name, defs, seen);
  }
}

/** Function exports visible as `name` in this module, including include and using-alias targets. */
export function collectVisibleCppFunctionExports(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  name: string,
): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const seen = new Set<string>();
  addCppFunctionExportTargets(index, sourceModule, name, defs, seen);
  for (const imp of sourceModule.imports) {
    const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
    if (!targetFile) continue;
    const targetModule = index.byFile.get(fileIdentityKey(targetFile));
    if (!targetModule) continue;
    if (imp.kind === "named") {
      if (imp.local === name || imp.imported === name) {
        addCppFunctionExportTargets(index, targetModule, imp.imported, defs, seen);
      }
    }
  }
  return defs;
}

function localDefForBinding(index: ProjectIndex, file: FileId, binding: Binding): SymbolDef | null {
  const synthesized = cppBindingDefinition(file, binding);
  if (!synthesized) return null;
  const moduleEntry = index.byFile.get(fileIdentityKey(file));
  return (
    moduleEntry?.locals.find(
      (candidate) =>
        candidate.kind === SymbolKind.Function &&
        candidate.range.start.index === binding.def?.start.index &&
        candidate.range.end.index === binding.def?.end.index,
    ) ?? synthesized
  );
}

/**
 * Selects among already-collected C++ function definitions by known call arity,
 * without treating a consumer's source position as a declaration site.
 */
export function resolveCppExportedCallables(
  index: ProjectIndex,
  defs: readonly SymbolDef[],
  node: SyntaxNodeLike,
  source: string,
  loadParsedFile: (file: string) => CppParsedFile | null,
  canonicalNameForDef?: (def: SymbolDef) => string | undefined,
): SymbolDef | null {
  const ownedBindings: Array<{ file: FileId; binding: Binding }> = [];
  const handled = new Set<Binding>();
  const canonicalNames = new Map<Binding, string>();
  const defsByFile = new Map<string, { file: FileId; defs: SymbolDef[] }>();
  for (const def of defs) {
    const fileKey = fileIdentityKey(def.file);
    const group = defsByFile.get(fileKey);
    if (group) group.defs.push(def);
    else defsByFile.set(fileKey, { file: def.file, defs: [def] });
  }
  for (const { file, defs: fileDefs } of defsByFile.values()) {
    const moduleEntry = index.byFile.get(fileIdentityKey(file));
    const parsed = loadParsedFile(file);
    const support = parsed?.sup ?? supportForFileWithoutHeaderSample(file, index.languageExtensions);
    if (!moduleEntry || !parsed || !support) return null;
    const scopeIndex = getOrBuildScopeIndex(index, file, parsed.source, support, moduleEntry, parsed.tree);
    for (const def of fileDefs) {
      const binding = scopeIndex.all.find(
        (candidate) =>
          candidate.kind === "function" &&
          candidate.def?.start.index === def.range.start.index &&
          candidate.def?.end.index === def.range.end.index,
      );
      if (!binding) return null;
      const explicitName = canonicalNameForDef?.(def);
      let canonicalName = explicitName ?? binding.canonicalName;
      if (!explicitName) {
        for (const [qualifiedName, bindings] of scopeIndex.cppQualifiedFunctionBindings) {
          if (!bindings.includes(binding)) continue;
          canonicalName = qualifiedName;
          break;
        }
      }
      for (const equivalent of cppEquivalentCallableBindings(binding)) {
        if (handled.has(equivalent)) continue;
        handled.add(equivalent);
        canonicalNames.set(equivalent, canonicalName);
        ownedBindings.push({ file, binding: equivalent });
      }
    }
  }
  if (!ownedBindings.length) return null;
  // Bindings may come from included headers; the query node is in the consumer.
  // Skip the declaration-site shortcut so coincident offsets cannot bypass arity.
  const selected = cppSelectCallableByCallArity(
    ownedBindings.map((entry) => entry.binding),
    node,
    source,
    canonicalNames,
  );
  if (!selected) return null;
  const owner = ownedBindings.find((entry) => entry.binding === selected);
  return owner ? localDefForBinding(index, owner.file, selected) : null;
}

/**
 * Undefined means this name has no visible C++ function exports. Null means no
 * unique target remains after known-call-arity checks.
 */
export function resolveVisibleCppCallableName(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  name: string,
  node: SyntaxNodeLike,
  source: string,
  loadParsedFile: (file: string) => CppParsedFile | null,
): SymbolDef | null | undefined {
  const defs = collectVisibleCppFunctionExports(index, sourceModule, name);
  if (!defs.length) return undefined;
  return resolveCppExportedCallables(index, defs, node, source, loadParsedFile);
}

export async function resolveVisibleCppCallableNameAsync(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  name: string,
  node: SyntaxNodeLike,
  source: string,
  currentFile?: { file: FileId; parsed: CppParsedFile },
): Promise<SymbolDef | null | undefined> {
  const defs = collectVisibleCppFunctionExports(index, sourceModule, name);
  if (!defs.length) return undefined;
  const parsedByFile = new Map<string, CppParsedFile>();
  if (currentFile) parsedByFile.set(fileIdentityKey(currentFile.file), currentFile.parsed);
  for (const def of defs) {
    const fileKey = fileIdentityKey(def.file);
    if (parsedByFile.has(fileKey)) continue;
    try {
      const parsed = await ensureParsedContext(def.file, index.parsed?.get(fileKey), index.languageExtensions);
      parsedByFile.set(fileKey, parsed);
    } catch {
      /* reduced mode: skip files that cannot be parsed */
    }
  }
  return resolveCppExportedCallables(
    index,
    defs,
    node,
    source,
    (file) => parsedByFile.get(fileIdentityKey(file)) ?? null,
  );
}

const CPP_USING_DIRECTIVE_NAME_TYPES: Record<string, true> = {
  identifier: true,
  namespace_identifier: true,
  type_identifier: true,
  qualified_identifier: true,
  nested_namespace_specifier: true,
};

const CPP_USING_DIRECTIVE_REJECT_SCOPES: Record<string, true> = {
  function_definition: true,
  lambda_expression: true,
  class_specifier: true,
  struct_specifier: true,
  union_specifier: true,
};

type CppUsingDirective = {
  fileKey: string;
  startIndex: number;
  namespacePath: string[];
  enclosing: string[];
};

type CachedCppUsingDirectives = { fileKey: string; directives: readonly CppUsingDirective[] };

/**
 * Directives belong to the parsed tree. The star-import closure belongs to the
 * index and module. Bare-name lookup filters those lists per use. Both maps
 * disappear with their key, the same way the per-index WeakMaps in
 * navigation-references.ts do.
 */
const cppUsingDirectivesByTree = new WeakMap<SyntaxTreeLike, CachedCppUsingDirectives>();

const cppStarImportClosureCache = new WeakMap<ProjectIndex, Map<string, readonly ModuleIndex[]>>();

function cppStarImportClosure(index: ProjectIndex, sourceModule: ModuleIndex): readonly ModuleIndex[] {
  let byModule = cppStarImportClosureCache.get(index);
  if (!byModule) {
    byModule = new Map();
    cppStarImportClosureCache.set(index, byModule);
  }
  const moduleKey = fileIdentityKey(sourceModule.file);
  const cached = byModule.get(moduleKey);
  if (cached) return cached;
  const modules: ModuleIndex[] = [];
  const pending: ModuleIndex[] = [sourceModule];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    const key = fileIdentityKey(current.file);
    if (seen.has(key)) continue;
    seen.add(key);
    modules.push(current);
    for (const imp of current.imports) {
      if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
      const target = index.byFile.get(fileIdentityKey(imp.resolved));
      if (target) pending.push(target);
    }
  }
  byModule.set(moduleKey, modules);
  return modules;
}

function cppUsingDirectiveIsFileOrNamespaceScope(node: SyntaxNodeLike): boolean {
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (CPP_USING_DIRECTIVE_REJECT_SCOPES[current.type]) return false;
    current = current.parent;
  }
  return true;
}

function cppEnclosingNamespace(node: SyntaxNodeLike, source: string, fileKey: string): string[] {
  const nested: string[][] = [];
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (current.type === "namespace_definition") {
      const name = current.childForFieldName("name");
      if (name) {
        const segments = cppQualifiedNameSegments(name, source);
        if (segments.length) nested.push(segments);
      } else {
        nested.push([`\0anon:${fileKey}:${current.startIndex}`]);
      }
    }
    current = current.parent;
  }
  const path: string[] = [];
  for (let index = nested.length - 1; index >= 0; index -= 1) path.push(...nested[index]!);
  return path;
}

function cppNamespaceIsPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  if (prefix.length > path.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== path[index]) return false;
  }
  return true;
}

function cppUsingDirectiveFromNode(node: SyntaxNodeLike, source: string, fileKey: string): CppUsingDirective | null {
  if (node.type !== "using_declaration") return null;
  let hasNamespaceKeyword = false;
  let target: SyntaxNodeLike | null = null;
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    if (child.type === "namespace") hasNamespaceKeyword = true;
    else if (CPP_USING_DIRECTIVE_NAME_TYPES[child.type]) {
      if (!target || child.type === "qualified_identifier" || child.type === "nested_namespace_specifier") {
        target = child;
      }
    }
  }
  if (!hasNamespaceKeyword || !target || !cppUsingDirectiveIsFileOrNamespaceScope(node)) return null;
  const namespacePath =
    target.type === "identifier" || target.type === "namespace_identifier" || target.type === "type_identifier"
      ? [target.text.trim()]
      : cppQualifiedNameSegments(target, source);
  if (!namespacePath.length || namespacePath.some((segment) => segment.length === 0)) return null;
  return {
    fileKey,
    startIndex: node.startIndex,
    namespacePath,
    enclosing: cppEnclosingNamespace(node, source, fileKey),
  };
}

function collectCppUsingDirectives(
  root: SyntaxNodeLike,
  source: string,
  fileKey: string,
  out: CppUsingDirective[],
): void {
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "using_declaration") {
      const directive = cppUsingDirectiveFromNode(node, source, fileKey);
      if (directive) out.push(directive);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
}

function cppUsingDirectivesForFile(
  tree: SyntaxTreeLike,
  source: string,
  fileKey: string,
): readonly CppUsingDirective[] {
  const cached = cppUsingDirectivesByTree.get(tree);
  if (cached?.fileKey === fileKey) return cached.directives;
  const directives: CppUsingDirective[] = [];
  collectCppUsingDirectives(tree.rootNode, source, fileKey, directives);
  cppUsingDirectivesByTree.set(tree, { fileKey, directives });
  return directives;
}

function addCppNamedExportTargets(
  index: ProjectIndex,
  moduleEntry: ModuleIndex,
  name: string,
  defs: SymbolDef[],
  seen: Set<string>,
): void {
  const moduleKey = `${fileIdentityKey(moduleEntry.file)}\0${name}`;
  if (seen.has(moduleKey)) return;
  seen.add(moduleKey);
  for (const entry of moduleEntry.exports) {
    if (entry.type === "exportStar" || entry.exportedAs !== name) continue;
    if (entry.type === "local") {
      const key = definitionIdentityKey(entry.target);
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push(entry.target);
    } else if (entry.type === "reexport") {
      const target = index.byFile.get(fileIdentityKey(entry.fromModule));
      if (target) addCppNamedExportTargets(index, target, entry.sourceSpecifier, defs, seen);
    }
  }
  for (const imp of moduleEntry.imports) {
    if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
    const target = index.byFile.get(fileIdentityKey(imp.resolved));
    if (target) addCppNamedExportTargets(index, target, name, defs, seen);
  }
}

function collectVisibleCppExportTargets(index: ProjectIndex, sourceModule: ModuleIndex, name: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const seen = new Set<string>();
  addCppNamedExportTargets(index, sourceModule, name, defs, seen);
  for (const imp of sourceModule.imports) {
    if (imp.kind !== "named" || typeof imp.resolved !== "string") continue;
    if (imp.local !== name && imp.imported !== name) continue;
    const targetModule = index.byFile.get(fileIdentityKey(imp.resolved));
    if (targetModule) addCppNamedExportTargets(index, targetModule, imp.imported, defs, seen);
  }
  return defs;
}

function cppIncludeSpec(pathNode: SyntaxNodeLike): { text: string; form: "literal" | "angle" } | undefined {
  const raw = pathNode.text.trim();
  if (pathNode.type === "string_literal" && raw.length >= 2) return { text: raw.slice(1, -1), form: "literal" };
  if (pathNode.type === "system_lib_string" && raw.length >= 2) return { text: raw.slice(1, -1), form: "angle" };
  return undefined;
}

/**
 * The earliest offset in the use file at which each file enters the translation unit through
 * an `#include`, directly or transitively. A file reached only through an include whose target
 * cannot be read from the source (a macro include) is absent.
 */
function cppIncludeEntryOffsets(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  node: SyntaxNodeLike,
): ReadonlyMap<string, number> {
  let root = node;
  while (root.parent) root = root.parent;
  const offsets = new Map<string, number>();
  const visit = (current: SyntaxNodeLike): void => {
    if (current.type === "preproc_include") {
      const pathNode = current.childForFieldName("path");
      const spec = pathNode ? cppIncludeSpec(pathNode) : undefined;
      if (!spec) return;
      for (const imp of sourceModule.imports) {
        if (imp.kind !== "star" || imp.from !== spec.text || typeof imp.resolved !== "string") continue;
        if (imp.includeForm && imp.includeForm !== spec.form) continue;
        const target = index.byFile.get(fileIdentityKey(imp.resolved));
        if (!target) continue;
        // Document order: the first include to reach a file is its earliest entry.
        for (const reached of cppStarImportClosure(index, target)) {
          const key = fileIdentityKey(reached.file);
          if (!offsets.has(key)) offsets.set(key, current.startIndex);
        }
      }
      return;
    }
    for (const child of current.namedChildren) visit(child);
  };
  visit(root);
  return offsets;
}

/**
 * Bare lookup through `using namespace`. Undefined means no directive nominates
 * this name. Null means more than one viable candidate, or the candidate could
 * not be proved unique. Block-scope directives are ignored.
 */
export function resolveCppUsingDirectiveName(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  name: string,
  node: SyntaxNodeLike,
  source: string,
  loadParsedFile: (file: string) => CppParsedFile | null,
): SymbolDef | null | undefined {
  if (!name || name.includes("::")) return undefined;
  const useFileKey = fileIdentityKey(sourceModule.file);
  const useNamespace = cppEnclosingNamespace(node, source, useFileKey);
  const directives: CppUsingDirective[] = [];
  for (const moduleEntry of cppStarImportClosure(index, sourceModule)) {
    const parsed = loadParsedFile(moduleEntry.file);
    if (!parsed?.tree) continue;
    directives.push(...cppUsingDirectivesForFile(parsed.tree, parsed.source, fileIdentityKey(moduleEntry.file)));
  }
  let entryOffsets: ReadonlyMap<string, number> | undefined;
  const unordered: CppUsingDirective[] = [];
  const applicable = directives.filter((directive) => {
    if (!cppNamespaceIsPrefix(directive.enclosing, useNamespace)) return false;
    if (directive.fileKey === useFileKey) return directive.startIndex < node.startIndex;
    // A header's directive is in scope only after the `#include` that brings it in.
    entryOffsets ??= cppIncludeEntryOffsets(index, sourceModule, node);
    const entry = entryOffsets.get(directive.fileKey);
    if (entry === undefined) {
      unordered.push(directive);
      return false;
    }
    return entry < node.startIndex;
  });
  // A directive whose include position cannot be read (a macro include) may or may not be
  // in scope. When it would nominate this name, the use stays unresolved.
  const unorderedNominates = unordered.some(
    (directive) =>
      collectVisibleCppExportTargets(index, sourceModule, `${directive.namespacePath.join("::")}::${name}`).length,
  );
  if (unorderedNominates) return null;
  if (!applicable.length) return undefined;

  const functionDefs: SymbolDef[] = [];
  const otherDefs: SymbolDef[] = [];
  const seen = new Set<string>();
  const qualifiedByDef = new Map<string, string>();
  for (const directive of applicable) {
    const qualified = `${directive.namespacePath.join("::")}::${name}`;
    for (const def of collectVisibleCppExportTargets(index, sourceModule, qualified)) {
      const key = definitionIdentityKey(def);
      if (seen.has(key)) continue;
      seen.add(key);
      qualifiedByDef.set(key, qualified);
      if (def.kind === SymbolKind.Function) functionDefs.push(def);
      else otherDefs.push(def);
    }
  }
  if (!functionDefs.length && !otherDefs.length) return undefined;
  if (functionDefs.length) {
    return resolveCppExportedCallables(index, functionDefs, node, source, loadParsedFile, (def) =>
      qualifiedByDef.get(definitionIdentityKey(def)),
    );
  }
  if (otherDefs.length === 1) return otherDefs[0]!;
  return null;
}

export async function resolveCppUsingDirectiveNameAsync(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  name: string,
  node: SyntaxNodeLike,
  source: string,
  currentFile?: { file: FileId; parsed: CppParsedFile },
): Promise<SymbolDef | null | undefined> {
  const parsedByFile = new Map<string, CppParsedFile>();
  if (currentFile) parsedByFile.set(fileIdentityKey(currentFile.file), currentFile.parsed);
  for (const moduleEntry of cppStarImportClosure(index, sourceModule)) {
    const key = fileIdentityKey(moduleEntry.file);
    if (parsedByFile.has(key)) continue;
    try {
      parsedByFile.set(
        key,
        await ensureParsedContext(moduleEntry.file, index.parsed?.get(key), index.languageExtensions),
      );
    } catch {
      /* reduced mode: skip files that cannot be parsed */
    }
  }
  return resolveCppUsingDirectiveName(
    index,
    sourceModule,
    name,
    node,
    source,
    (file) => parsedByFile.get(fileIdentityKey(file)) ?? null,
  );
}

function cppMemberContainerForDefinition(tree: SyntaxTreeLike, def: SymbolDef): SyntaxNodeLike | null {
  const position = {
    row: Math.max(0, def.range.start.line - 1),
    column: Math.max(0, def.range.start.column - 1),
  };
  let current: SyntaxNodeLike | null = tree.rootNode.descendantForPosition(position, position);
  while (current) {
    if (CPP_MEMBER_CONTAINER_TYPES.has(current.type)) {
      const name = current.childForFieldName("name");
      if (name && name.startPosition.row === position.row && name.startPosition.column === position.column) {
        return current;
      }
    }
    current = current.parent;
  }
  return null;
}

function cppMemberContainerPath(container: SyntaxNodeLike, source: string): string[] {
  const nested: string[][] = [];
  let current: SyntaxNodeLike | null = container;
  while (current) {
    if (CPP_MEMBER_CONTAINER_TYPES.has(current.type) || current.type === "namespace_definition") {
      const name = current.childForFieldName("name");
      if (name) {
        const segments = cppQualifiedNameSegments(name, source);
        if (segments.length) nested.push(segments);
      }
    }
    current = current.parent;
  }
  const path: string[] = [];
  for (let index = nested.length - 1; index >= 0; index -= 1) path.push(...nested[index]!);
  return path;
}

function sameCppPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

async function resolveCppQualifiedMemberContainerUncached(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  ownerPath: readonly string[],
  loadParsedFile?: CppParsedFileLoader,
): Promise<SymbolDef | null> {
  const ownerName = ownerPath.at(-1);
  if (!ownerName) return null;

  const reachable: ModuleIndex[] = [];
  const pending: ModuleIndex[] = [sourceModule];
  const visited = new Set<string>();
  while (pending.length) {
    const module = pending.pop()!;
    const moduleKey = fileIdentityKey(module.file);
    if (visited.has(moduleKey)) continue;
    visited.add(moduleKey);
    reachable.push(module);
    for (const imp of module.imports) {
      if (typeof imp.resolved !== "string") continue;
      const imported = index.byFile.get(fileIdentityKey(imp.resolved));
      if (imported) pending.push(imported);
    }
  }

  const matches: Array<{ def: SymbolDef; complete: boolean }> = [];
  const seen = new Set<string>();
  for (const module of reachable) {
    for (const candidate of module.locals) {
      if (candidate.localName !== ownerName) continue;
      const key = `${fileIdentityKey(candidate.file)}:${candidate.range.start.index ?? ""}:${candidate.range.end.index ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let parsed: CppParsedFile | null;
      if (loadParsedFile) {
        parsed = await loadParsedFile(candidate.file);
      } else {
        parsed = await ensureParsedContext(
          candidate.file,
          index.parsed?.get(fileIdentityKey(candidate.file)),
          index.languageExtensions,
        ).catch(() => null);
      }
      if (!parsed) continue;
      const container = cppMemberContainerForDefinition(parsed.tree, candidate);
      if (!container || !sameCppPath(cppMemberContainerPath(container, parsed.source), ownerPath)) continue;
      matches.push({ def: candidate, complete: !!container.childForFieldName("body") });
    }
  }
  const completeMatches = matches.filter((match) => match.complete);
  if (completeMatches.length === 1) return completeMatches[0]!.def;
  return matches.length === 1 ? matches[0]!.def : null;
}

/** Resolves one reachable C++ class/struct/union by its exact namespace and nesting path. */
export function resolveCppQualifiedMemberContainer(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  ownerPath: readonly string[],
  loadParsedFile?: CppParsedFileLoader,
): Promise<SymbolDef | null> {
  let byPath = resolutionCache.get(index);
  if (!byPath) {
    byPath = new Map();
    resolutionCache.set(index, byPath);
  }
  const key = `${fileIdentityKey(sourceModule.file)}\0${ownerPath.join("::")}`;
  let pending = byPath.get(key);
  if (!pending) {
    pending = resolveCppQualifiedMemberContainerUncached(index, sourceModule, ownerPath, loadParsedFile);
    byPath.set(key, pending);
  }
  return pending;
}
