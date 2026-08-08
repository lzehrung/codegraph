import { serveCodegraphMcp, type CodegraphMcpWarmupMode } from "../mcp/server.js";
import { MCP_HELP_TEXT } from "./help.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";
import type { BuildOptions } from "../indexer/types.js";
import {
  exitWithError,
  type CliOptionContext,
  type CliPositionalsContext,
  type CliRootContext,
  type CliStderrExitContext,
} from "./context.js";

export type McpServeCommandContext = CliPositionalsContext &
  CliRootContext &
  CliOptionContext &
  CliStderrExitContext & {
    buildOptions?: BuildOptions;
  };

export async function handleMcpServeCommand(context: McpServeCommandContext): Promise<void> {
  const mcpCommand = context.positionals[0] ?? "serve";
  if (mcpCommand !== "serve") {
    context.writeStderrLine(MCP_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  const artifactPath = context.getOpt("--artifact");
  let port: number | undefined;
  let idleTimeoutMs: number | undefined;
  try {
    port = parseOptionalBoundedIntegerOption(context.getOpt("--port"), "--port", 0, 65535);
    idleTimeoutMs = parseOptionalBoundedIntegerOption(
      context.getOpt("--idle-timeout-ms"),
      "--idle-timeout-ms",
      0,
      24 * 60 * 60 * 1000,
    );
  } catch (error) {
    exitWithError(context, error, 2);
  }
  const host = context.getOpt("--host");
  const warmup = parseMcpWarmupMode(context);
  if (context.hasFlag("--stdio") && port !== undefined) {
    context.writeStderrLine("Choose either --stdio or --port for mcp serve transport.");
    context.exit(2);
  }
  if (host !== undefined && port === undefined) {
    context.writeStderrLine("--host requires --port for mcp serve HTTP transport.");
    context.exit(2);
  }
  if (idleTimeoutMs !== undefined && port !== undefined) {
    context.writeStderrLine("--idle-timeout-ms applies only to stdio MCP serve; omit --port or --idle-timeout-ms.");
    context.exit(2);
  }

  await serveCodegraphMcp({
    root: context.root,
    readOnly: !context.hasFlag("--allow-build"),
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(artifactPath !== undefined ? { artifactPath } : {}),
    ...(context.buildOptions !== undefined ? { buildOptions: context.buildOptions } : {}),
    ...(warmup !== undefined ? { warmup } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    onHttpListen: (info) => {
      context.writeStderrLine(`Codegraph MCP HTTP server listening at ${info.url}`);
    },
  });
}

function parseMcpWarmupMode(context: McpServeCommandContext): CodegraphMcpWarmupMode | undefined {
  if (context.hasFlag("--warmup") && context.hasFlag("--warmup-symbols")) {
    context.writeStderrLine("Choose either --warmup or --warmup-symbols for mcp serve startup.");
    context.exit(2);
  }
  if (context.hasFlag("--warmup-symbols")) return "symbols";
  if (context.hasFlag("--warmup")) return "base";
  return undefined;
}
