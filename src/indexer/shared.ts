import { GO_IDENTIFIER_SOURCE } from "../util/identifiers.js";

export { compareEdges, edgeKey, toRelativeEdge } from "../util/graphEdges.js";

export const DEFAULT_REF_CONTEXT_LINES = 5;

const GO_IMPORT_ALIAS_PATTERN = new RegExp(String.raw`^(\.|${GO_IDENTIFIER_SOURCE})\s+["'\u0060]`, "u");

export function parseGoImportAlias(stmtText: string): string | null {
  const trimmed = stmtText.trim();
  const importBody = trimmed.replace(/^import\s+/, "");
  const match = importBody.match(GO_IMPORT_ALIAS_PATTERN);
  return match?.[1] ?? null;
}
