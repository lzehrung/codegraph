import type { Edge } from "../types.js";
import { toProjectDisplayPath } from "./paths.js";

/**
 * Specifier fields that identify a file-dependency edge.
 * `from` is the specifier text stored as `raw` when `raw` is omitted.
 */
export type EdgeImportSource = {
  from: string;
  raw?: string;
  typeOnly?: boolean;
  includeForm?: Edge["includeForm"];
};

/**
 * Rebuilds a file-dependency edge from an {@link EdgeImportSource}.
 * Import bindings and deleted-file snapshots both use this so `raw`, type-only,
 * and C/C++ `includeForm` stay on the edge. Angle and quoted includes of one
 * header must not collapse.
 */
export function edgeFromImportBinding(from: string, to: Edge["to"], source: EdgeImportSource): Edge {
  const { includeForm } = source;
  return {
    from,
    to,
    raw: source.raw ?? source.from,
    ...(source.typeOnly ? { typeOnly: source.typeOnly } : {}),
    ...(includeForm ? { includeForm } : {}),
  };
}

function storedFilePath(file: string): string {
  return file;
}

/** Shared identity for collection, project assembly, delta, and drift comparison. */
export function edgeKey(edge: Edge, rawIsIdentity = true, filePath: (file: string) => string = storedFilePath): string {
  const from = filePath(edge.from);
  const target = edge.to.type === "file" ? filePath(edge.to.path) : edge.to.name;
  const raw = rawIsIdentity ? edge.raw : "";
  const typeOnly = edge.typeOnly ? "1" : "0";
  return `${from}\0${edge.to.type}\0${target}\0${raw}\0${typeOnly}\0${edge.includeForm ?? ""}`;
}

export function compareEdges(left: Edge, right: Edge): number {
  const fromCompare = left.from.localeCompare(right.from);
  if (fromCompare) return fromCompare;
  if (left.to.type !== right.to.type) {
    return left.to.type === "file" ? -1 : 1;
  }
  const leftTo = left.to.type === "file" ? left.to.path : left.to.name;
  const rightTo = right.to.type === "file" ? right.to.path : right.to.name;
  const toCompare = leftTo.localeCompare(rightTo);
  if (toCompare) return toCompare;
  const rawCompare = left.raw.localeCompare(right.raw);
  if (rawCompare) return rawCompare;
  const leftTypeOnly = left.typeOnly ? 1 : 0;
  const rightTypeOnly = right.typeOnly ? 1 : 0;
  const typeCompare = leftTypeOnly - rightTypeOnly;
  if (typeCompare) return typeCompare;
  return (left.includeForm ?? "").localeCompare(right.includeForm ?? "");
}

export function toRelativeEdge(projectRoot: string, edge: Edge): Edge {
  const from = toProjectDisplayPath(projectRoot, edge.from);
  let to = edge.to;
  if (edge.to.type === "file") {
    to = {
      type: "file",
      path: toProjectDisplayPath(projectRoot, edge.to.path),
    };
  }
  return {
    from,
    to,
    raw: edge.raw,
    ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
    ...(edge.includeForm ? { includeForm: edge.includeForm } : {}),
  };
}
