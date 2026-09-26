import { supportForFileWithoutHeaderSample } from "../languages.js";
import { fileIdentityKey } from "../util/paths.js";
import type { ImportBinding } from "./import-types.js";
import { resolveImported } from "./navigation-resolve.js";
import { sameDef } from "./reference-context.js";
import type { ProjectIndex, SymbolDef } from "./types.js";

/**
 * What a language does when more than one star import can see the same simple name.
 *
 * `last-wins` — Python. A later `from module import *` rebinds every public name it
 * defines, so the last star (or a later explicit binding) is the name. Overlap is not
 * an ambiguity.
 * `explicit-beats-star` — Java, Kotlin, and Rust. A single-type import or an explicit
 * `use` beats every wildcard/glob, in either source order. Two wildcards or globs that
 * export the same simple name are a compile error.
 * `ambiguous` — Ruby `require` / `require_relative` / `load` / `autoload`, C and C++
 * `#include`, PHP `include`, Go dot-imports, Swift module imports, and C# `using`
 * namespace directives. Two distinct definitions are unresolved. An explicit named
 * import still wins when the language has one (a C# `using` alias), because that
 * binding is not a star import.
 *
 * Ruby stays `ambiguous` only when the same simple name is two qualified paths.
 * One qualified constant path is one constant: every part the use site's load
 * closure can see is a reopening, including when a third file loads both and
 * neither file loads the other. C and C++ functions are grouped by the callable
 * family in `navigation.ts` (same qualified name and signature); different
 * signatures are overloads, not star ambiguity. Same-name typedefs and structs
 * stay ambiguous.
 */
export type StarImportPrecedence = "last-wins" | "explicit-beats-star" | "ambiguous";

export const STAR_IMPORT_PRECEDENCE: Readonly<Record<string, StarImportPrecedence>> = {
  python: "last-wins",
  java: "explicit-beats-star",
  kotlin: "explicit-beats-star",
  rust: "explicit-beats-star",
  ruby: "ambiguous",
  c: "ambiguous",
  cpp: "ambiguous",
  php: "ambiguous",
  go: "ambiguous",
  swift: "ambiguous",
  csharp: "ambiguous",
};

export function starImportPrecedence(languageId: string): StarImportPrecedence {
  return STAR_IMPORT_PRECEDENCE[languageId] ?? "ambiguous";
}

/** Returned when star imports name more than one distinct definition. */
export const AMBIGUOUS_STAR_IMPORT_REASON = "Ambiguous star import";

export type StarImportCandidate = {
  imp: Extract<ImportBinding, { kind: "star" }>;
  def: SymbolDef;
};

export type StarImportDecision =
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "resolved"; imp: StarImportCandidate["imp"]; definition: SymbolDef };

function resolvedImportKey(resolved: ImportBinding["resolved"]): string {
  if (!resolved) return "";
  return typeof resolved === "string" ? `file:${fileIdentityKey(resolved)}` : `external:${resolved.external}`;
}

/**
 * `expandStarImports` copies each star import into a named or namespace binding with the
 * same `from` and resolved file, and without a source range. Those copies are the star
 * import, not an explicit one. An explicit binding (Java `import pkg.Type`, Python
 * `from a import name`, Rust `use a::Name`) keeps the range the statement attributed,
 * or an alias flag star expansion never sets.
 */
export function isExpandedStarBinding(binding: ImportBinding, imports: readonly ImportBinding[]): boolean {
  if (binding.kind !== "named" && binding.kind !== "namespace") return false;
  if (binding.explicitAlias) return false;
  if (binding.kind === "named" && (binding.localRange || binding.importedRange)) return false;
  if (binding.kind === "namespace" && binding.localRange) return false;
  const resolved = resolvedImportKey(binding.resolved);
  if (!resolved) return false;
  return imports.some(
    (candidate) =>
      candidate.kind === "star" &&
      candidate.from === binding.from &&
      resolvedImportKey(candidate.resolved) === resolved,
  );
}

export function resolveStarImportedDefinition(
  index: ProjectIndex,
  imp: ImportBinding,
  name: string,
  languageId: string,
  cNamespace?: "tag" | "ordinary",
): SymbolDef | null {
  if (imp.kind !== "star") return null;
  const result = resolveImported(index, imp, name, {
    ...(cNamespace ? { cNamespace } : {}),
    // Ruby star expansion already publishes exported constants. Local fallback would
    // resurrect a nested class as a bare name the exports query omitted.
    ...(languageId === "ruby" ? { allowLocalFallback: false } : {}),
  });
  if (!result || "namespace" in result) return null;
  return result;
}

