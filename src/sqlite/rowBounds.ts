import type { RawSqlResult } from "./types.js";

export const DEFAULT_SQLITE_ROW_LIMIT = 100;
export const MAX_SQLITE_ROW_LIMIT = 500;
export const DEFAULT_SQLITE_BYTE_LIMIT = 200_000;
export const MAX_SQLITE_CELL_BYTES = 8_000;
export const SQLITE_TRUNCATED_MARKER = "...[truncated]";

export function normalizeSqliteRowLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SQLITE_ROW_LIMIT;
  return Math.min(MAX_SQLITE_ROW_LIMIT, Math.max(0, Math.floor(limit)));
}

export type BoundRawSqlCollectOptions = {
  maxRows: number;
  maxBytes?: number | undefined;
  maxCellBytes?: number | undefined;
};

/**
 * Materialize rows from an already-open iterator while enforcing per-cell and
 * cumulative byte budgets *before* each append. Callers must not buffer raw rows
 * ahead of this helper.
 */
export function collectBoundedRawSqlRows(
  columns: string[],
  rowIterator: Iterable<Array<unknown>>,
  options: BoundRawSqlCollectOptions,
): RawSqlResult {
  const maxCellBytes = options.maxCellBytes ?? MAX_SQLITE_CELL_BYTES;
  const maxRows = Math.max(0, Math.floor(options.maxRows));
  const maxBytes = options.maxBytes;
  const rows: Array<Array<unknown>> = [];
  let bytes = Buffer.byteLength(JSON.stringify({ columns, rows: [] }), "utf8");
  let truncated = false;
  let sawExtraRow = false;

  for (const rawRow of rowIterator) {
    if (rows.length >= maxRows) {
      sawExtraRow = true;
      truncated = true;
      break;
    }

    let cellTruncated = false;
    const row = rawRow.map((value) => {
      const normalized = normalizeSqliteValue(value, maxCellBytes);
      if (normalized.truncated) cellTruncated = true;
      return normalized.value;
    });
    if (cellTruncated) truncated = true;

    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (maxBytes !== undefined && bytes + rowBytes > maxBytes) {
      truncated = true;
      break;
    }

    rows.push(row);
    bytes += rowBytes;
  }

  return {
    columns,
    rows,
    rowLimit: maxRows,
    ...(maxBytes !== undefined ? { byteLimit: maxBytes, bytes } : { bytes }),
    ...(truncated || sawExtraRow ? { truncated: true } : {}),
  };
}

export function boundRawSqlResult(result: RawSqlResult, byteLimit: number): RawSqlResult {
  const collected = collectBoundedRawSqlRows(result.columns, result.rows, {
    maxRows: result.rowLimit ?? result.rows.length,
    maxBytes: byteLimit,
  });
  return {
    ...result,
    ...collected,
    truncated: Boolean(result.truncated || collected.truncated),
  };
}

export function normalizeSqliteValue(
  value: unknown,
  maxCellBytes: number = MAX_SQLITE_CELL_BYTES,
): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    const truncated = Buffer.byteLength(value, "utf8") > maxCellBytes;
    return { value: truncateUtf8(value, maxCellBytes), truncated };
  }
  if (typeof value === "bigint") return { value: value.toString(), truncated: false };
  if (value instanceof Uint8Array) {
    return { value: `<${value.byteLength} bytes>`, truncated: true };
  }
  return { value, truncated: false };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = SQLITE_TRUNCATED_MARKER;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  let output = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > budget) break;
    output += char;
    bytes += charBytes;
  }
  return `${output}${marker}`;
}
