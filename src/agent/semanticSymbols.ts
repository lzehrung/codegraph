import { defNodeId } from "../graphs/symbol-graph.js";
import { parseQualifiedSymbolPath, resolveSymbolTarget } from "../indexer/symbols.js";
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

function looksLikeLegacyDefNodeId(input: string): boolean {
  const parts = input.split("::");
  return parts.length === 3 && /^\d+(?:\D.*)?$/.test(parts[2] ?? "");
}

function formatSemanticCandidate(snapshot: AgentProjectSnapshot, candidate: ResolvedSemanticSymbol): string {
  return formatAgentSymbolHandle({
    file: normalizeAgentFilePath(snapshot.root, candidate.def.file),
    name: candidate.def.localName,
    line: candidate.def.range.start.line,
    column: candidate.def.range.start.column,
  });
}

/** Resolve a target that can be passed to semantic agent queries or return a clear target error. */
export function requireSemanticSymbol(snapshot: AgentProjectSnapshot, input: string): ResolvedSemanticSymbol {
  const portable = resolveSemanticSymbol(snapshot, input);
  if (portable) return portable;
  if (parseAgentSymbolHandle(input)) {
    throw new Error(
      'Symbol handle is stale or missing. Run codegraph symbols "<query>" or workspace_symbols to resolve it again.',
    );
  }

  const resolution = resolveSymbolTarget(snapshot.index, input);
  if (resolution.status === "exact") {
    return { id: resolution.target.handle, def: resolution.target.definition };
  }
  if (resolution.status === "ambiguous") {
    const choices = resolution.candidates
      .slice(0, 5)
      .map((candidate) => formatSemanticCandidate(snapshot, { id: candidate.handle, def: candidate.definition }));
    const omitted = resolution.candidates.length - choices.length;
    const suffix = omitted ? ` (and ${omitted} more)` : "";
    throw new Error(`Ambiguous symbol target "${input}". Use one of: ${choices.join(", ")}${suffix}`);
  }
  if (looksLikeLegacyDefNodeId(input)) {
    throw new Error(
      'Symbol handle is stale or missing. Run codegraph symbols "<query>" or workspace_symbols to resolve it again.',
    );
  }
  const qualifiedSymbol = parseQualifiedSymbolPath(input);
  if (qualifiedSymbol) {
    throw new Error(
      `Symbol path "${input}" was not found. Run codegraph symbols "${qualifiedSymbol.file}::${qualifiedSymbol.name}" to locate it.`,
    );
  }
  throw new Error(
    `Symbol target "${input}" was not found. Run codegraph search "<query>" or workspace_symbols to locate it.`,
  );
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
