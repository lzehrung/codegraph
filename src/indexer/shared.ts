import type { SyntaxNodeLike } from "../languages/types.js";
import type { FileId, Range } from "../types.js";
import { GO_IDENTIFIER_SOURCE } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import type { SymbolDef } from "./types.js";

export {
  compareEdges,
  edgeFromImportBinding,
  edgeKey,
  toRelativeEdge,
  type EdgeImportSource,
} from "../util/graph-edges.js";

export const DEFAULT_REF_CONTEXT_LINES = 5;
export function toTreeSitterPosition(position: { line: number; column: number }): { row: number; column: number } {
  return { row: Math.max(0, position.line - 1), column: Math.max(0, position.column - 1) };
}

/** Identity of a source site: the file identity plus the start line and column of its range. */
export function siteKey(file: FileId, range: Range): string {
  return `${fileIdentityKey(file)}:${range.start.line}:${range.start.column}`;
}

/**
 * One bound for every receiver-hierarchy walk: keyword `super`/`parent` lookup, Go struct embedding, and Python base
 * classes. Each walk keeps its own visited set, so this is a resource bound rather than a cycle guard; keeping a single
 * constant stops the three walks from drifting to different semantic cutoffs.
 */
export const RECEIVER_HIERARCHY_DEPTH = 16;

/** The locals named `member` (through `normalizeIdentifier`) whose range lies within `node`. */
export function findLocalsWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  node: SyntaxNodeLike,
  normalizeIdentifier: (name: string) => string,
): SymbolDef[] {
  const containerStart = node.startIndex;
  const containerEnd = node.endIndex;
  const normalizedMember = normalizeIdentifier(member);
  return locals.filter((local) => {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    return (
      normalizeIdentifier(local.localName) === normalizedMember &&
      startIndex !== undefined &&
      endIndex !== undefined &&
      startIndex >= containerStart &&
      endIndex <= containerEnd
    );
  });
}

const GO_IMPORT_ALIAS_PATTERN = new RegExp(String.raw`^(\.|${GO_IDENTIFIER_SOURCE})\s+["'\u0060]`, "u");

export function parseGoImportAlias(stmtText: string): string | null {
  const trimmed = stmtText.trim();
  const importBody = trimmed.replace(/^import\s+/, "");
  const match = importBody.match(GO_IMPORT_ALIAS_PATTERN);
  return match?.[1] ?? null;
}
