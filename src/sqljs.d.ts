declare module "sql.js" {
  export type SqlJsConfig = {
    locateFile?: (file: string) => string;
  };

  export interface SqlJsStatement {
    run(params?: Array<string | number | null>): void;
    free(): void;
  }

  export interface SqlJsDatabase {
    run(sql: string, params?: Array<string | number | null>): void;
    exec(sql: string): Array<{ values: Array<Array<string | number | null>> }>;
    prepare(sql: string): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }

  export default function initSqlJs(
    config?: SqlJsConfig,
  ): Promise<SqlJsStatic>;
}
