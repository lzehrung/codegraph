import { parseWithJsLanguage } from "../jsFallback.js";
import { supportById } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { normalizePath } from "../util/paths.js";
import { classifySqlFile } from "./classifySqlFile.js";
import type { SqlFactKind, SqlFileRole, SqlStatementFact } from "./types.js";

type SqlFactDraft = {
  kind: SqlFactKind;
  objectName: string | null;
  relatedObjectName: string | null;
};

const DEFINE_TYPES = new Set(["create_table", "create_view", "create_materialized_view"]);
const ROUTINE_TYPES = new Set(["create_function", "create_trigger"]);
const DROP_TYPES = new Set(["drop_table", "drop_view", "drop_index", "drop_function"]);

function walk(node: SyntaxNodeLike, visit: (node: SyntaxNodeLike) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

function findFirstDescendant(node: SyntaxNodeLike, type: string): SyntaxNodeLike | null {
  let found: SyntaxNodeLike | null = null;
  walk(node, (candidate) => {
    if (found) return;
    if (candidate.type === type) found = candidate;
  });
  return found;
}

function directChildOfType(node: SyntaxNodeLike, type: string): SyntaxNodeLike | null {
  return node.namedChildren.find((child) => child.type === type) ?? null;
}

function normalizeObjectName(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const unquoted = trimmed.replace(/^[`"[]|[`"\]]$/g, "");
  return unquoted || null;
}

function firstObjectReference(node: SyntaxNodeLike): string | null {
  return normalizeObjectName(findFirstDescendant(node, "object_reference")?.text);
}

function firstIdentifier(node: SyntaxNodeLike): string | null {
  return normalizeObjectName(findFirstDescendant(node, "identifier")?.text);
}

function collectObjectReferences(node: SyntaxNodeLike): string[] {
  const refs: string[] = [];
  walk(node, (candidate) => {
    if (candidate.type !== "object_reference") return;
    const name = normalizeObjectName(candidate.text);
    if (name) refs.push(name);
  });
  return refs;
}

function collectRelationObjects(node: SyntaxNodeLike): string[] {
  const names: string[] = [];
  walk(node, (candidate) => {
    if (candidate.type !== "relation") return;
    const name = firstObjectReference(candidate);
    if (name) names.push(name);
  });
  return names;
}

function collectJoinObjects(node: SyntaxNodeLike): string[] {
  const names: string[] = [];
  walk(node, (candidate) => {
    if (candidate.type !== "join") return;
    const relation = directChildOfType(candidate, "relation");
    const name = relation ? firstObjectReference(relation) : null;
    if (name) names.push(name);
  });
  return names;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function statementPrimaryNode(statement: SyntaxNodeLike): SyntaxNodeLike | null {
  return statement.namedChildren.find((child) => child.type !== "comment") ?? null;
}

function createDefinitionFact(primary: SyntaxNodeLike): SqlFactDraft | null {
  if (primary.type === "create_index") {
    return {
      kind: "defines_index",
      objectName: firstIdentifier(primary),
      relatedObjectName: firstObjectReference(primary),
    };
  }
  if (ROUTINE_TYPES.has(primary.type)) {
    return {
      kind: "defines_routine",
      objectName: firstObjectReference(primary) ?? firstIdentifier(primary),
      relatedObjectName: null,
    };
  }
  if (DEFINE_TYPES.has(primary.type)) {
    return {
      kind: primary.type === "create_table" ? "defines_table" : "defines_view",
      objectName: firstObjectReference(primary),
      relatedObjectName: null,
    };
  }
  return null;
}

function extractCreateTableConstraintFacts(primary: SyntaxNodeLike, tableName: string | null): SqlFactDraft[] {
  if (primary.type !== "create_table" || !tableName) return [];
  const refs = unique(collectObjectReferences(primary).filter((name) => name !== tableName));
  return refs.map((relatedObjectName) => ({
    kind: "defines_constraint",
    objectName: tableName,
    relatedObjectName,
  }));
}

function extractReadFacts(primary: SyntaxNodeLike): SqlFactDraft[] {
  const fromNode = directChildOfType(primary, "from") ?? findFirstDescendant(primary, "from");
  if (!fromNode) return [];
  const relations = unique(collectRelationObjects(fromNode));
  const joins = new Set(collectJoinObjects(fromNode));
  const primaryRead = relations.find((name) => !joins.has(name)) ?? relations[0] ?? null;
  const facts: SqlFactDraft[] = [];
  if (primaryRead) {
    facts.push({
      kind: "reads_from",
      objectName: primaryRead,
      relatedObjectName: null,
    });
  }
  for (const joinName of unique(Array.from(joins))) {
    facts.push({
      kind: "joins",
      objectName: joinName,
      relatedObjectName: primaryRead,
    });
  }
  return facts;
}

function extractStatementFactDrafts(statement: SyntaxNodeLike): SqlFactDraft[] {
  const primary = statementPrimaryNode(statement);
  if (!primary) return [];

  const definitionFact = createDefinitionFact(primary);
  if (definitionFact) {
    const tableConstraints = extractCreateTableConstraintFacts(primary, definitionFact.objectName);
    const readFacts = primary.type === "create_view" || primary.type === "create_materialized_view" ? extractReadFacts(primary) : [];
    return [definitionFact, ...tableConstraints, ...readFacts];
  }
  if (primary.type === "alter_table") {
    return [{ kind: "alters_table", objectName: firstObjectReference(primary), relatedObjectName: null }];
  }
  if (DROP_TYPES.has(primary.type)) {
    return [{ kind: "drops_object", objectName: firstObjectReference(primary), relatedObjectName: null }];
  }
  if (primary.type === "insert" || primary.type === "update") {
    return [{ kind: "writes_to", objectName: firstObjectReference(primary), relatedObjectName: null }];
  }
  if (primary.type === "delete") {
    const fromNode = directChildOfType(statement, "from") ?? findFirstDescendant(statement, "from");
    return [{ kind: "writes_to", objectName: fromNode ? firstObjectReference(fromNode) : null, relatedObjectName: null }];
  }
  if (primary.type === "select" || primary.type === "create_query") {
    return extractReadFacts(statement);
  }
  return [];
}

function toFact(
  filePath: string,
  role: SqlFileRole,
  statement: SyntaxNodeLike,
  draft: SqlFactDraft,
  index: number,
): SqlStatementFact {
  const normalizedFile = normalizePath(filePath);
  const objectPart = draft.objectName ?? "statement";
  return {
    id: `${normalizedFile}:${statement.startPosition.row + 1}:${draft.kind}:${objectPart}:${index}`,
    filePath: normalizedFile,
    startLine: statement.startPosition.row + 1,
    endLine: statement.endPosition.row + 1,
    role,
    kind: draft.kind,
    objectName: draft.objectName,
    relatedObjectName: draft.relatedObjectName,
    statementText: statement.text.trim(),
    truthTier: "sql_statement_fact",
  };
}

export function extractSqlFactsFromSource(filePath: string, source: string): SqlStatementFact[] {
  const support = supportById("sql");
  if (!support) {
    throw new Error("SQL language support is not registered");
  }
  const role = classifySqlFile(filePath, source);
  const language = support.language(filePath);
  const tree = parseWithJsLanguage(source, language);
  const facts: SqlStatementFact[] = [];
  for (const statement of tree.rootNode.namedChildren.filter((child) => child.type === "statement")) {
    const drafts = extractStatementFactDrafts(statement);
    const resolvedDrafts =
      drafts.length > 0
        ? drafts
        : [{ kind: "unknown_statement", objectName: null, relatedObjectName: null } satisfies SqlFactDraft];
    for (const draft of resolvedDrafts) {
      facts.push(toFact(filePath, role, statement, draft, facts.length));
    }
  }
  return facts;
}
