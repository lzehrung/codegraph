import type { CodegraphMcpWarmupMode } from "../mcp/server.js";
import { MAX_MCP_INDEX_WAIT_MS } from "../mcp/runtime-limits.js";
import { MCP_HELP_TEXT } from "./help.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";
import type { BuildOptions } from "../indexer/types.js";
import { assertMcpRootScope } from "../mcp/root-preflight.js";
import { serveWorkspaceMcp } from "../mcp/workspace.js";
import { serveSharedStdioMcp } from "../mcp/shared-stdio.js";
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
    projectBuildOptions?: (root: string) => Promise<BuildOptions>;
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
  let indexWaitMs: number | undefined;
  try {
    port = parseOptionalBoundedIntegerOption(context.getOpt("--port"), "--port", 0, 65535);
    idleTimeoutMs = parseOptionalBoundedIntegerOption(
      context.getOpt("--idle-timeout-ms"),
      "--idle-timeout-ms",
      0,
      24 * 60 * 60 * 1000,
    );
    indexWaitMs = parseOptionalBoundedIntegerOption(
      context.getOpt("--index-wait-ms"),
      "--index-wait-ms",
      0,
      MAX_MCP_INDEX_WAIT_MS,
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

  const workspace = context.getOpt("--workspace");
  if (workspace !== undefined && (port !== undefined || artifactPath !== undefined)) {
    context.writeStderrLine("--workspace uses stdio and selected repository owners; omit --port and --artifact.");
    context.exit(2);
  }
  if (workspace === undefined) {
    await assertMcpRootScope(context.root, { allowParentRoot: context.hasFlag("--allow-parent-root") });
  }
  const buildOptions =
    workspace === undefined && context.projectBuildOptions
      ? await context.projectBuildOptions(context.root)
      : context.buildOptions;
  const { onProgress: _onProgress, ...serializableBuildOptions } = buildOptions ?? {};
  const ownerOptions = {
    root: context.root,
    readOnly: !context.hasFlag("--allow-build"),
    ...(artifactPath !== undefined ? { artifactPath } : {}),
    ...(buildOptions !== undefined ? { buildOptions: serializableBuildOptions } : {}),
    warmup,
    ...(context.hasFlag("--no-watch") ? { watch: false } : {}),
    ...(indexWaitMs !== undefined ? { mcpIndexWaitMs: indexWaitMs } : {}),
  };
  if (workspace !== undefined) {
    await serveWorkspaceMcp({
      root: context.root,
      configPath: workspace,
      ownerOptions,
      ...(context.projectBuildOptions
        ? {
            projectBuildOptions: async (root: string) => {
              const { onProgress: _onProgress, ...selected } = await context.projectBuildOptions!(root);
              return selected;
            },
          }
        : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    });
    return;
  }
  if (port === undefined) {
    await serveSharedStdioMcp({
      ...ownerOptions,
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    });
    return;
  }
  // A stdio bridge must not load the private index/session implementation into each client process.
  const { serveCodegraphMcp } = await import("../mcp/server.js");
  await serveCodegraphMcp({
    ...ownerOptions,
    port,
    ...(host !== undefined ? { host } : {}),
    ...(buildOptions !== undefined ? { buildOptions } : {}),
    onHttpListen: (info) => {
      context.writeStderrLine(`Codegraph MCP HTTP server listening at ${info.url}`);
    },
  });
}

function parseMcpWarmupMode(context: McpServeCommandContext): CodegraphMcpWarmupMode {
  const explicit = [
    context.hasFlag("--warmup"),
    context.hasFlag("--warmup-symbols"),
    context.hasFlag("--no-warmup"),
  ].filter(Boolean).length;
  if (explicit > 1) {
    context.writeStderrLine("Choose only one of --warmup, --warmup-symbols, or --no-warmup for mcp serve startup.");
    context.exit(2);
  }
  if (context.hasFlag("--warmup-symbols")) return "symbols";
  if (context.hasFlag("--no-warmup")) return "off";
  return "base";
}
