import { maskSqlStringsAndComments } from "../sql/lex.js";
import type { RawSqlResult } from "../sqlite.js";

export const DEFAULT_SQLITE_ROW_LIMIT = 100;
export const MAX_SQLITE_ROW_LIMIT = 500;
export const DEFAULT_SQLITE_BYTE_LIMIT = 200_000;
const MAX_SQLITE_CELL_BYTES = 8_000;

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

export function normalizeSqliteRowLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SQLITE_ROW_LIMIT;
  return Math.min(MAX_SQLITE_ROW_LIMIT, Math.max(0, Math.floor(limit)));
}

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

export function boundRawSqlResult(result: RawSqlResult, byteLimit: number): RawSqlResult {
  const rows: Array<Array<unknown>> = [];
  let bytes = Buffer.byteLength(JSON.stringify({ columns: result.columns, rows: [] }), "utf8");
  let truncated = result.truncated ?? false;

  for (const rawRow of result.rows) {
    if (rowContainsTruncatedValue(rawRow)) {
      truncated = true;
    }
    const row = rawRow.map(normalizeSqliteValue);
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (bytes + rowBytes > byteLimit) {
      truncated = true;
      break;
    }
    rows.push(row);
    bytes += rowBytes;
  }

  return {
    ...result,
    rows,
    byteLimit,
    bytes,
    truncated,
  };
}

function rowContainsTruncatedValue(row: Array<unknown>): boolean {
  return row.some(
    (value) =>
      (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_SQLITE_CELL_BYTES) ||
      value instanceof Uint8Array,
  );
}

function normalizeSqliteValue(value: unknown): unknown {
  if (typeof value === "string") return truncateUtf8(value, MAX_SQLITE_CELL_BYTES);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return `${output}...[truncated]`;
}
