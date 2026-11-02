import { defNodeId } from "../graphs/symbol-graph.js";
import type { SymbolDef } from "../indexer/types.js";
import { normalizePath } from "../util/paths.js";
import type { AgentProjectSnapshot } from "./session.js";

export type SymbolLookup = {
  defById: Map<string, SymbolDef>;
  exportedIds: Set<string>;
};
const SYMBOL_LOOKUP_CACHE = new WeakMap<AgentProjectSnapshot, SymbolLookup>();

/**
 * Build a lookup of every local symbol definition keyed by stable node id, plus the set of ids
 * that are exported. Shared by the agent explain and search entrypoints.
 */
export function buildSymbolLookup(snapshot: AgentProjectSnapshot): SymbolLookup {
  const cached = SYMBOL_LOOKUP_CACHE.get(snapshot);
  if (cached) return cached;

  const defById = new Map<string, SymbolDef>();
  const exportedIds = new Set<string>();

  for (const moduleIndex of snapshot.index.byFile.values()) {
    for (const local of moduleIndex.locals) {
      defById.set(defNodeId(local), local);
    }
    for (const exportEntry of moduleIndex.exports) {
      if (exportEntry.type === "local") exportedIds.add(defNodeId(exportEntry.target));
    }
  }

  const lookup = { defById, exportedIds };
  SYMBOL_LOOKUP_CACHE.set(snapshot, lookup);
  return lookup;
}

export type SymbolDefEntry = {
  id: string;
  def: SymbolDef;
};

const DEFS_BY_FILE = new WeakMap<SymbolLookup, Map<string, readonly SymbolDefEntry[]>>();
const NO_DEFS: readonly SymbolDefEntry[] = [];

/**
 * The definitions of one project file, by normalized path and in lookup order. A handle names its file, so resolving
 * one reads that file's definitions rather than every definition in the project. The buckets belong to the snapshot's
 * lookup, so they are rebuilt with the snapshot after an edit.
 */
export function symbolDefsInFile(snapshot: AgentProjectSnapshot, file: string): readonly SymbolDefEntry[] {
  const lookup = buildSymbolLookup(snapshot);
  let byFile = DEFS_BY_FILE.get(lookup);
  if (!byFile) {
    const grouped = new Map<string, SymbolDefEntry[]>();
    const normalizedFiles = new Map<string, string>();
    for (const [id, def] of lookup.defById) {
      let normalized = normalizedFiles.get(def.file);
      if (normalized === undefined) {
        normalized = normalizePath(def.file);
        normalizedFiles.set(def.file, normalized);
      }
      const entries = grouped.get(normalized);
      if (entries) entries.push({ id, def });
      else grouped.set(normalized, [{ id, def }]);
    }
    byFile = grouped;
    DEFS_BY_FILE.set(lookup, byFile);
  }
  return byFile.get(file) ?? NO_DEFS;
}
