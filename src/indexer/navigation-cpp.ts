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

function definitionIdentityKey(def: SymbolDef): string {
  return `${fileIdentityKey(def.file)}:${def.range.start.index ?? `${def.range.start.line}:${def.range.start.column}`}`;
}

function addCppFunctionExportTargets(
  moduleEntry: ModuleIndex,
  name: string,
  defs: SymbolDef[],
  seen: Set<string>,
): void {
  for (const entry of moduleEntry.exports) {
    if (entry.type !== "local" || entry.exportedAs !== name || entry.target.kind !== SymbolKind.Function) continue;
    const key = definitionIdentityKey(entry.target);
    if (seen.has(key)) continue;
    seen.add(key);
    defs.push(entry.target);
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
  addCppFunctionExportTargets(sourceModule, name, defs, seen);
  for (const imp of sourceModule.imports) {
    const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
    if (!targetFile) continue;
    const targetModule = index.byFile.get(fileIdentityKey(targetFile));
    if (!targetModule) continue;
    if (imp.kind === "named") {
      if (imp.local === name || imp.imported === name) {
        addCppFunctionExportTargets(targetModule, imp.imported, defs, seen);
      }
    } else if (imp.kind === "star") {
      addCppFunctionExportTargets(targetModule, name, defs, seen);
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
      let canonicalName = binding.canonicalName;
      for (const [qualifiedName, bindings] of scopeIndex.cppQualifiedFunctionBindings) {
        if (!bindings.includes(binding)) continue;
        canonicalName = qualifiedName;
        break;
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