function exportedNameForDef(index: ProjectIndex, def: SymbolDef): string | undefined {
  const mod = index.byFile.get(fileIdentityKey(def.file));
  if (!mod) return undefined;
  for (const entry of mod.exports) {
    if (entry.type !== "local") continue;
    if (!sameDef(entry.target, def, index.languageExtensions)) continue;
    return entry.exportedAs;
  }
  return undefined;
}

const rubyStarAdjacencyCache = new WeakMap<ProjectIndex, Map<string, readonly string[]>>();
const rubyLoadComponentCache = new WeakMap<ProjectIndex, Map<string, ReadonlySet<string>>>();

/**
 * Undirected `require` / `load` / `autoload` edges. A third file that loads two
 * declarations connects them even when neither file loads the other.
 */
function rubyStarAdjacency(index: ProjectIndex): Map<string, readonly string[]> {
  const cached = rubyStarAdjacencyCache.get(index);
  if (cached) return cached;
  const adjacency = new Map<string, string[]>();
  const link = (left: string, right: string): void => {
    if (left === right) return;
    const neighbors = adjacency.get(left);
    if (neighbors) {
      if (!neighbors.includes(right)) neighbors.push(right);
    } else {
      adjacency.set(left, [right]);
    }
  };
  for (const mod of index.byFile.values()) {
    const from = fileIdentityKey(mod.file);
    for (const imp of mod.imports) {
      if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
      const to = fileIdentityKey(imp.resolved);
      link(from, to);
      link(to, from);
    }
  }
  const stored = new Map<string, readonly string[]>();
  for (const [key, neighbors] of adjacency) stored.set(key, neighbors);
  rubyStarAdjacencyCache.set(index, stored);
  return stored;
}

