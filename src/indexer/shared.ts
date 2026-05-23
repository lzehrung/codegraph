export { compareEdges, edgeKey, toRelativeEdge } from "../util/graphEdges.js";

export const DEFAULT_REF_CONTEXT_LINES = 5;

export const QUERY_DRIVEN_LOCALS_LANGUAGES = new Set([
  "python",
  "php",
  "java",
  "csharp",
  "rust",
  "kotlin",
  "swift",
  "zig",
  "cpp",
]);

export function parseGoImportAlias(stmtText: string): string | null {
  const trimmed = stmtText.trim();
  const importBody = trimmed.replace(/^import\s+/, "");
  const match = importBody.match(/^([._A-Za-z][\w]*)\s+["'`]/);
  return match?.[1] ?? null;
}
