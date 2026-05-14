import path from "node:path";
import type { SqlFileRole } from "./types.js";

const MIGRATION_NAME_RE = /^(?:\d{3,}|\d{14}|v\d+__)[\w.-]*\.sql$/i;

function hasPathSegment(filePath: string, segments: readonly string[]): boolean {
  const parts = filePath
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  return parts.some((part) => segments.includes(part));
}

function countMatches(source: string, pattern: RegExp): number {
  return Array.from(source.matchAll(pattern)).length;
}

export function classifySqlFile(filePath: string, source: string): SqlFileRole {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(normalized);
  const createTables = countMatches(source, /\bcreate\s+table\b/gi);
  const ddlMigrationVerb = /\b(alter\s+table|create\s+index|drop\s+(?:table|column|index|view)|rename\s+to)\b/i;
  const dumpLike = /\b(copy\s+\w+\s+from|load\s+data|pg_dump|mysqldump)\b/i;
  const queryLike = /\b(select|with|update|delete|insert\s+into)\b/i;
  const schemaLike = new Set(["schema.sql", "structure.sql", "init.sql", "database.sql"]);
  const migrationLike =
    hasPathSegment(normalized, ["migration", "migrations"]) ||
    normalized.includes("/db/migrate/") ||
    normalized.includes("/schema/migrations/") ||
    normalized.includes("/database/migrations/") ||
    normalized.includes("/alembic/versions/") ||
    MIGRATION_NAME_RE.test(basename);

  if (schemaLike.has(basename) || (createTables >= 2 && !migrationLike)) return "schema_snapshot";
  if (hasPathSegment(normalized, ["dump", "dumps", "backup", "backups"]) || dumpLike.test(source)) return "dump";
  if (hasPathSegment(normalized, ["seed", "seeds"])) return "seed";
  if (hasPathSegment(normalized, ["fixture", "fixtures", "testdata"])) return "fixture";
  if (migrationLike || ddlMigrationVerb.test(source)) {
    return "migration";
  }
  if (hasPathSegment(normalized, ["routine", "routines", "functions", "procedures"])) return "routine";
  if (hasPathSegment(normalized, ["query", "queries", "reports", "analytics"]) || queryLike.test(source)) {
    return "query";
  }
  return "unknown";
}
