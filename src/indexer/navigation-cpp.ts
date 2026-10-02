import { supportForFileWithoutHeaderSample, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { cppOutOfLineOwnerPath, cppQualifiedNameSegments } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { sliceText } from "../util/ast.js";
import { fileIdentityKey } from "../util/paths.js";
import type { FileId } from "../types.js";
import { ensureParsedContext } from "./parse-context.js";
import {
  cppEquivalentCallableBindings,
  cppSelectCallableByCallArity,
  cppSelectCallableBinding,
} from "./cpp-callables.js";
import { getOrBuildScopeIndex } from "./navigation-local.js";
import { fileScopeDefinitionCoversUse } from "./scope-nodes.js";
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
    ...(binding.callable ? { callable: binding.callable } : {}),
  };
}

export function resolveCppCallableBindings(
  file: FileId,
  bindings: readonly Binding[],
  node: SyntaxNodeLike,
  source: string,
): SymbolDef | null {
  const target = cppSelectCallableBinding(bindings, node, source, file, file);
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
  if (collisions.length < 2 && !binding.callable?.signature) return undefined;
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

/** A same-file overload enters the visible set at its first declaration, not its definition. */
function visibleCppFunctionExportsAt(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  defs: SymbolDef[],
  node: SyntaxNodeLike,
  loadParsedFile: (file: string) => CppParsedFile | null,
): SymbolDef[] {
  const sourceKey = fileIdentityKey(sourceModule.file);
  const useStart = node.startIndex;
  const laterInFile = (def: SymbolDef): boolean =>
    fileIdentityKey(def.file) === sourceKey && !fileScopeDefinitionCoversUse("cpp", def.range, useStart);
  if (!defs.some(laterInFile)) return defs;

  const parsed = loadParsedFile(sourceModule.file);
  const support = parsed?.sup ?? supportForFileWithoutHeaderSample(sourceModule.file, index.languageExtensions);
  const scopeIndex =
    parsed && support
      ? getOrBuildScopeIndex(index, sourceModule.file, parsed.source, support, sourceModule, parsed.tree)
      : null;
  return defs.filter((def) => {
    if (!laterInFile(def)) return true;
    const binding = scopeIndex?.all.find(
      (candidate) =>
        candidate.kind === "function" &&
        candidate.def?.start.index === def.range.start.index &&
        candidate.def?.end.index === def.range.end.index,
    );
    return (
      !!binding &&
      cppEquivalentCallableBindings(binding).some(
        (equivalent) => !!equivalent.def && fileScopeDefinitionCoversUse("cpp", equivalent.def, useStart),
      )
    );
  });
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
  const visibleDefs = visibleCppFunctionExportsAt(index, sourceModule, defs, node, loadParsedFile);
  if (!visibleDefs.length) return undefined;
  return resolveCppExportedCallables(index, visibleDefs, node, source, loadParsedFile);
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

export function cppStarImportClosure(index: ProjectIndex, sourceModule: ModuleIndex): readonly ModuleIndex[] {
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

type CppNamespaceAlias = {
  startIndex: number;
  name: string;
  target: readonly string[];
  enclosing: readonly string[];
  /** False inside a function or class: those aliases are block-scope, not namespace members. */
  namespaceScope: boolean;
};

type CachedCppNamespaceAliases = { fileKey: string; aliases: readonly CppNamespaceAlias[] };

const cppNamespaceAliasesByTree = new WeakMap<SyntaxTreeLike, CachedCppNamespaceAliases>();

function cppNamespaceAliasTargetSegments(node: SyntaxNodeLike, source: string): string[] | null {
  const name = node.childForFieldName("name");
  for (const child of node.namedChildren) {
    if (name && child.startIndex === name.startIndex && child.endIndex === name.endIndex) continue;
    if (
      child.type !== "namespace_identifier" &&
      child.type !== "nested_namespace_specifier" &&
      child.type !== "splice_specifier"
    ) {
      continue;
    }
    const segments = cppQualifiedNameSegments(child, source);
    if (segments.length) return segments;
  }
  return null;
}

function collectCppNamespaceAliases(root: SyntaxNodeLike, source: string, fileKey: string): CppNamespaceAlias[] {
  const aliases: CppNamespaceAlias[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "namespace_alias_definition") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? sliceText(nameNode, source) : "";
      const target = cppNamespaceAliasTargetSegments(node, source);
      if (name && target) {
        aliases.push({
          startIndex: node.startIndex,
          name,
          target,
          enclosing: cppEnclosingNamespace(node, source, fileKey),
          namespaceScope: cppUsingDirectiveIsFileOrNamespaceScope(node),
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return aliases;
}

function cppNamespaceAliasesForTree(
  tree: SyntaxTreeLike,
  source: string,
  fileKey: string,
): readonly CppNamespaceAlias[] {
  const cached = cppNamespaceAliasesByTree.get(tree);
  if (cached?.fileKey === fileKey) return cached.aliases;
  const aliases = collectCppNamespaceAliases(tree.rootNode, source, fileKey);
  cppNamespaceAliasesByTree.set(tree, { fileKey, aliases });
  return aliases;
}

function sameNamespacePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** A block-scope alias hides namespace aliases. The innermost preceding alias wins. */
function cppBlockNamespaceAliasTarget(
  node: SyntaxNodeLike,
  source: string,
  name: string,
  useStart: number,
): readonly string[] | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "compound_statement") continue;
    let found: readonly string[] | undefined;
    for (const child of current.namedChildren) {
      if (child.type !== "namespace_alias_definition" || child.startIndex >= useStart) continue;
      const nameNode = child.childForFieldName("name");
      if (!nameNode || sliceText(nameNode, source) !== name) continue;
      const target = cppNamespaceAliasTargetSegments(child, source);
      if (target) found = target;
    }
    if (found) return found;
  }
  return undefined;
}

type CppAliasFile = {
  aliases: readonly CppNamespaceAlias[];
  /** Position in the use file, or undefined when the alias is not yet visible. */
  positionOf: (alias: CppNamespaceAlias) => number | undefined;
};

/**
 * Latest visible namespace-scope alias of `name` in `enclosing`. A later declaration in the
 * translation unit wins; two aliases at the same position with different targets are ambiguous.
 */
function cppNamespaceScopeAliasTarget(
  files: readonly CppAliasFile[],
  enclosing: readonly string[],
  name: string,
): readonly string[] | null | undefined {
  let best: { position: number; tie: number; target: readonly string[] } | undefined;
  let ambiguous = false;
  for (const file of files) {
    for (const alias of file.aliases) {
      if (!alias.namespaceScope || alias.name !== name || !sameNamespacePath(alias.enclosing, enclosing)) continue;
      const position = file.positionOf(alias);
      if (position === undefined) continue;
      if (!best || position > best.position || (position === best.position && alias.startIndex > best.tie)) {
        best = { position, tie: alias.startIndex, target: alias.target };
        ambiguous = false;
      } else if (
        position === best.position &&
        alias.startIndex === best.tie &&
        alias.target.join("::") !== best.target.join("::")
      ) {
        ambiguous = true;
      }
    }
  }
  if (ambiguous) return null;
  return best?.target;
}

/**
 * Qualified name after namespace aliases visible at `node` (`dm::add` → `detailed_math::add`,
 * `namespace dm = a::b` → `a::b::add`). Undefined when no alias applies. Null when the alias
 * chain is cyclic or two aliases at one position disagree.
 */
export function cppQualifiedNameThroughNamespaceAlias(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  name: string,
  node: SyntaxNodeLike,
  source: string,
  tree: SyntaxTreeLike,
  loadParsedFile: (file: string) => CppParsedFile | null,
): string | null | undefined {
  if (!name.includes("::")) return undefined;
  const absolute = name.startsWith("::");
  const segments = name.split("::").filter((segment) => segment.length > 0);
  if (segments.length < 2) return undefined;

  const useFileKey = fileIdentityKey(sourceModule.file);
  const useStart = node.startIndex;
  const useNamespace = cppEnclosingNamespace(node, source, useFileKey);
  const files: CppAliasFile[] = [
    {
      aliases: cppNamespaceAliasesForTree(tree, source, useFileKey),
      positionOf: (alias) => (alias.startIndex < useStart ? alias.startIndex : undefined),
    },
  ];
  let entryOffsets: ReadonlyMap<string, number> | undefined;
  for (const moduleEntry of cppStarImportClosure(index, sourceModule)) {
    const fileKey = fileIdentityKey(moduleEntry.file);
    if (fileKey === useFileKey) continue;
    const parsed = loadParsedFile(moduleEntry.file);
    if (!parsed?.tree) continue;
    entryOffsets ??= cppIncludeEntryOffsets(index, sourceModule, node);
    const entry = entryOffsets.get(fileKey);
    files.push({
      aliases: cppNamespaceAliasesForTree(parsed.tree, parsed.source, fileKey),
      positionOf: () => (entry !== undefined && entry < useStart ? entry : undefined),
    });
  }

  const lookupAlias = (enclosing: readonly string[], aliasName: string): readonly string[] | null | undefined => {
    // A qualified prefix already names the namespace to search. An empty prefix is unqualified
    // lookup: a block alias, then the innermost enclosing namespace, then each outer one.
    if (enclosing.length > 0) return cppNamespaceScopeAliasTarget(files, enclosing, aliasName);
    if (!absolute) {
      const block = cppBlockNamespaceAliasTarget(node, source, aliasName, useStart);
      if (block) return block;
    }
    for (let length = useNamespace.length; length >= 0; length -= 1) {
      const found = cppNamespaceScopeAliasTarget(files, useNamespace.slice(0, length), aliasName);
      if (found === null) return null;
      if (found) return found;
    }
    return undefined;
  };

  const expandPrefix = (prefix: readonly string[], seen: Set<string>): readonly string[] | null | undefined => {
    let resolved: string[] = [];
    let changed = false;
    for (const segment of prefix) {
      const alias = lookupAlias(resolved, segment);
      if (alias === null) return null;
      if (!alias) {
        resolved.push(segment);
        continue;
      }
      const key = `${resolved.join("::")}\0${segment}`;
      if (seen.has(key)) return null;
      seen.add(key);
      changed = true;
      const nested = expandPrefix(alias, seen);
      if (nested === null) return null;
      resolved = [...(nested ?? alias)];
    }
    return changed ? resolved : undefined;
  };

  const expanded = expandPrefix(segments.slice(0, -1), new Set());
  if (expanded === null) return null;
  if (!expanded) return undefined;
  return [...expanded, segments[segments.length - 1]!].join("::");
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

function hasStaticStorageClass(node: SyntaxNodeLike): boolean {
  return node.namedChildren.some((child) => child.type === "storage_class_specifier" && child.text === "static");
}

/** The name a member declarator declares: `f` in `int f(int)`, `int A::f(int)`, or `int* f()`. */
function cppDeclaredMemberName(declaration: SyntaxNodeLike, source: string): string | null {
  let declarator = declaration.childForFieldName("declarator");
  while (declarator && declarator.type !== "function_declarator") {
    declarator = declarator.childForFieldName("declarator");
  }
  const name = declarator?.childForFieldName("declarator");
  if (!name) return null;
  return cppQualifiedNameSegments(name, source).at(-1) ?? null;
}

/**
 * Whether code inside a C++ function definition has an implicit `this`: the function is a
 * non-static member function, defined in its class body or out of line as `Owner::f`. A free
 * function (including a namespace-qualified one) and a static member function have none, so an
 * instance member cannot be named without an object there. Mixed static and non-static
 * declarations of the same name are not proven either way and count as static.
 */
export async function cppFunctionHasImplicitThis(
  index: ProjectIndex,
  sourceModule: ModuleIndex,
  definition: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  loadParsedFile?: CppParsedFileLoader,
): Promise<boolean> {
  if (sup.id !== "cpp" || definition.type !== "function_definition") return false;
  if (hasStaticStorageClass(definition)) return false;
  const ownerPath = cppOutOfLineOwnerPath(definition, source, sup);
  if (!ownerPath) {
    for (let current = definition.parent; current; current = current.parent) {
      if (CPP_MEMBER_CONTAINER_TYPES.has(current.type)) return true;
    }
    return false;
  }
  const owner = await resolveCppQualifiedMemberContainer(index, sourceModule, ownerPath, loadParsedFile);
  if (!owner) return false;
  const parsed = loadParsedFile
    ? await loadParsedFile(owner.file)
    : await ensureParsedContext(owner.file, undefined, index.languageExtensions);
  const body = parsed ? cppMemberContainerForDefinition(parsed.tree, owner)?.childForFieldName("body") : null;
  const memberName = cppDeclaredMemberName(definition, source);
  if (!body || !parsed || !memberName) return false;
  const declarations = body.namedChildren.filter((child) => cppDeclaredMemberName(child, parsed.source) === memberName);
  return declarations.length > 0 && declarations.every((declaration) => !hasStaticStorageClass(declaration));
}
