import { fileIdentityKey } from "../../util/paths.js";
import { sameDef } from "../reference-context.js";
import { SymbolKind, type ProjectIndex, type SymbolDef } from "../types.js";
import type { ImportNameRules } from "../import-name-types.js";

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
      if (imp.kind !== "star" || imp.staticMembersOf || typeof imp.resolved !== "string") continue;
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
  if (left.kind !== SymbolKind.Class || right.kind !== SymbolKind.Class) return false;
  const leftName = exportedNameForDef(index, left);
  const rightName = exportedNameForDef(index, right);
  return !!leftName && leftName === rightName;
}

export const RUBY_IMPORT_NAME_RULES: ImportNameRules = {
  starExpansion: { excludeMembers: true, namespaceKinds: { [SymbolKind.Class]: true } },
  star: {
    localFallback: "exports-only",
    excludeMembers: true,
    sameIdentity: sameReopenedRubyConstant,
    representative(index, group, useFile) {
      const exported = exportedNameForDef(index, group[0]!);
      if (!exported) return undefined;
      const first = rubyLoadOrderDeclaration(index, useFile, exported, group[0]!.kind);
      return first && group.some((part) => sameDef(part, first, index.languageExtensions)) ? first : undefined;
    },
    reopenedParts(index, def, deps) {
      const empty = { parts: [], incomplete: false };
      const exported = exportedNameForDef(index, def);
      if (!exported) return empty;
      const component = rubyLoadComponent(index, def.file);
      const parts: SymbolDef[] = [];
      for (const { module, entry } of deps.localExportsNamed(index, exported)) {
        if (!component.has(fileIdentityKey(module.file))) continue;
        if (entry.target.kind !== def.kind || sameDef(entry.target, def, index.languageExtensions)) continue;
        parts.push(entry.target);
      }
      return { parts, incomplete: false };
    },
  },
};
