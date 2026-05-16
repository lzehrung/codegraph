import { constants, DatabaseSync, type StatementColumnMetadata, type StatementResultingChanges } from "node:sqlite";
import type { PathLike } from "node:fs";

export type SqliteValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqliteRow = Record<string, unknown>;
export type SqliteRawRow = unknown[];
export type SqliteRunResult = StatementResultingChanges;
export type SqliteColumn = StatementColumnMetadata;

type SqliteParameterInput = SqliteValue | readonly SqliteValue[];

const isSqliteValueArray = (value: SqliteParameterInput): value is readonly SqliteValue[] => Array.isArray(value);

const readOnlyAllowedActions = new Set<number>([
  constants.SQLITE_FUNCTION,
  constants.SQLITE_PRAGMA,
  constants.SQLITE_READ,
  constants.SQLITE_SELECT,
  constants.SQLITE_TRANSACTION,
]);

const normalizeParams = (params: readonly SqliteParameterInput[]): SqliteValue[] => {
  if (params.length === 1) {
    const [only] = params;
    if (only !== undefined && isSqliteValueArray(only)) return [...only];
  }
  const normalized: SqliteValue[] = [];
  for (const param of params) {
    if (isSqliteValueArray(param)) {
      throw new Error("SQLite parameters must be passed as a single array or as positional values.");
    }
    normalized.push(param);
  }
  return normalized;
};

export class SqliteStatement {
  constructor(
    private readonly statement: ReturnType<DatabaseSync["prepare"]>,
    private readonly returnArrays = false,
  ) {
    this.statement.setReturnArrays(returnArrays);
  }

  raw(): SqliteStatement {
    return new SqliteStatement(this.statement, true);
  }

  all(...params: SqliteParameterInput[]): SqliteRow[] | SqliteRawRow[] {
    return this.statement.all(...normalizeParams(params)) as SqliteRow[] | SqliteRawRow[];
  }

  get(...params: SqliteParameterInput[]): SqliteRow | SqliteRawRow | undefined {
    return this.statement.get(...normalizeParams(params)) as SqliteRow | SqliteRawRow | undefined;
  }

  iterate(...params: SqliteParameterInput[]): Iterable<SqliteRow> | Iterable<SqliteRawRow> {
    return this.statement.iterate(...normalizeParams(params)) as Iterable<SqliteRow> | Iterable<SqliteRawRow>;
  }

  run(...params: SqliteParameterInput[]): SqliteRunResult {
    return this.statement.run(...normalizeParams(params));
  }

  columns(): SqliteColumn[] {
    return this.statement.columns();
  }
}

export class SqliteDatabase {
  private readonly db: DatabaseSync;

  constructor(filePath: PathLike, options?: { readonly?: boolean }) {
    this.db = new DatabaseSync(filePath, {
      readOnly: options?.readonly,
      timeout: 5000,
    });
    if (options?.readonly) {
      this.db.setAuthorizer((actionCode) =>
        readOnlyAllowedActions.has(actionCode) ? constants.SQLITE_OK : constants.SQLITE_DENY,
      );
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string): void {
    this.exec(`PRAGMA ${sql};`);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.exec("BEGIN;");
      try {
        const result = fn();
        this.exec("COMMIT;");
        return result;
      } catch (error) {
        this.exec("ROLLBACK;");
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

export function isReadOnlySqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not authorized") ||
    message.includes("read-only") ||
    message.includes("readonly") ||
    message.includes("attempt to write")
  );
}
