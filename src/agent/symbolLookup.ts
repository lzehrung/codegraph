import { defNodeId } from "../graphs/symbol-graph.js";
import type { SymbolDef } from "../indexer/types.js";
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
