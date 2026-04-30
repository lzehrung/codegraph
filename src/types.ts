export type Pos = { line: number; column: number; index?: number };
export type Range = { start: Pos; end: Pos };
export type FileId = string;

export type EdgeTo = { type: "file"; path: FileId } | { type: "external"; name: string };

export type Edge = {
  from: FileId;
  to: EdgeTo;
  raw: string;
  typeOnly?: boolean;
  resolved?: "heuristic" | "precise";
  confidence?: number;
};

export type ProgressUpdate = {
  type: "progress";
  message: string;
  current: number;
  total: number;
};

export type Graph = { nodes: Set<FileId>; edges: Edge[] };