/** Files that can be loaded together with `startFile`, including `startFile`. */
function rubyLoadComponent(index: ProjectIndex, startFile: string): ReadonlySet<string> {
  const start = fileIdentityKey(startFile);
  let byStart = rubyLoadComponentCache.get(index);
  if (!byStart) {
    byStart = new Map();
    rubyLoadComponentCache.set(index, byStart);
  }
  const cached = byStart.get(start);
  if (cached) return cached;
  const neighbors = rubyStarAdjacency(index);
  const seen = new Set<string>([start]);
  const pending = [start];
  while (pending.length) {
    const current = pending.pop()!;
    for (const next of neighbors.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  byStart.set(start, seen);
  return seen;
}

/**
 * The declaration Ruby runs first, starting at the use site.
 * A required file runs to completion before the next statement, so star imports
 * are walked before the file's own export of the same constant.
 */
function rubyLoadOrderDeclaration(
  index: ProjectIndex,
  startFile: string,
  exportedName: string,
  kind: SymbolDef["kind"],
): SymbolDef | null {
  const seen = new Set<string>();
  const walk = (file: string): SymbolDef | null => {
    const key = fileIdentityKey(file);
    if (seen.has(key)) return null;
    seen.add(key);
    const mod = index.byFile.get(key);
    if (!mod) return null;
    for (const imp of mod.imports) {
      if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
      const found = walk(imp.resolved);
      if (found) return found;
    }
    for (const entry of mod.exports) {
      if (entry.type !== "local" || entry.exportedAs !== exportedName || entry.target.kind !== kind) continue;
      return entry.target;
    }
    return null;
  };
  return walk(startFile);
}

/**
 * One Ruby constant, not one file.
 *
 * Candidates that share a qualified export path (`Base`, `Outer::Base`) are the
 * same constant. The use site already limited the list to its load closure, so a
 * third file that requires both is enough: neither declaration has to require the
 * other. `class` and `module` are not distinguished; mixing them is a Ruby
 * TypeError, and the declaration keyword is not read back from source.
 *
 * Go to definition lands on the part the use site loads first. Find references
 * includes every part in that load component.
 */
function sameReopenedRubyConstant(index: ProjectIndex, left: SymbolDef, right: SymbolDef): boolean {
  if (left.kind !== right.kind) return false;
  const leftName = exportedNameForDef(index, left);
  const rightName = exportedNameForDef(index, right);
  return !!leftName && leftName === rightName;
}

function sameStarIdentity(index: ProjectIndex, languageId: string, left: SymbolDef, right: SymbolDef): boolean {
  if (sameDef(left, right, index.languageExtensions)) return true;
  if (languageId !== "ruby") return false;
  return sameReopenedRubyConstant(index, left, right);
}

function compareSymbolDefs(left: SymbolDef, right: SymbolDef): number {
  const byFile = fileIdentityKey(left.file).localeCompare(fileIdentityKey(right.file));
  if (byFile !== 0) return byFile;
  const leftIndex = left.range.start.index ?? 0;
  const rightIndex = right.range.start.index ?? 0;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  if (left.range.start.line !== right.range.start.line) return left.range.start.line - right.range.start.line;
  return left.range.start.column - right.range.start.column;
}

function groupStarDefinitions(index: ProjectIndex, languageId: string, defs: readonly SymbolDef[]): SymbolDef[][] {
  const parent = defs.map((_, defIndex) => defIndex);
  const find = (start: number): number => {
    let current = start;
    while (parent[current] !== current) {
      const parentIndex = parent[current]!;
      parent[current] = parent[parentIndex] ?? parentIndex;
      current = parentIndex;
    }
    return current;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < defs.length; left += 1) {
    for (let right = left + 1; right < defs.length; right += 1) {
      if (sameStarIdentity(index, languageId, defs[left]!, defs[right]!)) unite(left, right);
    }
  }
  const groups = new Map<number, SymbolDef[]>();
  for (let defIndex = 0; defIndex < defs.length; defIndex += 1) {
    const root = find(defIndex);
    const group = groups.get(root);
    if (group) group.push(defs[defIndex]!);
    else groups.set(root, [defs[defIndex]!]);
  }
  return [...groups.values()];
}

/**
 * The part a Ruby use site loads first. Other languages, and a single declaration,
 * keep the definition the star import resolved.
 */
function representativeDefinition(
  index: ProjectIndex,
  languageId: string,
  group: readonly SymbolDef[],
  ordered: readonly SymbolDef[],
  useFile?: string,
): SymbolDef {
  if (languageId === "ruby" && group.length >= 2 && useFile) {
    const exported = exportedNameForDef(index, group[0]!);
    if (exported) {
      const first = rubyLoadOrderDeclaration(index, useFile, exported, group[0]!.kind);
      if (first && group.some((part) => sameDef(part, first, index.languageExtensions))) return first;
    }
  }
  for (const candidate of ordered) {
    const found = group.find((part) => sameDef(part, candidate, index.languageExtensions));
    if (found) return found;
  }
  return [...group].sort(compareSymbolDefs)[0]!;
}

export function decideStarImportCandidates(
  index: ProjectIndex,
  languageId: string,
  candidates: readonly StarImportCandidate[],
  useFile?: string,
): StarImportDecision {
  if (!candidates.length) return { status: "none" };
  const groups = groupStarDefinitions(
    index,
    languageId,
    candidates.map((candidate) => candidate.def),
  );
  if (groups.length !== 1) return { status: "ambiguous" };
  const group = groups[0]!;
  const definition = representativeDefinition(
    index,
    languageId,
    group,
    candidates.map((candidate) => candidate.def),
    useFile,
  );
  const match = candidates.find((candidate) => sameDef(candidate.def, definition, index.languageExtensions));
  if (!match) return { status: "ambiguous" };
  return { status: "resolved", imp: match.imp, definition };
}

export type RubyReopenedConstant = {
  /** Other declarations of this constant. The queried declaration is not included. */
  parts: SymbolDef[];
  /** Kept for callers. Source is not re-read, so the part list is not truncated that way. */
  incomplete: boolean;
};

/**
 * Other declarations of this qualified constant in the same load component.
 * A third file that requires both sides is enough; the two files need not require
 * each other. Files that are never loaded together stay apart.
 */
export function findRubyReopenedConstantParts(index: ProjectIndex, def: SymbolDef): RubyReopenedConstant {
  const empty: RubyReopenedConstant = { parts: [], incomplete: false };
  const languageId = supportForFileWithoutHeaderSample(def.file, index.languageExtensions)?.id;
  if (languageId !== "ruby") return empty;
  const exported = exportedNameForDef(index, def);
  if (!exported) return empty;
  const component = rubyLoadComponent(index, def.file);
  const parts: SymbolDef[] = [];
  for (const mod of index.byFile.values()) {
    if (!component.has(fileIdentityKey(mod.file))) continue;
    for (const entry of mod.exports) {
      if (entry.type !== "local" || entry.exportedAs !== exported || entry.target.kind !== def.kind) continue;
      if (sameDef(entry.target, def, index.languageExtensions)) continue;
      parts.push(entry.target);
    }
  }
  return { parts, incomplete: false };
}
