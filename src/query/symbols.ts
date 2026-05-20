import type { SymbolGraph, SymbolNode, SymbolEdge } from "../graphs.js";
import type { SymbolQuery } from "./parser.js";

const includesFolded = (value: string | undefined, needle: string): boolean => {
  if (!value) return false;
  return value.toLowerCase().includes(needle.toLowerCase());
};

export function querySymbols(sg: SymbolGraph, query: SymbolQuery): SymbolNode[] {
  const textNeedle = query.text?.trim();
  return [...sg.nodes.values()].filter((node) => {
    if (query.kinds && !query.kinds.includes(node.kind)) return false;
    if (query.nameIncludes && !includesFolded(node.name, query.nameIncludes)) return false;
    if (query.fileIncludes && !includesFolded(node.file, query.fileIncludes)) return false;
    if (query.docstringIncludes && !includesFolded(node.docstring, query.docstringIncludes)) return false;
    if (textNeedle) {
      const haystack = [node.name, node.file, node.docstring].filter(Boolean).join(" ");
      if (!includesFolded(haystack, textNeedle)) return false;
    }
    return true;
  });
}

export type NeighborQuery = {
  symbolId: string;
  direction?: "out" | "in" | "both";
  maxDepth?: number;
  edgeLabels?: string[];
};

export type NeighborResult = {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
};

export function querySymbolNeighbors(sg: SymbolGraph, query: NeighborQuery): NeighborResult {
  const direction = query.direction ?? "both";
  const maxDepth = typeof query.maxDepth === "number" && query.maxDepth > 0 ? query.maxDepth : 1;
  const labelFilter = query.edgeLabels?.length ? new Set(query.edgeLabels) : null;

  const outgoing = new Map<string, SymbolEdge[]>();
  const incoming = new Map<string, SymbolEdge[]>();
  for (const edge of sg.edges) {
    if (labelFilter && edge.label && !labelFilter.has(edge.label)) continue;
    const outList = outgoing.get(edge.from) ?? [];
    outList.push(edge);
    outgoing.set(edge.from, outList);
    const inList = incoming.get(edge.to) ?? [];
    inList.push(edge);
    incoming.set(edge.to, inList);
  }

  const visited = new Set<string>();
  const frontier: Array<{ id: string; depth: number }> = [{ id: query.symbolId, depth: 0 }];
  visited.add(query.symbolId);

  const edgeSet = new Set<string>();
  let frontierIndex = 0;
  while (frontierIndex < frontier.length) {
    const current = frontier[frontierIndex++];
    if (!current || current.depth >= maxDepth) continue;
    const expandOut = direction === "out" || direction === "both";
    const expandIn = direction === "in" || direction === "both";
    if (expandOut) {
      for (const edge of outgoing.get(current.id) ?? []) {
        const key = `${edge.from}->${edge.to}::${edge.label ?? ""}`;
        edgeSet.add(key);
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          frontier.push({ id: edge.to, depth: current.depth + 1 });
        }
      }
    }
    if (expandIn) {
      for (const edge of incoming.get(current.id) ?? []) {
        const key = `${edge.from}->${edge.to}::${edge.label ?? ""}`;
        edgeSet.add(key);
        if (!visited.has(edge.from)) {
          visited.add(edge.from);
          frontier.push({ id: edge.from, depth: current.depth + 1 });
        }
      }
    }
  }

  const edges = sg.edges.filter((edge) => edgeSet.has(`${edge.from}->${edge.to}::${edge.label ?? ""}`));
  const nodes = [...visited].map((id) => sg.nodes.get(id)).filter((node): node is SymbolNode => !!node);
  return { nodes, edges };
}
