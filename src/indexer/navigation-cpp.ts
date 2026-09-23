import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { cppQualifiedNameSegments } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { fileIdentityKey } from "../util/paths.js";
import { ensureParsedContext } from "./parse-context.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "./types.js";

const CPP_MEMBER_CONTAINER_TYPES = new Set(["class_specifier", "struct_specifier", "union_specifier"]);
type CppParsedFile = { source: string; tree: SyntaxTreeLike };
type CppParsedFileLoader = (file: string) => Promise<CppParsedFile | null>;

const resolutionCache = new WeakMap<ProjectIndex, Map<string, Promise<SymbolDef | null>>>();

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
