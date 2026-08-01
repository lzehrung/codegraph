import type { CompactEdgeTo, CompactFileProjection } from "../../src/cli/graph.js";
import type { Edge, EdgeTo } from "../../src/types.js";

// Re-exported under the payload-shaped name tests read from `graph --json`; kept as an
// alias of the real compact projection type (rather than a hand-rolled copy) so this helper
// can't silently drift from the CLI's actual output schema.
export type CompactFileGraphPayload = CompactFileProjection;

function resolveEdgeTo(to: CompactEdgeTo, nodes: string[]): EdgeTo {
  return to.type === "file" ? { type: "file", path: nodes[to.path]! } : to;
}

/**
 * Resolves the `graph --json` compact payload (numeric indices into `files[]`) back to
 * full path strings, mirroring what the old denormalized `{ nodes, edges }` shape looked like.
 */
export function decompactFileGraph(payload: CompactFileGraphPayload): {
  nodes: string[];
  edges: Edge[];
} {
  const nodes = payload.files;
  const edges: Edge[] = payload.fileEdges.map((edge) => ({
    ...edge,
    from: nodes[edge.from]!,
    to: resolveEdgeTo(edge.to, nodes),
  }));
  return { nodes, edges };
}
