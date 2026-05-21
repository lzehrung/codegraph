import path from "node:path";
import { queryGraphSqliteRaw } from "../sqlite.js";
import { normalizePath, resolveFilePathFromRoot } from "../util/paths.js";

export type SqlCommandContext = {
  getOpt: (name: string) => string | undefined;
  cwd: () => string;
  writeJSONLine: (value: unknown) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

export async function handleSqlCommand(context: SqlCommandContext): Promise<void> {
  const dbOpt = context.getOpt("--db") ?? context.getOpt("--sqlite");
  const queryText = context.getOpt("--query");
  if (!dbOpt || !queryText) {
    context.writeStderrLine('Usage: sql --db <sqlite path> --query "SELECT ..."');
    context.exit(1);
  }
  const dbPath = path.isAbsolute(dbOpt)
    ? normalizePath(dbOpt)
    : normalizePath(resolveFilePathFromRoot(context.cwd(), dbOpt));
  const result = await queryGraphSqliteRaw(dbPath, queryText);
  context.writeJSONLine(result);
}
