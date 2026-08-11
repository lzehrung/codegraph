import { maskSqlStringsAndComments } from "../sql/lex.js";

export {
  DEFAULT_SQLITE_ROW_LIMIT,
  MAX_SQLITE_ROW_LIMIT,
  DEFAULT_SQLITE_BYTE_LIMIT,
  MAX_SQLITE_CELL_BYTES,
  SQLITE_TRUNCATED_MARKER,
  normalizeSqliteRowLimit,
  collectBoundedRawSqlRows,
  boundRawSqlResult,
  normalizeSqliteValue,
  type BoundRawSqlCollectOptions,
} from "../sqlite/rowBounds.js";

const DISALLOWED_MCP_SQLITE_FUNCTIONS = new Set([
  "format",
  "group_concat",
  "hex",
  "json_group_array",
  "json_group_object",
  "printf",
  "quote",
  "randomblob",
  "string_agg",
  "zeroblob",
]);

export function assertMcpSqliteQueryResourceBounded(sql: string): void {
  const searchableSql = maskSqlStringsAndComments(sql).toLowerCase();
  if (/\bwith\s+recursive\b/.test(searchableSql)) {
    throw new Error("MCP query_sqlite does not support recursive SQLite queries.");
  }
  const functionPattern = /\b([a-z_][a-z0-9_]*)\s*\(/gi;
  for (const match of searchableSql.matchAll(functionPattern)) {
    const functionName = match[1];
    if (functionName !== undefined && DISALLOWED_MCP_SQLITE_FUNCTIONS.has(functionName)) {
      throw new Error(`MCP query_sqlite rejected unsupported SQLite function ${functionName}.`);
    }
  }
  const quotedFunctionPattern = /(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\])\s*\(/g;
  for (const match of searchableSql.matchAll(quotedFunctionPattern)) {
    const functionName = (match[1] ?? match[2] ?? match[3] ?? "").replace(/""|``/g, (escaped) => escaped[0] ?? "");
    if (DISALLOWED_MCP_SQLITE_FUNCTIONS.has(functionName)) {
      throw new Error(`MCP query_sqlite rejected unsupported SQLite function ${functionName}.`);
    }
  }
}
