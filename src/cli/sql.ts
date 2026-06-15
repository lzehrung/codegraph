import path from "node:path";
import { queryGraphSqliteRaw } from "../sqlite.js";
import { normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import type { CliCwdContext, CliGetOptContext, CliJsonWriterContext, CliStderrExitContext } from "./context.js";

export type SqlCommandContext = CliGetOptContext & CliCwdContext & CliJsonWriterContext & CliStderrExitContext;

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
