import path from "node:path";
import { queryGraphSqliteRaw } from "../sqlite.js";
import type { RawSqlResult } from "../sqlite/types.js";
import { normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import { writeCliOutput } from "./pretty.js";
import type {
  CliCwdContext,
  CliFlagContext,
  CliGetOptContext,
  CliJsonWriterContext,
  CliStderrExitContext,
  CliStdoutWriterContext,
} from "./context.js";

function formatSqlCell(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatSqlResult(result: RawSqlResult): string {
  const lines = [result.columns.join("\t")];
  if (!result.rows.length) lines.push("(no rows)");
  for (const row of result.rows) lines.push(row.map(formatSqlCell).join("\t"));
  if (result.truncated) lines.push(`[truncated after ${result.rows.length} rows]`);
  return lines.join("\n");
}

export type SqlCommandContext = CliFlagContext &
  CliGetOptContext &
  CliCwdContext &
  CliJsonWriterContext &
  CliStdoutWriterContext &
  CliStderrExitContext & {
    positionals: string[];
  };

export async function handleSqlCommand(context: SqlCommandContext): Promise<void> {
  const dbOpt = context.getOpt("--db") ?? context.getOpt("--sqlite") ?? context.positionals[0];
  const queryText = context.getOpt("--query") ?? context.positionals[1];
  if (!dbOpt || !queryText) {
    context.writeStderrLine('Usage: sql <sqlite-path> "SELECT ..." OR sql --db <sqlite-path> --query "SELECT ..."');
    context.exit(2);
  }
  const dbPath = path.isAbsolute(dbOpt)
    ? normalizePath(dbOpt)
    : normalizePath(resolveFilePathFromRoot(context.cwd(), dbOpt));
  const result = await queryGraphSqliteRaw(dbPath, queryText);
  writeCliOutput(context, result, formatSqlResult);
}
