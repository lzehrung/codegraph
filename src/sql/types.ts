export type SqlFileRole =
  | "schema_snapshot"
  | "migration"
  | "seed"
  | "query"
  | "routine"
  | "fixture"
  | "dump"
  | "unknown";

export type SqlFactKind =
  | "defines_table"
  | "defines_view"
  | "defines_index"
  | "defines_constraint"
  | "alters_table"
  | "drops_object"
  | "renames_object"
  | "reads_from"
  | "writes_to"
  | "joins"
  | "references_object"
  | "defines_routine"
  | "unknown_statement";

export type SqlTruthTier = "sql_statement_fact" | "sql_schema_candidate";

export type SqlBridgeReason =
  | "changed_sql_file"
  | "changed_sql_literal"
  | "explicit_orm_mapping"
  | "same_pr_object_name";

export interface SqlStatementFact {
  readonly id: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly startIndex: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly endIndex: number;
  readonly role: SqlFileRole;
  readonly kind: SqlFactKind;
  readonly objectName: string | null;
  readonly relatedObjectName: string | null;
  readonly statementText: string;
  readonly truthTier: SqlTruthTier;
}
