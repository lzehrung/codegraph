import { createRequire } from "node:module";
import type { PathLike } from "node:fs";
import type { DatabaseSync, StatementColumnMetadata, StatementResultingChanges, StatementSync } from "node:sqlite";
import { errorMessage } from "./util/errors.js";

export type SqliteValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqliteRow = Record<string, unknown>;
export type SqliteRawRow = unknown[];
export type SqliteRunResult = StatementResultingChanges;
export type SqliteColumn = StatementColumnMetadata;

type SqliteConstants = {
  SQLITE_DENY?: number;
  SQLITE_FUNCTION?: number;
  SQLITE_OK?: number;
  SQLITE_PRAGMA?: number;
  SQLITE_READ?: number;
  SQLITE_RECURSIVE?: number;
  SQLITE_SELECT?: number;
  SQLITE_TRANSACTION?: number;
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
let reportedReadonlyAuthorizerDegradation = false;

function reportReadonlyAuthorizerDegraded(): void {
  if (reportedReadonlyAuthorizerDegradation) return;
  reportedReadonlyAuthorizerDegradation = true;
  console.error(
    "[codegraph] node:sqlite read-only authorizer is unavailable or incomplete; relying on connection readOnly enforcement.",
  );
}
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
  const message = errorMessage(error);
  return /node:sqlite|No such built-in module:\s*node:sqlite|setReturnArrays is not a function|columns is not a function/i.test(
    message,
  );
}

let nodeSqliteUnsupportedError: Error | undefined;

/**
 * Record the first proof that this runtime cannot serve Codegraph's SQLite work.
 *
 * A Node build below the supported floor loads `node:sqlite` but omits statement APIs
 * Codegraph needs, so the failure appears while preparing statements rather than while
 * opening the database. Without this latch every later cache access reopened the database,
 * re-ran its pragmas, and threw again: a 500-file project paid that cost per file.
 */
export function markNodeSqliteUnavailable(error: unknown): void {
  if (nodeSqliteUnsupportedError) return;
  nodeSqliteUnsupportedError = error instanceof Error ? error : new Error(String(error));
}

/** The latched failure, when this runtime has already proven it cannot serve SQLite work. */
export function nodeSqliteUnavailableError(): Error | undefined {
  return nodeSqliteUnsupportedError ?? sqliteLoadError;
}

/** Test seam: forget the latched failure so a suite can exercise both runtimes. */
export function clearNodeSqliteUnavailableForTests(): void {
  nodeSqliteUnsupportedError = undefined;
  nodeSqliteUsable = undefined;
}

let nodeSqliteUsable: boolean | undefined;

function missingNodeSqliteStatementApi(statement: StatementSync): string | undefined {
  const candidate = statement as NodeSqliteStatement;
  if (typeof candidate.setReturnArrays !== "function") return "setReturnArrays is not a function";
  if (typeof candidate.columns !== "function") return "columns is not a function";
  return undefined;
}

/**
 * Whether this runtime's `node:sqlite` can serve Codegraph's statement use.
 *
 * Codegraph depends on the standard-library module, not a compiled driver, so support is a
 * property of the running Node build. Builds below the supported floor export `node:sqlite`
 * but omit `StatementSync` methods Codegraph needs. That only surfaces when a statement is
 * prepared, so this probes an in-memory database once and latches the result. Callers then skip
 * creating on-disk cache files that can never be used.
 */
export function isNodeSqliteUsable(): boolean {
  if (nodeSqliteUnavailableError()) {
    nodeSqliteUsable = false;
    return false;
  }
  if (nodeSqliteUsable !== undefined) return nodeSqliteUsable;
  try {
    const sqlite = loadNodeSqlite();
    const probe = new sqlite.DatabaseSync(":memory:");
    try {
      const statement = probe.prepare("SELECT 1");
      const missingApi = missingNodeSqliteStatementApi(statement);
      if (missingApi) throw new TypeError(missingApi);
      statement.setReturnArrays(false);
      statement.columns();
      nodeSqliteUsable = true;
    } finally {
      probe.close();
    }
  } catch (error) {
    markNodeSqliteUnavailable(error);
    nodeSqliteUsable = false;
  }
  return nodeSqliteUsable;
}

const READONLY_AUTHORIZER_CONSTANTS = [
  "SQLITE_DENY",
  "SQLITE_FUNCTION",
  "SQLITE_OK",
  "SQLITE_PRAGMA",
  "SQLITE_READ",
  "SQLITE_RECURSIVE",
  "SQLITE_SELECT",
  "SQLITE_TRANSACTION",
] as const;

export function canInstallReadonlyAuthorizer(constants: SqliteConstants): constants is Required<SqliteConstants> {
  return READONLY_AUTHORIZER_CONSTANTS.every((name) => typeof constants[name] === "number");
}

function isReadOnlyAllowedAction(actionCode: number, constants: Required<SqliteConstants>): boolean {
  return (
    actionCode === constants.SQLITE_FUNCTION ||
    actionCode === constants.SQLITE_PRAGMA ||
    actionCode === constants.SQLITE_READ ||
    actionCode === constants.SQLITE_SELECT ||
    actionCode === constants.SQLITE_TRANSACTION ||
    actionCode === constants.SQLITE_RECURSIVE
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
    if (!isNodeSqliteUsable()) {
      throw nodeSqliteUnavailableError() ?? new Error("node:sqlite is unavailable");
    }
    const sqlite = loadNodeSqlite();
    this.db = new sqlite.DatabaseSync(filePath, {
      readOnly: options?.readonly,
      timeout: options?.timeout ?? 5000,
    });
    if (options?.readonly) {
      const { constants } = sqlite;
      if (this.db.setAuthorizer && canInstallReadonlyAuthorizer(constants)) {
        this.db.setAuthorizer((actionCode) =>
          isReadOnlyAllowedAction(actionCode, constants) ? constants.SQLITE_OK : constants.SQLITE_DENY,
        );
      } else {
        reportReadonlyAuthorizerDegraded();
      }
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
    try {
      const statement = new SqliteStatement(this.db.prepare(sql) as NodeSqliteStatement);
      this.statements.set(sql, statement);
      return statement;
    } catch (error) {
      if (isNodeSqliteUnavailableError(error)) markNodeSqliteUnavailable(error);
      throw error;
    }
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
