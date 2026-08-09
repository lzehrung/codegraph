import { defNodeId } from "../graphs/symbol-graph.js";
import { findLocalSymbolDefinitions, parseQualifiedSymbolPath } from "../indexer/symbols.js";
import type { SymbolDef } from "../indexer/types.js";
import { formatAgentSymbolHandle, parseAgentSymbolHandle } from "./handles.js";
import { normalizeAgentFilePath, resolveAgentSnapshotFile } from "./normalize.js";
import { parseSourceLocationInput } from "../util/sourceLocation.js";
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

/** Resolve a portable handle, exact symbol name, file, or file:line[:column] target. */
export function requireSemanticSymbol(snapshot: AgentProjectSnapshot, input: string): ResolvedSemanticSymbol {
  const portable = resolveSemanticSymbol(snapshot, input);
  if (portable) return portable;
  if (parseAgentSymbolHandle(input)) {
    throw new Error(
      'Symbol handle is stale or missing. Run codegraph symbols "<query>" or workspace_symbols to resolve it again.',
    );
  }

  const qualifiedSymbol = parseQualifiedSymbolPath(input);
  const location = parseSourceLocationInput(qualifiedSymbol?.file ?? input);
  const file = resolveAgentSnapshotFile(snapshot, location.file);
  const candidates: ResolvedSemanticSymbol[] = [];
  if (file) {
    const definitions = qualifiedSymbol
      ? findLocalSymbolDefinitions(snapshot.index, file, qualifiedSymbol.name)
      : (snapshot.index.byFile.get(file)?.locals ?? []);
    for (const def of definitions) {
      if (location.line !== undefined && def.range.start.line !== location.line) continue;
      if (location.column !== undefined && def.range.start.column !== location.column) continue;
      candidates.push({ id: defNodeId(def), def });
    }
  } else {
    const lookup = buildSymbolLookup(snapshot);
    const internal = lookup.defById.get(input);
    if (internal) return { id: input, def: internal };
    if (looksLikeLegacyDefNodeId(input)) {
      throw new Error(
        'Symbol handle is stale or missing. Run codegraph symbols "<query>" or workspace_symbols to resolve it again.',
      );
    }
    for (const [id, def] of lookup.defById) {
      if (def.localName !== input) continue;
      candidates.push({ id, def });
    }
  }

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    const choices = candidates.slice(0, 5).map((candidate) => formatSemanticCandidate(snapshot, candidate));
    const omitted = candidates.length - choices.length;
    const suffix = omitted ? ` (and ${omitted} more)` : "";
    throw new Error(`Ambiguous symbol target "${input}". Use one of: ${choices.join(", ")}${suffix}`);
  }
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
