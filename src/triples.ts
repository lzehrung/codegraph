import type { Graph } from "./types.js";
import type { SymbolGraph, SymbolNode, SymbolNodeKind } from "./graphs.js";

export type TripleNode =
  | {
      type: "file";
      id: string;
      path: string;
    }
  | {
      type: "external";
      id: string;
      name: string;
    }
  | {
      type: "symbol";
      id: string;
      name: string;
      kind: SymbolNodeKind;
      file: string;
      docstring?: string;
      lineSpan?: number;
      complexity?: number;
    };

export type Triple = {
  subject: TripleNode;
  predicate: string;
  object: TripleNode;
};

const symbolNodeToTripleNode = (node: SymbolNode): TripleNode => ({
  type: "symbol",
  id: node.id,
  name: node.name,
  kind: node.kind,
  file: node.file,
  docstring: node.docstring,
  lineSpan: node.lineSpan,
  complexity: node.complexity,
});

const fileNode = (path: string): TripleNode => ({
  type: "file",
  id: path,
  path,
});

const externalNode = (name: string): TripleNode => ({
  type: "external",
  id: `external:${name}`,
  name,
});

export function graphToTriples(
  fileGraph: Graph,
  symbolGraph: SymbolGraph,
): Triple[] {
  const triples: Triple[] = [];

  for (const edge of fileGraph.edges) {
    const subject = fileNode(edge.from);
    const object =
      edge.to.type === "file"
        ? fileNode(edge.to.path)
        : externalNode(edge.to.name);
    triples.push({
      subject,
      predicate: "imports",
      object,
    });
  }

  for (const edge of symbolGraph.edges) {
    const fromNode = symbolGraph.nodes.get(edge.from);
    const toNode = symbolGraph.nodes.get(edge.to);
    if (!fromNode || !toNode) continue;
    triples.push({
      subject: symbolNodeToTripleNode(fromNode),
      predicate: edge.label ?? "uses",
      object: symbolNodeToTripleNode(toNode),
    });
  }

  return triples;
}
