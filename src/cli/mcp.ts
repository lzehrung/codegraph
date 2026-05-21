import { serveCodegraphMcp } from "../mcp/server.js";
import { MCP_HELP_TEXT } from "./help.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";

export type McpServeCommandContext = {
  positionals: string[];
  root: string;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

export async function handleMcpServeCommand(context: McpServeCommandContext): Promise<void> {
  const mcpCommand = context.positionals[0];
  if (mcpCommand !== "serve") {
    context.writeStderrLine(MCP_HELP_TEXT.trimEnd());
    context.exit(2);
  }

  const artifactPath = context.getOpt("--artifact");
  let port: number | undefined;
  try {
    port = parseOptionalBoundedIntegerOption(context.getOpt("--port"), "--port", 0, 65535);
  } catch (error) {
    context.writeStderrLine(error instanceof Error ? error.message : String(error));
    context.exit(2);
  }
  const host = context.getOpt("--host");
  if (context.hasFlag("--stdio") && port !== undefined) {
    context.writeStderrLine("Choose either --stdio or --port for mcp serve transport.");
    context.exit(2);
  }
  if (host !== undefined && port === undefined) {
    context.writeStderrLine("--host requires --port for mcp serve HTTP transport.");
    context.exit(2);
  }

  await serveCodegraphMcp({
    root: context.root,
    readOnly: !context.hasFlag("--allow-build"),
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(artifactPath !== undefined ? { artifactPath } : {}),
    onHttpListen: (info) => {
      context.writeStderrLine(`Codegraph MCP HTTP server listening at ${info.url}`);
    },
  });
}
