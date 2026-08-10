import fsp from "node:fs/promises";
import type { SqlFactKind, SqlStatementFact, SqlTruthTier } from "./types.js";
import { extractSqlFactsFromSource } from "./extractFacts.js";

export type SqlArtifactNodeKind =
  | "sql_file"
  | "sql_statement"
  | "sql_object_candidate"
  | "sql_table_candidate"
  | "sql_view_candidate"
  | "sql_index_candidate"
  | "sql_constraint_candidate"
  | "sql_routine_candidate"
  | "sql_current_schema";

export type SqlArtifactEdgeKind =
  | "sql_contains_statement"
  | "sql_statement_defines"
  | "sql_statement_alters"
  | "sql_statement_drops"
  | "sql_statement_reads"
  | "sql_statement_writes"
  | "sql_statement_joins"
  | "sql_statement_references"
  | "sql_candidate_mentions";

export type SqlArtifactNode = {
  id: string;
  kind: SqlArtifactNodeKind;
  namespace: "sql";
  name?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  truthTier?: SqlTruthTier;
};

export type SqlArtifactEdge = {
  from: string;
  to: string;
  kind: SqlArtifactEdgeKind;
  namespace: "sql";
  provenance: {
    filePath: string;
    startLine: number;
    endLine: number;
    statementFactId: string;
  };
};

export type SqlArtifactGraph = {
  nodes: SqlArtifactNode[];
  edges: SqlArtifactEdge[];
  facts: SqlStatementFact[];
};

function statementNodeId(fact: SqlStatementFact): string {
  return `sql:statement:${fact.filePath}:${fact.startLine}-${fact.endLine}`;
}

function fileNodeId(filePath: string): string {
  return `sql:file:${filePath}`;
}

function candidateKindForFact(fact: SqlStatementFact): SqlArtifactNodeKind {
  if (fact.kind === "defines_table" || fact.kind === "alters_table") return "sql_table_candidate";
  if (fact.kind === "defines_view") return "sql_view_candidate";
  if (fact.kind === "defines_index") return "sql_index_candidate";
  if (fact.kind === "defines_constraint") return "sql_table_candidate";
  if (fact.kind === "defines_routine") return "sql_routine_candidate";
  return "sql_object_candidate";
}

function relatedCandidateKindForFact(fact: SqlStatementFact): SqlArtifactNodeKind {
  if (fact.kind === "defines_constraint" || fact.kind === "defines_index" || fact.kind === "joins") {
    return "sql_table_candidate";
  }
  return "sql_object_candidate";
}

function candidateNodeId(kind: SqlArtifactNodeKind, name: string): string {
  // Case-preserving: quoted identifiers (backtick/bracket/double-quote) are
  // case-sensitive on several dialects (MySQL on case-sensitive filesystems,
  // Postgres double-quoted, T-SQL with a case-sensitive collation), and
  // extractFacts already normalizes via normalizeSqlIdentifierPart, which
  // preserves case. Lowercasing here would silently merge distinct objects
  // that only differ by case (e.g. a backtick-quoted `MyTable` and an
  // unquoted mytable reference).
  return `sql:candidate:${kind}:${name}`;
}

function edgeKindForFact(kind: SqlFactKind): SqlArtifactEdgeKind {
  if (kind === "defines_table" || kind === "defines_view" || kind === "defines_index" || kind === "defines_routine") {
    return "sql_statement_defines";
  }
  if (kind === "defines_constraint" || kind === "references_object") return "sql_statement_references";
  if (kind === "alters_table" || kind === "renames_object") return "sql_statement_alters";
  if (kind === "drops_object") return "sql_statement_drops";
  if (kind === "reads_from") return "sql_statement_reads";
  if (kind === "writes_to") return "sql_statement_writes";
  if (kind === "joins") return "sql_statement_joins";
  return "sql_statement_references";
}

