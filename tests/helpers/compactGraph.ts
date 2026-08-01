export type CompactEdgeTo = { type: "file"; path: number } | { type: "external"; name: string };
export type CompactFileEdge = {
  from: number;
  to: CompactEdgeTo;
  raw: string;
  typeOnly?: boolean;
};
export type CompactFileGraphPayload = {
  files: string[];
  fileEdges: CompactFileEdge[];
};

export type DenormalizedEdgeTo = { type: "file"; path: string } | { type: "external"; name: string };
export type DenormalizedEdge = { from: string; to: DenormalizedEdgeTo; raw: string; typeOnly?: boolean };

/**
 * Resolves the `graph --json` compact payload (numeric indices into `files[]`) back to
 * full path strings, mirroring what the old denormalized `{ nodes, edges }` shape looked like.
 */
export function decompactFileGraph(payload: CompactFileGraphPayload): {
  nodes: string[];
  edges: DenormalizedEdge[];
} {
  const nodes = payload.files;
  const edges = payload.fileEdges.map((edge) => ({
    ...edge,
    from: nodes[edge.from]!,
    to:
      edge.to.type === "file"
        ? { type: "file" as const, path: nodes[edge.to.path]! }
        : { type: "external" as const, name: edge.to.name },
  }));
  return { nodes, edges };
}
