import { defNodeId } from "../graphs/symbol-graph.js";
import type { SymbolDef } from "../indexer/types.js";
import { formatAgentSymbolHandle, parseAgentSymbolHandle } from "./handles.js";
import { normalizeAgentFilePath, resolveAgentSnapshotFile } from "./normalize.js";
import type { AgentProjectSnapshot } from "./session.js";
import type { SemanticSymbol } from "./semantic.js";
import { buildSymbolLookup } from "./symbolLookup.js";

export type ResolvedSemanticSymbol = {
  id: string;
  def: SymbolDef;
};

export function resolveSemanticSymbol(snapshot: AgentProjectSnapshot, handle: string): ResolvedSemanticSymbol | null {
  const lookup = buildSymbolLookup(snapshot);
  const parsed = parseAgentSymbolHandle(handle);
  if (!parsed) return null;
  const file = resolveAgentSnapshotFile(snapshot, parsed.file);
  if (!file) return null;
  for (const [id, def] of lookup.defById) {
    if (def.file.replace(/\\/g, "/") !== file) continue;
    if (def.localName !== parsed.name) continue;
    if (def.range.start.line !== parsed.line || def.range.start.column !== parsed.column) continue;
    return { id, def };
  }
  return null;
}

export function semanticSymbolFromDef(
  snapshot: AgentProjectSnapshot,
  def: SymbolDef,
  options?: { name?: string; qualifiedName?: string; exported?: boolean },
): SemanticSymbol {
  const file = normalizeAgentFilePath(snapshot.root, def.file);
  const name = options?.name ?? def.localName;
  const exported = options?.exported ?? isExported(snapshot, def);
  return {
    handle: formatAgentSymbolHandle({
      file,
      name: def.localName,
      line: def.range.start.line,
      column: def.range.start.column,
    }),
    name,
    localName: def.localName,
    ...(options?.qualifiedName ? { qualifiedName: options.qualifiedName } : {}),
    kind: def.kind,
    location: { file, range: def.range },
    exported,
    provenance: {
      capability: snapshot.analysis.mode === "reduced" ? "graph" : "semantic",
      backend: snapshot.analysis.backend,
      confidence: snapshot.analysis.mode === "reduced" ? "medium" : "high",
      ...(snapshot.analysis.mode === "reduced" ? { reason: snapshot.analysis.label } : {}),
    },
  };
}

function isExported(snapshot: AgentProjectSnapshot, def: SymbolDef): boolean {
  const id = defNodeId(def);
  const lookup = buildSymbolLookup(snapshot);
  return lookup.exportedIds.has(id);
}