function relatedEdgeKindForFact(kind: SqlFactKind): SqlArtifactEdgeKind {
  if (kind === "joins") return "sql_statement_reads";
  if (kind === "renames_object") return "sql_statement_alters";
  return "sql_statement_references";
}

function provenance(fact: SqlStatementFact): SqlArtifactEdge["provenance"] {
  return {
    filePath: fact.filePath,
    startLine: fact.startLine,
    endLine: fact.endLine,
    statementFactId: fact.id,
  };
}

function addNode(nodes: Map<string, SqlArtifactNode>, node: SqlArtifactNode): void {
  if (nodes.has(node.id)) return;
  nodes.set(node.id, node);
}

function addCandidateMention(
  nodes: Map<string, SqlArtifactNode>,
  edges: SqlArtifactEdge[],
  statementId: string,
  fact: SqlStatementFact,
  name: string,
  candidateKind: SqlArtifactNodeKind,
  edgeKind: SqlArtifactEdgeKind,
): void {
  const candidateId = candidateNodeId(candidateKind, name);
  addNode(nodes, {
    id: candidateId,
    kind: candidateKind,
    namespace: "sql",
    name,
    truthTier: "sql_schema_candidate",
  });
  edges.push({
    from: statementId,
    to: candidateId,
    kind: edgeKind,
    namespace: "sql",
    provenance: provenance(fact),
  });
  edges.push({
    from: candidateId,
    to: statementId,
    kind: "sql_candidate_mentions",
    namespace: "sql",
    provenance: provenance(fact),
  });
}

function sortNodes(left: SqlArtifactNode, right: SqlArtifactNode): number {
  return left.id.localeCompare(right.id);
}

function sortEdges(left: SqlArtifactEdge, right: SqlArtifactEdge): number {
  const fromCompare = left.from.localeCompare(right.from);
  if (fromCompare !== 0) return fromCompare;
  const toCompare = left.to.localeCompare(right.to);
  if (toCompare !== 0) return toCompare;
  return left.kind.localeCompare(right.kind);
}

export function projectSqlFactsToGraph(facts: readonly SqlStatementFact[]): SqlArtifactGraph {
  const nodes = new Map<string, SqlArtifactNode>();
  const edges: SqlArtifactEdge[] = [];

  for (const fact of facts) {
    const fileId = fileNodeId(fact.filePath);
    const statementId = statementNodeId(fact);
    addNode(nodes, {
      id: fileId,
      kind: "sql_file",
      namespace: "sql",
      filePath: fact.filePath,
    });
    addNode(nodes, {
      id: statementId,
      kind: "sql_statement",
      namespace: "sql",
      filePath: fact.filePath,
      startLine: fact.startLine,
      endLine: fact.endLine,
      truthTier: "sql_statement_fact",
    });
    edges.push({
      from: fileId,
      to: statementId,
      kind: "sql_contains_statement",
      namespace: "sql",
      provenance: provenance(fact),
    });

    if (fact.objectName) {
      addCandidateMention(
        nodes,
        edges,
        statementId,
        fact,
        fact.objectName,
        candidateKindForFact(fact),
        edgeKindForFact(fact.kind),
      );
    }
    if (fact.relatedObjectName && fact.relatedObjectName.toLowerCase() !== fact.objectName?.toLowerCase()) {
      addCandidateMention(
        nodes,
        edges,
        statementId,
        fact,
        fact.relatedObjectName,
        relatedCandidateKindForFact(fact),
        relatedEdgeKindForFact(fact.kind),
      );
    }
  }

  return {
    nodes: Array.from(nodes.values()).sort(sortNodes),
    edges: edges.sort(sortEdges),
    facts: [...facts],
  };
}

export async function buildSqlArtifactGraphFromFiles(files: readonly string[]): Promise<SqlArtifactGraph> {
  const factGroups = await Promise.all(
    files.map(async (filePath) => extractSqlFactsFromSource(filePath, await fsp.readFile(filePath, "utf8"))),
  );
  return projectSqlFactsToGraph(factGroups.flat());
}
