import { createRequire } from "node:module";
import type { PathLike } from "node:fs";
import type { DatabaseSync, StatementColumnMetadata, StatementResultingChanges, StatementSync } from "node:sqlite";

export type SqliteValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqliteRow = Record<string, unknown>;
export type SqliteRawRow = unknown[];
export type SqliteRunResult = StatementResultingChanges;
export type SqliteColumn = StatementColumnMetadata;

type SqliteConstants = {
  SQLITE_DENY: number;
  SQLITE_FUNCTION: number;
  SQLITE_OK: number;
  SQLITE_PRAGMA: number;
  SQLITE_READ: number;
  SQLITE_SELECT: number;
  SQLITE_TRANSACTION: number;
};
type SqliteDatabaseConstructor = new (
  filePath: PathLike,
  options?: { readOnly?: boolean | undefined; timeout?: number },
) => DatabaseSync;
type NodeSqliteModule = {
  DatabaseSync: SqliteDatabaseConstructor;
  constants: SqliteConstants;
};
type SqliteParameterInput = SqliteValue | readonly SqliteValue[];
type ReadonlyAuthorizerDatabase = DatabaseSync & {
  setAuthorizer?: (callback: (actionCode: number) => number) => void;
};
type NodeSqliteStatement = StatementSync & {
  columns: () => StatementColumnMetadata[];
  setReturnArrays: (enabled: boolean) => void;
};

const requireNodeModule = createRequire(import.meta.url);
let sqliteModule: NodeSqliteModule | undefined;
let sqliteLoadError: Error | undefined;

function loadNodeSqlite(): NodeSqliteModule {
  if (sqliteModule) return sqliteModule;
  if (sqliteLoadError) throw sqliteLoadError;
  try {
    const loaded = requireNodeModule("node:sqlite") as NodeSqliteModule;
    sqliteModule = loaded;
    return loaded;
  } catch (error) {
    sqliteLoadError = error instanceof Error ? error : new Error(String(error));
    throw sqliteLoadError;
  }
}

export function getNodeSqliteLoadError(): Error | undefined {
  if (sqliteModule) return undefined;
  try {
    loadNodeSqlite();
    return undefined;
  } catch {
    return sqliteLoadError;
  }
}

export function isNodeSqliteUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /node:sqlite|No such built-in module:\s*node:sqlite|setReturnArrays is not a function|columns is not a function/i.test(
    message,
  );
}

function isReadOnlyAllowedAction(actionCode: number, constants: SqliteConstants): boolean {
  return (
    actionCode === constants.SQLITE_FUNCTION ||
    actionCode === constants.SQLITE_PRAGMA ||
    actionCode === constants.SQLITE_READ ||
    actionCode === constants.SQLITE_SELECT ||
    actionCode === constants.SQLITE_TRANSACTION
  );
}

const isSqliteValueArray = (value: SqliteParameterInput): value is readonly SqliteValue[] => Array.isArray(value);

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
    private readonly statement: NodeSqliteStatement,
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
  private readonly db: ReadonlyAuthorizerDatabase;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(filePath: PathLike, options?: { readonly?: boolean; timeout?: number }) {
    const sqlite = loadNodeSqlite();
    this.db = new sqlite.DatabaseSync(filePath, {
      readOnly: options?.readonly,
      timeout: options?.timeout ?? 5000,
    });
    if (options?.readonly) {
      const { constants } = sqlite;
      this.db.setAuthorizer?.((actionCode) =>
        isReadOnlyAllowedAction(actionCode, constants) ? constants.SQLITE_OK : constants.SQLITE_DENY,
      );
    }
  }

  exec(sql: string): void {
    // DDL/schema changes invalidate prepared statements; drop the cache.
    this.statements.clear();
    this.db.exec(sql);
  }

  pragma(sql: string): void {
    this.exec(`PRAGMA ${sql};`);
  }

  prepare(sql: string): SqliteStatement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = new SqliteStatement(this.db.prepare(sql) as NodeSqliteStatement);
    this.statements.set(sql, statement);
    return statement;
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
    this.statements.clear();
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
