import type { SymbolGraph, SymbolNode, SymbolEdge, SymbolNodeKind } from "./graphs.js";

export type SymbolQuery = {
  text?: string;
  nameIncludes?: string;
  fileIncludes?: string;
  docstringIncludes?: string;
  kinds?: SymbolNodeKind[];
};

export type GraphQuery =
  | { kind: "mostCalledMethods"; limit: number }
  | { kind: "dependencyChain"; className: string }
  | { kind: "controllersMostEndpoints"; limit: number }
  | { kind: "classesImplementing"; interfaceName: string }
  | { kind: "affectedFunctionsForModule"; modulePath: string }
  | { kind: "highestComplexityClasses"; limit: number }
  | { kind: "highestComplexityFunctions"; limit: number };

const tokenize = (input: string): string[] =>
  input.match(/[^\s"]+:"[^"]+"|"[^"]+"|\S+/g)?.map((token) => token.trim()) ?? [];

const normalizeToken = (token: string): string =>
  token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;

export function parseSymbolQuery(input: string): SymbolQuery {
  const query: SymbolQuery = {};
  const residual: string[] = [];
  for (const raw of tokenize(input)) {
    const token = normalizeToken(raw);
    const idx = token.indexOf(":");
    if (idx <= 0) {
      if (token) residual.push(token);
      continue;
    }
    const key = token.slice(0, idx).toLowerCase();
    let value = token.slice(idx + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (key === "kind" || key === "kinds") {
      const kinds = value
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean) as SymbolNodeKind[];
      if (kinds.length) query.kinds = kinds;
      continue;
    }
    if (key === "name") {
      query.nameIncludes = value;
      continue;
    }
    if (key === "file") {
      query.fileIncludes = value;
      continue;
    }
    if (key === "doc" || key === "docstring") {
      query.docstringIncludes = value;
      continue;
    }
    residual.push(token);
  }
  if (residual.length) query.text = residual.join(" ");
  return query;
}

const normalizePhrase = (value: string): string =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^the\s+/i, "");

const parseLimit = (input: string, fallback: number): number => {
  const match = /(?:top|most)\s+(\d+)/i.exec(input);
  if (!match) return fallback;
  const limit = Number(match[1]);
  return Number.isFinite(limit) && limit > 0 ? limit : fallback;
};

export function parseGraphQuery(input: string): GraphQuery | null {
  const text = input.trim();
  const lower = text.toLowerCase();

  if (lower.includes("most called methods")) {
    return { kind: "mostCalledMethods", limit: parseLimit(text, 10) };
  }
  if (lower.includes("dependency chain")) {
    const match = /dependency chain for (.+?) class/i.exec(text);
    if (!match) return null;
    return {
      kind: "dependencyChain",
      className: normalizePhrase(match[1] ?? ""),
    };
  }
  if (lower.includes("controllers have the most endpoints")) {
    return { kind: "controllersMostEndpoints", limit: parseLimit(text, 10) };
  }
  if (lower.includes("implement") && lower.includes("interface")) {
    const match = /implement(?:s)? (.+?) interface/i.exec(text);
    if (!match) return null;
    return {
      kind: "classesImplementing",
      interfaceName: normalizePhrase(match[1] ?? ""),
    };
  }
  if (lower.includes("affected") && lower.includes("module")) {
    const match =
      /change (?:this )?module\s+["']?([^"']+)["']?/i.exec(text) ?? /module\s+["']?([^"']+)["']?/i.exec(text);
    if (!match) return null;
    return {
      kind: "affectedFunctionsForModule",
      modulePath: normalizePhrase(match[1] ?? ""),
    };
  }
  if (lower.includes("highest complexity") && lower.includes("function")) {
    return { kind: "highestComplexityFunctions", limit: parseLimit(text, 10) };
  }
  if (lower.includes("highest complexity")) {
    return { kind: "highestComplexityClasses", limit: parseLimit(text, 10) };
  }
  return null;
}

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
